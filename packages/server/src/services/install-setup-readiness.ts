import { resolve4 } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import {
	getConfiguredPublicIp,
	getManagedDnsZone,
	getManagementHostname,
} from "@nearzero/server/constants/domains";
import { getDefaultManagedNameservers } from "@nearzero/server/utils/dns/default-nameservers";
import { inspectDnsDelegation } from "./dns";
import { isPublicIpv4 } from "./domain-target";
import {
	getEffectiveManagedDnsSoaEmail,
	getInstallManagementIdentity,
	getPublicInstallSetupStatus,
	getSetupAdminEmail,
	type InstallSetupAccessCredential,
	type PublicInstallSetupStatus,
	verifyInstallSetupAccessCredential,
} from "./install-setup";

const READINESS_RATE_LIMIT = 12;
const READINESS_RATE_WINDOW_MS = 60_000;
const READINESS_RATE_BUCKET_LIMIT = 2_048;
const READINESS_PROBE_TIMEOUT_MS = 4_000;
const READINESS_TOTAL_TIMEOUT_MS = 10_000;
const MAX_SETUP_TOKEN_LENGTH = 256;
const MANAGEMENT_IDENTITY_PATH = "/api/install/bootstrap-status";
const MANAGEMENT_IDENTITY_MAX_BYTES = 16 * 1024;

type DnsDelegationInput = Parameters<typeof inspectDnsDelegation>[0];
type DnsDelegationResult = Awaited<ReturnType<typeof inspectDnsDelegation>>;

export type InstallSetupHttpsProbeResponse = {
	statusCode: number;
	contentType: string | null;
	body: string;
};

export type InstallSetupLockedFields = {
	managementHostname: boolean;
	adminEmail: boolean;
	publicIp: boolean;
	managedDnsZone: boolean;
	managedDnsSoaEmail: boolean;
	managedDnsEnabled: boolean;
};

export type InstallSetupReadinessState = {
	status: PublicInstallSetupStatus;
	adminEmail: string | null;
	managedDnsSoaEmail: string | null;
	lockedFields: InstallSetupLockedFields;
};

export type InstallSetupReadinessDependencies = {
	verifyCredential: (credential: InstallSetupAccessCredential) => boolean;
	loadState: () => Promise<InstallSetupReadinessState>;
	resolveManagementAddresses: (
		hostname: string,
		signal: AbortSignal,
	) => Promise<string[]>;
	probeManagementHttps: (
		input: { hostname: string; address: string; port: number },
		signal: AbortSignal,
	) => Promise<InstallSetupHttpsProbeResponse>;
	inspectDelegation: (
		zone: DnsDelegationInput,
		signal: AbortSignal,
	) => Promise<DnsDelegationResult>;
	consumeRateLimit: (key: string, now: number) => boolean;
	now: () => number;
	probeTimeoutMs: number;
	totalTimeoutMs: number;
};

type RateLimitBucket = { count: number; resetAt: number };
const readinessRateLimitBuckets = new Map<string, RateLimitBucket>();

class ReadinessTimeoutError extends Error {
	constructor(readonly label: string) {
		super(`${label} timed out`);
		this.name = "ReadinessTimeoutError";
	}
}

class ManagementHttpsRouteError extends Error {
	constructor() {
		super("The HTTPS route did not return the expected Nearzero identity");
		this.name = "ManagementHttpsRouteError";
	}
}

export class InstallSetupReadinessError extends Error {
	constructor(
		message: string,
		readonly code: "UNAUTHORIZED" | "FORBIDDEN" | "RATE_LIMITED" | "TIMEOUT",
	) {
		super(message);
		this.name = "InstallSetupReadinessError";
	}
}

function hasEnvironmentValue(
	env: Record<string, string | undefined>,
	key: string,
) {
	return Boolean(env[key]?.trim());
}

export function getInstallSetupLockedFields(
	env: Record<string, string | undefined> = process.env,
): InstallSetupLockedFields {
	return {
		managementHostname: hasEnvironmentValue(
			env,
			"NEARZERO_MANAGEMENT_HOSTNAME",
		),
		adminEmail: hasEnvironmentValue(env, "NEARZERO_ADMIN_EMAIL"),
		publicIp: hasEnvironmentValue(env, "NEARZERO_PUBLIC_IP"),
		managedDnsZone: hasEnvironmentValue(env, "NEARZERO_MANAGED_DNS_ZONE"),
		managedDnsSoaEmail: hasEnvironmentValue(
			env,
			"NEARZERO_MANAGED_DNS_SOA_EMAIL",
		),
		managedDnsEnabled: hasEnvironmentValue(env, "NEARZERO_ENABLE_MANAGED_DNS"),
	};
}

function consumeReadinessRateLimit(key: string, now: number) {
	if (readinessRateLimitBuckets.size >= READINESS_RATE_BUCKET_LIMIT) {
		for (const [bucketKey, bucket] of readinessRateLimitBuckets) {
			if (bucket.resetAt <= now) readinessRateLimitBuckets.delete(bucketKey);
		}
		if (readinessRateLimitBuckets.size >= READINESS_RATE_BUCKET_LIMIT) {
			const oldestKey = readinessRateLimitBuckets.keys().next().value;
			if (oldestKey) readinessRateLimitBuckets.delete(oldestKey);
		}
	}

	const current = readinessRateLimitBuckets.get(key);
	if (!current || current.resetAt <= now) {
		readinessRateLimitBuckets.set(key, {
			count: 1,
			resetAt: now + READINESS_RATE_WINDOW_MS,
		});
		return true;
	}
	if (current.count >= READINESS_RATE_LIMIT) return false;
	current.count += 1;
	return true;
}

/** Test helper. */
export function resetInstallSetupReadinessRateLimits() {
	readinessRateLimitBuckets.clear();
}

async function loadInstallSetupReadinessState(): Promise<InstallSetupReadinessState> {
	const status = await getPublicInstallSetupStatus();
	const [adminEmail, managedDnsSoaEmail] = await Promise.all([
		getSetupAdminEmail(),
		getEffectiveManagedDnsSoaEmail(),
	]);
	const lockedFields = getInstallSetupLockedFields();
	return {
		status: {
			...status,
			managementHostname: lockedFields.managementHostname
				? getManagementHostname()
				: status.managementHostname,
			publicIp: lockedFields.publicIp
				? getConfiguredPublicIp()
				: status.publicIp,
			managedDnsZone: lockedFields.managedDnsZone
				? getManagedDnsZone()
				: status.managedDnsZone,
		},
		adminEmail,
		managedDnsSoaEmail,
		lockedFields,
	};
}

function probeManagementHttps(
	input: { hostname: string; address: string; port: number },
	signal: AbortSignal,
) {
	return new Promise<InstallSetupHttpsProbeResponse>((resolve, reject) => {
		let settled = false;
		let responseBytes = 0;
		const chunks: Buffer[] = [];

		const finish = (
			error?: unknown,
			value?: InstallSetupHttpsProbeResponse,
		) => {
			if (settled) return;
			settled = true;
			if (error) reject(error);
			else if (value) resolve(value);
			else reject(new ManagementHttpsRouteError());
		};

		try {
			const req = request(
				{
					protocol: "https:",
					hostname: input.hostname,
					port: input.port,
					method: "GET",
					path: MANAGEMENT_IDENTITY_PATH,
					servername: input.hostname,
					rejectUnauthorized: true,
					agent: false,
					signal,
					headers: {
						accept: "application/json",
						host: input.hostname,
						"user-agent": "nearzero-install-readiness/1",
					},
					// Resolve exactly once to the installer-validated public IPv4. The
					// hostname still drives SNI, certificate validation, and Host routing.
					lookup: (_hostname, _options, callback) =>
						callback(null, input.address, 4),
				},
				(res) => {
					const contentTypeHeader = res.headers["content-type"];
					const contentType = Array.isArray(contentTypeHeader)
						? (contentTypeHeader[0] ?? null)
						: (contentTypeHeader ?? null);
					res.on("data", (chunk: Buffer | string) => {
						if (settled) return;
						const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
						responseBytes += bytes.length;
						if (responseBytes > MANAGEMENT_IDENTITY_MAX_BYTES) {
							finish(new ManagementHttpsRouteError());
							res.destroy();
							return;
						}
						chunks.push(bytes);
					});
					res.once("end", () => {
						finish(undefined, {
							statusCode: res.statusCode ?? 0,
							contentType,
							body: Buffer.concat(chunks).toString("utf8"),
						});
					});
					res.once("error", (error) => finish(error));
				},
			);
			req.once("error", (error) => finish(error));
			req.end();
		} catch (error) {
			finish(error);
		}
	});
}

const defaultDependencies: InstallSetupReadinessDependencies = {
	verifyCredential: verifyInstallSetupAccessCredential,
	loadState: loadInstallSetupReadinessState,
	resolveManagementAddresses: (hostname) => resolve4(hostname),
	probeManagementHttps,
	inspectDelegation: (zone) => inspectDnsDelegation(zone),
	consumeRateLimit: consumeReadinessRateLimit,
	now: Date.now,
	probeTimeoutMs: READINESS_PROBE_TIMEOUT_MS,
	totalTimeoutMs: READINESS_TOTAL_TIMEOUT_MS,
};

async function withTimeout<T>(
	operation: (signal: AbortSignal) => Promise<T>,
	timeoutMs: number,
	label: string,
): Promise<T> {
	const controller = new AbortController();
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation(controller.signal),
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => {
					const error = new ReadinessTimeoutError(label);
					controller.abort(error);
					reject(error);
				}, timeoutMs);
				timeout.unref?.();
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
		if (!controller.signal.aborted) controller.abort();
	}
}

function normalizedIpv4Addresses(values: string[]) {
	return Array.from(
		new Set(
			values.map((value) => value.trim()).filter((value) => isIP(value) === 4),
		),
	).sort();
}

function tlsFailureCode(error: unknown) {
	if (error instanceof ReadinessTimeoutError) return "HTTPS_TIMEOUT" as const;
	if (error instanceof ManagementHttpsRouteError) {
		return "HTTPS_ROUTE_NOT_NEARZERO" as const;
	}
	const code =
		error && typeof error === "object" && "code" in error
			? String((error as { code?: unknown }).code ?? "")
			: "";
	if (
		/^(CERT_|ERR_TLS_CERT_ALTNAME_INVALID|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT)/.test(
			code,
		)
	) {
		return "HTTPS_CERTIFICATE_INVALID" as const;
	}
	return "HTTPS_UNREACHABLE" as const;
}

function assertNearzeroManagementIdentity(
	response: InstallSetupHttpsProbeResponse,
	_hostname: string,
) {
	if (
		response.statusCode !== 200 ||
		!response.contentType?.toLowerCase().includes("application/json")
	) {
		throw new ManagementHttpsRouteError();
	}

	let value: unknown;
	try {
		value = JSON.parse(response.body);
	} catch {
		throw new ManagementHttpsRouteError();
	}
	if (!value || typeof value !== "object") {
		throw new ManagementHttpsRouteError();
	}
	const status = value as Record<string, unknown>;
	if (
		status.service !== "nearzero" ||
		status.community !== true ||
		status.managementIdentity !== getInstallManagementIdentity(_hostname) ||
		typeof status.setupAllowed !== "boolean" ||
		typeof status.setupPending !== "boolean" ||
		typeof status.bootstrapClaimed !== "boolean" ||
		!["setup", "register", "login"].includes(String(status.nextSurface))
	) {
		throw new ManagementHttpsRouteError();
	}
}

async function inspectManagementReadiness(
	status: PublicInstallSetupStatus,
	dependencies: InstallSetupReadinessDependencies,
) {
	const hostname = status.managementHostname;
	const expectedAddress = status.publicIp?.trim() || null;
	const expectedAddresses = expectedAddress ? [expectedAddress] : [];
	const incomplete = !hostname || !expectedAddress;
	const invalidAddress = Boolean(
		expectedAddress && !isPublicIpv4(expectedAddress),
	);

	if (incomplete || invalidAddress) {
		const diagnostic = invalidAddress
			? "The configured management address is not a public IPv4 address. Correct the installer configuration and retry."
			: "Save a management hostname and public IPv4 address before checking DNS.";
		return {
			hostname,
			expectedAddresses,
			observedAddresses: [] as string[],
			ready: false,
			aRecord: {
				status: "not_configured" as const,
				code: invalidAddress
					? ("CONFIGURATION_INVALID" as const)
					: ("CONFIGURATION_INCOMPLETE" as const),
				matches: false,
				diagnostic,
			},
			https: {
				status: "pending" as const,
				code: invalidAddress
					? ("CONFIGURATION_INVALID" as const)
					: ("WAITING_FOR_CONFIGURATION" as const),
				diagnostic,
			},
		};
	}

	let observedAddresses: string[] = [];
	let aLookupCompleted = false;
	let aRecordCode:
		| "A_RECORD_READY"
		| "A_RECORD_MISMATCH"
		| "A_LOOKUP_FAILED"
		| "A_LOOKUP_TIMEOUT" = "A_LOOKUP_FAILED";
	let aRecordDiagnostic =
		"Public DNS does not return the expected management A record yet.";

	try {
		observedAddresses = normalizedIpv4Addresses(
			await withTimeout(
				(signal) => dependencies.resolveManagementAddresses(hostname, signal),
				dependencies.probeTimeoutMs,
				"Management A-record lookup",
			),
		);
		aLookupCompleted = true;
	} catch (error) {
		aRecordCode =
			error instanceof ReadinessTimeoutError
				? "A_LOOKUP_TIMEOUT"
				: "A_LOOKUP_FAILED";
		aRecordDiagnostic =
			aRecordCode === "A_LOOKUP_TIMEOUT"
				? "The public A-record lookup timed out. Check DNS again shortly."
				: "The public A record could not be resolved yet. Confirm the A record exists, wait for propagation, and if you use Cloudflare set Proxy to DNS only (grey cloud), not Proxied.";
	}

	const containsExpected = observedAddresses.includes(expectedAddress);
	const aRecordMatches =
		containsExpected &&
		observedAddresses.length === expectedAddresses.length &&
		expectedAddresses.every((address) => observedAddresses.includes(address));
	if (aLookupCompleted) {
		if (aRecordMatches) {
			aRecordCode = "A_RECORD_READY";
			aRecordDiagnostic = `Public DNS sends ${hostname} to the configured Nearzero host.`;
		} else {
			aRecordCode = "A_RECORD_MISMATCH";
			aRecordDiagnostic =
				observedAddresses.length === 0
					? `Create an A record for ${hostname} pointing to ${expectedAddress}. If you use Cloudflare, set Proxy to DNS only (grey cloud), not Proxied.`
					: containsExpected
						? `Remove the other A records for ${hostname}; it should resolve only to ${expectedAddress}.`
						: `Set the A record for ${hostname} to ${expectedAddress} only. If you use Cloudflare, turn Proxy OFF (DNS only / grey cloud)—Proxied returns Cloudflare IPs instead of your server.`;
		}
	}

	let https:
		| {
				status: "pending";
				code: "WAITING_FOR_MANAGEMENT_A";
				diagnostic: string;
		  }
		| {
				status: "ready";
				code: "HTTPS_NEARZERO_READY";
				diagnostic: string;
		  }
		| {
				status: "failed";
				code:
					| "HTTPS_TIMEOUT"
					| "HTTPS_CERTIFICATE_INVALID"
					| "HTTPS_ROUTE_NOT_NEARZERO"
					| "HTTPS_UNREACHABLE";
				diagnostic: string;
		  };

	if (!containsExpected) {
		https = {
			status: "pending",
			code: "WAITING_FOR_MANAGEMENT_A",
			diagnostic:
				"HTTPS will be checked after public DNS includes the configured server address.",
		};
	} else {
		try {
			const response = await withTimeout(
				(signal) =>
					dependencies.probeManagementHttps(
						{ hostname, address: expectedAddress, port: 443 },
						signal,
					),
				dependencies.probeTimeoutMs,
				"Management HTTPS probe",
			);
			assertNearzeroManagementIdentity(response, hostname);
			https = {
				status: "ready",
				code: "HTTPS_NEARZERO_READY",
				diagnostic: `Nearzero is responding through its HTTPS route at ${hostname}.`,
			};
		} catch (error) {
			const code = tlsFailureCode(error);
			https = {
				status: "failed",
				code,
				diagnostic:
					code === "HTTPS_CERTIFICATE_INVALID"
						? `HTTPS reached the configured host, but its certificate is not valid for ${hostname} yet. Wait for certificate issuance and retry.`
						: code === "HTTPS_ROUTE_NOT_NEARZERO"
							? `HTTPS is active, but ${hostname} did not return this Nearzero installation. Confirm the Traefik management route and retry.`
							: code === "HTTPS_TIMEOUT"
								? "The direct HTTPS check timed out. Allow inbound TCP 443 and retry."
								: "HTTPS is not reachable at the configured address yet. Allow inbound TCP 443 and confirm Traefik is running.",
			};
		}
	}

	return {
		hostname,
		expectedAddresses,
		observedAddresses,
		ready: aRecordMatches && https.status === "ready",
		aRecord: {
			status: aRecordMatches ? ("ready" as const) : ("pending" as const),
			code: aRecordCode,
			matches: aRecordMatches,
			diagnostic: aRecordDiagnostic,
		},
		https,
	};
}

async function inspectManagedDnsReadiness(
	status: PublicInstallSetupStatus,
	dependencies: InstallSetupReadinessDependencies,
) {
	const zoneName = status.managedDnsZone;
	if (!status.managedDnsEnabled || status.managedDnsSkipped) {
		return {
			enabled: status.managedDnsEnabled,
			skipped: true,
			zoneName,
			status: "skipped" as const,
			code: "MANAGED_DNS_SKIPPED" as const,
			expectedNameservers: [] as string[],
			observedNameservers: [] as string[],
			delegated: false,
			authoritativeSoa: false,
			ready: true,
			diagnostics: [
				"Managed application DNS is skipped; configure application records with your external DNS provider.",
			],
		};
	}
	if (!zoneName) {
		return {
			enabled: true,
			skipped: false,
			zoneName: null,
			status: "not_configured" as const,
			code: "MANAGED_DNS_NOT_CONFIGURED" as const,
			expectedNameservers: [] as string[],
			observedNameservers: [] as string[],
			delegated: false,
			authoritativeSoa: false,
			ready: false,
			diagnostics: [
				"Choose an application DNS zone or explicitly use an external DNS provider.",
			],
		};
	}

	const configuredNameservers = getDefaultManagedNameservers(zoneName);
	let result: DnsDelegationResult | null = null;
	let timedOut = false;
	try {
		result = await withTimeout(
			(signal) =>
				dependencies.inspectDelegation(
					{
						name: zoneName,
						nameservers: configuredNameservers,
						status: "active",
						lastPublishedAt: new Date(dependencies.now()).toISOString(),
					},
					signal,
				),
			dependencies.probeTimeoutMs,
			"Managed DNS readiness probe",
		);
	} catch (error) {
		timedOut = error instanceof ReadinessTimeoutError;
	}

	const expectedNameservers =
		result?.expectedNameservers ?? configuredNameservers;
	const observedNameservers = result?.observedNameservers ?? [];
	const delegated = Boolean(result?.delegated);
	const authoritativeSoa = Boolean(result?.authoritative);
	const ready = delegated && authoritativeSoa;
	const diagnostics: string[] = [];
	if (timedOut) {
		diagnostics.push(
			"The managed DNS check timed out. Confirm UDP and TCP 53 are reachable, then retry.",
		);
	} else if (!result) {
		diagnostics.push(
			"Managed DNS could not be checked yet. Confirm the DNS service is running, then retry.",
		);
	}
	if (!delegated) {
		diagnostics.push(
			observedNameservers.length > 0
				? `Update the parent NS delegation for ${zoneName} to ${expectedNameservers.join(", ")}.`
				: `Delegate ${zoneName} at its parent DNS provider to ${expectedNameservers.join(", ")}.`,
		);
	}
	if (!authoritativeSoa) {
		diagnostics.push(
			`Allow inbound UDP and TCP 53 to ${status.publicIp ?? "this Nearzero host"} and confirm Nearzero DNS serves an authoritative SOA for ${zoneName}.`,
		);
	}

	return {
		enabled: true,
		skipped: false,
		zoneName,
		status: ready ? ("ready" as const) : ("pending" as const),
		code: ready
			? ("MANAGED_DNS_READY" as const)
			: timedOut
				? ("MANAGED_DNS_CHECK_TIMEOUT" as const)
				: !result
					? ("MANAGED_DNS_CHECK_FAILED" as const)
					: !delegated && !authoritativeSoa
						? ("MANAGED_DNS_DELEGATION_AND_SOA_PENDING" as const)
						: !delegated
							? ("MANAGED_DNS_DELEGATION_PENDING" as const)
							: ("MANAGED_DNS_SOA_PENDING" as const),
		expectedNameservers,
		observedNameservers,
		delegated,
		authoritativeSoa,
		ready,
		diagnostics,
	};
}

export async function getInstallSetupReadiness(
	input: {
		credential?: InstallSetupAccessCredential | null;
		token?: string;
		clientKey?: string;
	},
	dependencies: InstallSetupReadinessDependencies = defaultDependencies,
) {
	const clientKey = (input.clientKey?.trim() || "anonymous").slice(0, 256);
	const now = dependencies.now();
	if (!dependencies.consumeRateLimit(`install-readiness:${clientKey}`, now)) {
		throw new InstallSetupReadinessError(
			"Too many readiness checks. Try again in a minute.",
			"RATE_LIMITED",
		);
	}

	const credential =
		input.credential ??
		(typeof input.token === "string"
			? { kind: "token" as const, value: input.token.trim() }
			: null);
	if (
		!credential ||
		!credential.value ||
		(credential.kind === "token" &&
			credential.value.length > MAX_SETUP_TOKEN_LENGTH) ||
		!dependencies.verifyCredential(credential)
	) {
		throw new InstallSetupReadinessError(
			"Invalid or expired setup token",
			"UNAUTHORIZED",
		);
	}

	try {
		return await withTimeout(
			async () => {
				const state = await dependencies.loadState();
				if (!state.status.community) {
					throw new InstallSetupReadinessError(
						"Install readiness is only available on Community editions",
						"FORBIDDEN",
					);
				}
				if (state.status.bootstrapClaimed) {
					throw new InstallSetupReadinessError(
						"Install readiness is no longer available after the first owner exists",
						"FORBIDDEN",
					);
				}

				const [management, managedDns] = await Promise.all([
					inspectManagementReadiness(state.status, dependencies),
					inspectManagedDnsReadiness(state.status, dependencies),
				]);
				return {
					ready: management.ready && managedDns.ready,
					checkedAt: new Date(dependencies.now()).toISOString(),
					configuration: {
						managementHostname: state.status.managementHostname,
						adminEmail: state.adminEmail,
						publicIp: state.status.publicIp,
						managedDnsZone: state.status.managedDnsZone,
						managedDnsSoaEmail: state.managedDnsSoaEmail,
						managedDnsEnabled: state.status.managedDnsEnabled,
						lockedFields: state.lockedFields,
					},
					management,
					managedDns,
				};
			},
			dependencies.totalTimeoutMs,
			"Install readiness",
		);
	} catch (error) {
		if (error instanceof ReadinessTimeoutError) {
			throw new InstallSetupReadinessError(
				"Install readiness timed out. Try again shortly.",
				"TIMEOUT",
			);
		}
		throw error;
	}
}
