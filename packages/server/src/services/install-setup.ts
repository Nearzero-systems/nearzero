import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "@nearzero/server/db";
import {
	type ApiInstallSetupSubmit,
	apiInstallSetupSubmit,
	type InstallSetupPhase,
	installSetup,
	member,
} from "@nearzero/server/db/schema";
import {
	normalizeDnsHostname,
	normalizeDnsZoneName,
} from "@nearzero/server/utils/dns/zone-file";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
	getConfiguredPublicIp,
	getManagedDnsSoaEmail,
	getManagedDnsZone,
	getManagementHostname,
} from "../constants/domains";
import { isValidAuthEmail, normalizeAuthEmail } from "../lib/auth-email-policy";
import {
	persistRuntimePublicConfig,
	resolveRuntimePublicConfigPath,
} from "../lib/runtime-public-config";
import {
	createDefaultMiddlewares,
	createDefaultTraefikConfig,
} from "../setup/traefik-setup";
import {
	updateLetsEncryptEmail,
	updateServerTraefik,
} from "../utils/traefik/web-server";
import {
	isManagedDnsEnabledByInstaller,
	writeManagedDnsBootstrapZone,
} from "./dns-bootstrap-zone";
import { isPublicIpv4 } from "./domain-target";
import { isCommunityMode } from "./runtime-mode";
import { ensureTraefikSetup } from "./settings";
import {
	getWebServerSettings,
	updateWebServerSettings,
} from "./web-server-settings";

const emailSchema = z.string().trim().email();

type InstallSetupEnvironment = Record<string, string | undefined>;

export type ResolvedInstallSetupConfiguration = {
	managementHostname: string;
	adminEmail: string;
	publicIp: string;
	managedDnsZone: string | null;
	managedDnsSoaEmail: string | null;
	skipManagedDns: boolean;
};

export function deriveInstallSetupLifecycle(input: {
	community: boolean;
	bootstrapClaimed: boolean;
	setupTokenConfigured: boolean;
	rowPhase: InstallSetupPhase;
}) {
	const phase: InstallSetupPhase = input.bootstrapClaimed
		? "claimed"
		: input.rowPhase;
	const required =
		input.community &&
		!input.bootstrapClaimed &&
		input.setupTokenConfigured &&
		phase === "pending";
	return {
		phase,
		required,
		canSubmit: required,
	};
}

export type PublicInstallSetupStatus = {
	required: boolean;
	phase: InstallSetupPhase | "operational";
	community: boolean;
	bootstrapClaimed: boolean;
	setupTokenConfigured: boolean;
	managementConfigured: boolean;
	managementHostname: string | null;
	adminEmailConfigured: boolean;
	publicIp: string | null;
	managedDnsEnabled: boolean;
	managedDnsConfigured: boolean;
	managedDnsZone: string | null;
	managedDnsSkipped: boolean;
	canSubmit: boolean;
	resumeStep:
		| "welcome"
		| "management"
		| "zone"
		| "verify"
		| "done"
		| "register"
		| "login";
};

const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

function hashSetupToken(token: string) {
	return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateInstallSetupToken() {
	return randomBytes(32).toString("base64url");
}

export function hashInstallSetupToken(token: string) {
	return hashSetupToken(token);
}

export function getInstallSetupTokenHash(
	env: Record<string, string | undefined> = process.env,
) {
	const hash = env.NEARZERO_INSTALL_SETUP_TOKEN_HASH?.trim().toLowerCase();
	return hash && /^[a-f0-9]{64}$/.test(hash) ? hash : null;
}

export function verifyInstallSetupToken(
	token: string,
	env: Record<string, string | undefined> = process.env,
) {
	const expected = getInstallSetupTokenHash(env);
	if (!expected || !token) return false;
	const actual = hashSetupToken(token);
	try {
		return timingSafeEqual(
			Buffer.from(actual, "utf8"),
			Buffer.from(expected, "utf8"),
		);
	} catch {
		return false;
	}
}

function consumeRateLimit(key: string, limit = 20, windowMs = 60_000) {
	const now = Date.now();
	const current = rateLimitBuckets.get(key);
	if (!current || current.resetAt <= now) {
		rateLimitBuckets.set(key, { count: 1, resetAt: now + windowMs });
		return true;
	}
	if (current.count >= limit) return false;
	current.count += 1;
	return true;
}

/** Test helper */
export function resetInstallSetupRateLimits() {
	rateLimitBuckets.clear();
}

export async function getInstallSetupRow() {
	const existing = await db.query.installSetup.findFirst();
	if (existing) return existing;
	const [created] = await db.insert(installSetup).values({}).returning();
	return created!;
}

export async function hasOwnerMember() {
	const owner = await db.query.member.findFirst({
		where: eq(member.role, "owner"),
		columns: { id: true },
	});
	return Boolean(owner);
}

export async function getSetupAdminEmail(): Promise<string | null> {
	const envEmail = normalizeAuthEmail(process.env.NEARZERO_ADMIN_EMAIL ?? "");
	if (isValidAuthEmail(envEmail)) return envEmail;
	const row = await getInstallSetupRow();
	const dbEmail = normalizeAuthEmail(row.adminEmail ?? "");
	return isValidAuthEmail(dbEmail) ? dbEmail : null;
}

export async function getEffectiveManagedDnsZone(): Promise<string | null> {
	const fromEnv = getManagedDnsZone();
	if (fromEnv) return fromEnv;
	const row = await getInstallSetupRow();
	return row.managedDnsZone ? normalizeDnsZoneName(row.managedDnsZone) : null;
}

export async function getEffectiveManagedDnsSoaEmail(): Promise<string | null> {
	const fromEnv = getManagedDnsSoaEmail();
	if (fromEnv) return fromEnv;
	const row = await getInstallSetupRow();
	const candidate = row.managedDnsSoaEmail || row.adminEmail;
	return candidate ? emailSchema.parse(candidate) : null;
}

export function resolveInstallSetupResumeStep(input: {
	required: boolean;
	bootstrapClaimed: boolean;
	managementConfigured: boolean;
	phase: InstallSetupPhase;
}): PublicInstallSetupStatus["resumeStep"] {
	if (input.bootstrapClaimed || input.phase === "claimed") return "login";
	if (input.phase === "configured") return "register";
	if (!input.required) return "login";
	// A pending row remains retryable even if an earlier attempt already wrote
	// web-server settings before a later Traefik, DNS, or auth step failed.
	if (input.phase === "pending") {
		return input.managementConfigured ? "management" : "welcome";
	}
	return "login";
}

export async function getPublicInstallSetupStatus(): Promise<PublicInstallSetupStatus> {
	const community = isCommunityMode();
	const bootstrapClaimed = await hasOwnerMember();
	const settings = await getWebServerSettings();
	const row = await getInstallSetupRow();
	const envHost = getManagementHostname();
	const managementHostname =
		(settings?.host
			? normalizeDnsHostname(settings.host, { requireFqdn: true })
			: null) ||
		(row.managementHostname
			? normalizeDnsHostname(row.managementHostname, { requireFqdn: true })
			: null) ||
		envHost;
	const managedDnsEnabled = isManagedDnsEnabledByInstaller();
	const managedDnsZone = await getEffectiveManagedDnsZone();
	const adminEmailConfigured = Boolean(await getSetupAdminEmail());
	const managementConfigured = Boolean(managementHostname);
	const managedDnsConfigured = Boolean(managedDnsZone);
	const setupTokenConfigured = Boolean(getInstallSetupTokenHash());
	// Only the install_setup phase is a completion marker. Web settings are
	// written before Traefik, DNS, and auth runtime configuration, so treating a
	// hostname alone as completion can strand a failed install outside the wizard.
	const { phase, required, canSubmit } = deriveInstallSetupLifecycle({
		community,
		bootstrapClaimed,
		setupTokenConfigured,
		rowPhase: row.phase,
	});

	return {
		required,
		phase: bootstrapClaimed ? "operational" : phase,
		community,
		bootstrapClaimed,
		setupTokenConfigured,
		managementConfigured,
		managementHostname,
		adminEmailConfigured,
		publicIp:
			settings?.serverIp || row.publicIp || getConfiguredPublicIp() || null,
		managedDnsEnabled,
		managedDnsConfigured,
		managedDnsZone,
		managedDnsSkipped: row.managedDnsSkipped,
		canSubmit,
		resumeStep: resolveInstallSetupResumeStep({
			required:
				required || (community && !bootstrapClaimed && setupTokenConfigured),
			bootstrapClaimed,
			managementConfigured,
			phase,
		}),
	};
}

export class InstallSetupError extends Error {
	constructor(
		message: string,
		readonly code:
			| "FORBIDDEN"
			| "UNAUTHORIZED"
			| "BAD_REQUEST"
			| "RATE_LIMITED"
			| "CONFLICT" = "BAD_REQUEST",
	) {
		super(message);
		this.name = "InstallSetupError";
	}
}

function fixedEnvironmentValue(env: InstallSetupEnvironment, key: string) {
	const value = env[key]?.trim();
	return value || null;
}

function normalizeFixedHostname(value: string, variableName: string) {
	try {
		return normalizeDnsHostname(value, { requireFqdn: true });
	} catch {
		throw new InstallSetupError(
			`${variableName} contains an invalid public hostname`,
			"CONFLICT",
		);
	}
}

function normalizeFixedZone(value: string, variableName: string) {
	try {
		return normalizeDnsZoneName(value);
	} catch {
		throw new InstallSetupError(
			`${variableName} contains an invalid DNS zone`,
			"CONFLICT",
		);
	}
}

function normalizeFixedEmail(value: string, variableName: string) {
	const normalized = normalizeAuthEmail(value);
	if (!isValidAuthEmail(normalized)) {
		throw new InstallSetupError(
			`${variableName} contains an invalid email address`,
			"CONFLICT",
		);
	}
	return normalized;
}

function isLoopbackUrl(url: URL) {
	const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	return (
		hostname === "localhost" ||
		hostname.endsWith(".localhost") ||
		hostname === "::1" ||
		hostname === "0.0.0.0" ||
		hostname.startsWith("127.")
	);
}

function assertConfiguredOriginMatches(
	env: InstallSetupEnvironment,
	variableName: "CONSOLE_URL" | "BETTER_AUTH_URL",
	expectedOrigin: string,
) {
	const configured = fixedEnvironmentValue(env, variableName);
	if (!configured) return;

	let url: URL;
	try {
		url = new URL(configured);
	} catch {
		throw new InstallSetupError(
			`${variableName} is not a valid absolute URL`,
			"CONFLICT",
		);
	}
	if (isLoopbackUrl(url)) return;

	const isExactOrigin =
		url.protocol === "https:" &&
		!url.username &&
		!url.password &&
		url.origin === expectedOrigin &&
		(url.pathname === "/" || url.pathname === "") &&
		!url.search &&
		!url.hash;
	if (!isExactOrigin) {
		throw new InstallSetupError(
			`${variableName} is fixed as ${configured}; it must be ${expectedOrigin} for this management hostname`,
			"CONFLICT",
		);
	}
}

/**
 * Resolve the setup request against installer-owned values. This function is
 * intentionally side-effect free so every contradiction is rejected before
 * web settings, Traefik, DNS files, runtime auth configuration, or setup state
 * are changed.
 */
export function resolveInstallSetupConfiguration(
	parsed: ApiInstallSetupSubmit,
	options: {
		env?: InstallSetupEnvironment;
		persistedManagementHostname?: string | null;
		persistedPublicIp?: string | null;
		managedDnsEnabled?: boolean;
	} = {},
): ResolvedInstallSetupConfiguration {
	const env = options.env ?? process.env;
	const managementHostname = normalizeDnsHostname(parsed.managementHostname, {
		requireFqdn: true,
	});
	const adminEmail = normalizeAuthEmail(parsed.adminEmail);
	if (!isValidAuthEmail(adminEmail)) {
		throw new InstallSetupError("Enter a valid administrator email");
	}

	const fixedManagementHostnameRaw = fixedEnvironmentValue(
		env,
		"NEARZERO_MANAGEMENT_HOSTNAME",
	);
	if (fixedManagementHostnameRaw) {
		const fixedManagementHostname = normalizeFixedHostname(
			fixedManagementHostnameRaw,
			"NEARZERO_MANAGEMENT_HOSTNAME",
		);
		if (fixedManagementHostname !== managementHostname) {
			throw new InstallSetupError(
				`Management hostname is already fixed by the installer as ${fixedManagementHostname}`,
				"CONFLICT",
			);
		}
	}
	if (options.persistedManagementHostname?.trim()) {
		let persistedManagementHostname: string;
		try {
			persistedManagementHostname = normalizeDnsHostname(
				options.persistedManagementHostname,
				{ requireFqdn: true },
			);
		} catch {
			throw new InstallSetupError(
				"Persisted web settings contain an invalid management hostname",
				"CONFLICT",
			);
		}
		if (persistedManagementHostname !== managementHostname) {
			throw new InstallSetupError(
				`A pending setup attempt already selected ${persistedManagementHostname}; retry with that hostname`,
				"CONFLICT",
			);
		}
	}

	const fixedAdminEmailRaw = fixedEnvironmentValue(env, "NEARZERO_ADMIN_EMAIL");
	if (fixedAdminEmailRaw) {
		const fixedAdminEmail = normalizeFixedEmail(
			fixedAdminEmailRaw,
			"NEARZERO_ADMIN_EMAIL",
		);
		if (fixedAdminEmail !== adminEmail) {
			throw new InstallSetupError(
				`Administrator email is already fixed by the installer as ${fixedAdminEmail}`,
				"CONFLICT",
			);
		}
	}

	const expectedOrigin = `https://${managementHostname}`;
	assertConfiguredOriginMatches(env, "CONSOLE_URL", expectedOrigin);
	assertConfiguredOriginMatches(env, "BETTER_AUTH_URL", expectedOrigin);

	const fixedPublicIp = fixedEnvironmentValue(env, "NEARZERO_PUBLIC_IP");
	if (fixedPublicIp && !isPublicIpv4(fixedPublicIp)) {
		throw new InstallSetupError(
			"NEARZERO_PUBLIC_IP is fixed but is not a publicly routable IPv4 address",
			"CONFLICT",
		);
	}
	const requestedPublicIp = parsed.publicIp?.trim() || null;
	if (
		fixedPublicIp &&
		requestedPublicIp &&
		fixedPublicIp !== requestedPublicIp
	) {
		throw new InstallSetupError(
			`Public IP is already fixed by the installer as ${fixedPublicIp}`,
			"CONFLICT",
		);
	}
	const publicIp =
		fixedPublicIp ||
		requestedPublicIp ||
		options.persistedPublicIp?.trim() ||
		null;
	if (!publicIp || !isPublicIpv4(publicIp)) {
		throw new InstallSetupError(
			"A publicly routable IPv4 address is required before assigning a management hostname",
		);
	}

	const managedDnsEnabled =
		options.managedDnsEnabled ?? isManagedDnsEnabledByInstaller(env);
	const requestedSkipManagedDns = Boolean(parsed.skipManagedDns);
	const requestedManagedDnsZone = parsed.managedDnsZone?.trim()
		? normalizeDnsZoneName(parsed.managedDnsZone)
		: null;
	const fixedManagedDnsZoneRaw = fixedEnvironmentValue(
		env,
		"NEARZERO_MANAGED_DNS_ZONE",
	);
	const fixedManagedDnsZone = fixedManagedDnsZoneRaw
		? normalizeFixedZone(fixedManagedDnsZoneRaw, "NEARZERO_MANAGED_DNS_ZONE")
		: null;

	if (fixedManagedDnsZone && (!managedDnsEnabled || requestedSkipManagedDns)) {
		throw new InstallSetupError(
			`Managed DNS zone is fixed by the installer as ${fixedManagedDnsZone} and cannot be skipped`,
			"CONFLICT",
		);
	}
	if (
		fixedManagedDnsZone &&
		requestedManagedDnsZone &&
		fixedManagedDnsZone !== requestedManagedDnsZone
	) {
		throw new InstallSetupError(
			`Managed DNS zone is already fixed by the installer as ${fixedManagedDnsZone}`,
			"CONFLICT",
		);
	}
	if (!managedDnsEnabled && requestedManagedDnsZone) {
		throw new InstallSetupError(
			"Managed DNS is disabled by the installer, so a managed zone cannot be configured",
			"CONFLICT",
		);
	}

	const managedDnsZone =
		fixedManagedDnsZone ||
		(managedDnsEnabled && !requestedSkipManagedDns
			? requestedManagedDnsZone
			: null);
	const fixedSoaEmailRaw = fixedEnvironmentValue(
		env,
		"NEARZERO_MANAGED_DNS_SOA_EMAIL",
	);
	const fixedSoaEmail = fixedSoaEmailRaw
		? normalizeFixedEmail(fixedSoaEmailRaw, "NEARZERO_MANAGED_DNS_SOA_EMAIL")
		: null;
	const requestedSoaEmail = parsed.managedDnsSoaEmail?.trim()
		? normalizeAuthEmail(parsed.managedDnsSoaEmail)
		: null;
	if (requestedSoaEmail && !isValidAuthEmail(requestedSoaEmail)) {
		throw new InstallSetupError("Enter a valid managed DNS SOA email");
	}
	if (
		fixedSoaEmail &&
		requestedSoaEmail &&
		fixedSoaEmail !== requestedSoaEmail
	) {
		throw new InstallSetupError(
			`Managed DNS SOA email is already fixed by the installer as ${fixedSoaEmail}`,
			"CONFLICT",
		);
	}
	const managedDnsSoaEmail = managedDnsZone
		? fixedSoaEmail || requestedSoaEmail || adminEmail
		: null;

	return {
		managementHostname,
		adminEmail,
		publicIp,
		managedDnsZone,
		managedDnsSoaEmail,
		skipManagedDns: !managedDnsZone,
	};
}

export async function assertInstallSetupMutable() {
	if (!isCommunityMode()) {
		throw new InstallSetupError(
			"Install setup is only available on Community editions",
			"FORBIDDEN",
		);
	}
	if (await hasOwnerMember()) {
		throw new InstallSetupError(
			"Install setup is no longer available after the first owner exists",
			"FORBIDDEN",
		);
	}
	const row = await getInstallSetupRow();
	if (row.phase === "configured" || row.phase === "claimed") {
		throw new InstallSetupError(
			"Install setup has already been completed",
			"CONFLICT",
		);
	}
	if (!getInstallSetupTokenHash()) {
		throw new InstallSetupError(
			"Install setup token is not configured on this installation",
			"FORBIDDEN",
		);
	}
	return row;
}

let installSetupSubmissionTail: Promise<void> = Promise.resolve();

/** Serialize setup application within a platform process. */
export async function runInstallSetupSubmissionExclusive<T>(
	action: () => Promise<T>,
): Promise<T> {
	const previous = installSetupSubmissionTail;
	let release!: () => void;
	installSetupSubmissionTail = new Promise<void>((resolve) => {
		release = resolve;
	});
	await previous;
	try {
		return await action();
	} finally {
		release();
	}
}

export async function submitInstallSetup(
	rawInput: unknown,
	options: { clientKey?: string } = {},
) {
	const clientKey = options.clientKey ?? "anonymous";
	if (!consumeRateLimit(`setup:${clientKey}`, 12, 60_000)) {
		throw new InstallSetupError(
			"Too many setup attempts. Try again in a minute.",
			"RATE_LIMITED",
		);
	}

	return runInstallSetupSubmissionExclusive(async () => {
		const parsed = apiInstallSetupSubmit.parse(rawInput);
		if (!verifyInstallSetupToken(parsed.token)) {
			throw new InstallSetupError(
				"Invalid or expired setup token",
				"UNAUTHORIZED",
			);
		}

		// Unlike getWebServerSettings(), this read does not create a default row.
		// All installer/request contradictions therefore remain checked before the
		// first persistent write made by this setup attempt.
		const existingSettings = await db.query.webServerSettings.findFirst({
			orderBy: (settings, { asc }) => [asc(settings.createdAt)],
		});
		const configuration = resolveInstallSetupConfiguration(parsed, {
			persistedManagementHostname: existingSettings?.host,
			persistedPublicIp: existingSettings?.serverIp,
		});
		const row = await assertInstallSetupMutable();
		const now = new Date();

		// Persist retry intent while leaving phase=pending. If any following
		// filesystem/runtime operation fails, public status continues to expose the
		// wizard and a token-authorized retry can safely re-apply the same values.
		const [pending] = await db
			.update(installSetup)
			.set({
				adminEmail: configuration.adminEmail,
				managementHostname: configuration.managementHostname,
				publicIp: configuration.publicIp,
				managedDnsZone: configuration.managedDnsZone,
				managedDnsSoaEmail: configuration.managedDnsSoaEmail,
				managedDnsSkipped: configuration.skipManagedDns,
				configuredAt: null,
				updatedAt: now,
			})
			.where(
				and(eq(installSetup.id, row.id), eq(installSetup.phase, "pending")),
			)
			.returning({ id: installSetup.id });
		if (!pending) {
			throw new InstallSetupError(
				"Install setup changed while this request was being processed",
				"CONFLICT",
			);
		}

		const settings = await updateWebServerSettings({
			host: configuration.managementHostname,
			https: true,
			certificateType: "letsencrypt",
			letsEncryptEmail: configuration.adminEmail,
			serverIp: configuration.publicIp,
		});
		if (!settings) {
			throw new InstallSetupError(
				"Failed to persist management domain settings",
			);
		}

		try {
			createDefaultTraefikConfig();
			createDefaultMiddlewares();
			updateServerTraefik(settings, configuration.managementHostname);
			updateLetsEncryptEmail(configuration.adminEmail);
		} catch (error) {
			console.error("Install setup Traefik apply failed:", error);
			throw new InstallSetupError(
				error instanceof Error
					? error.message
					: "Failed to apply Traefik management routing",
			);
		}

		try {
			await ensureTraefikSetup();
		} catch (error) {
			if (process.env.NODE_ENV === "production") {
				console.error("Install setup Traefik runtime failed:", error);
				throw new InstallSetupError(
					error instanceof Error
						? error.message
						: "Failed to start Traefik management routing",
				);
			}
			console.warn(
				"Install setup wrote Traefik files; local runtime start skipped:",
				error,
			);
		}

		if (configuration.managedDnsZone && configuration.managedDnsSoaEmail) {
			writeManagedDnsBootstrapZone({
				zoneName: configuration.managedDnsZone,
				publicIp: configuration.publicIp,
				soaEmail: configuration.managedDnsSoaEmail,
				managementHostname: configuration.managementHostname,
			});
		}

		// Browser-led installs begin on a loopback URL. Persist the selected HTTPS
		// origin in the Nearzero data volume and reload Better Auth before the setup
		// endpoint reports success, so cookies, callbacks, invitations, and the UI
		// all agree on the same canonical hostname without a container restart.
		const runtimeConfigPath = resolveRuntimePublicConfigPath();
		if (runtimeConfigPath) {
			persistRuntimePublicConfig(
				{
					managementHostname: configuration.managementHostname,
					adminEmail: configuration.adminEmail,
					publicIp: configuration.publicIp,
					managedDnsZone: configuration.managedDnsZone,
					managedDnsSoaEmail: configuration.managedDnsSoaEmail,
				},
				{ path: runtimeConfigPath },
			);
			const { reloadAuthRuntime } = await import("../lib/auth");
			reloadAuthRuntime();
		}

		const configuredAt = new Date();
		const [configured] = await db
			.update(installSetup)
			.set({
				phase: "configured",
				configuredAt,
				updatedAt: configuredAt,
			})
			.where(
				and(eq(installSetup.id, row.id), eq(installSetup.phase, "pending")),
			)
			.returning({ id: installSetup.id });
		if (!configured) {
			throw new InstallSetupError(
				"Install setup could not be marked complete; retry with the setup token",
				"CONFLICT",
			);
		}

		return getPublicInstallSetupStatus();
	});
}

export async function markInstallSetupClaimed(ownerEmail: string) {
	const row = await getInstallSetupRow();
	if (row.phase === "claimed") return row;
	const now = new Date();
	const [updated] = await db
		.update(installSetup)
		.set({
			phase: "claimed",
			claimedAt: now,
			updatedAt: now,
			adminEmail: normalizeAuthEmail(ownerEmail) || row.adminEmail,
		})
		.where(eq(installSetup.id, row.id))
		.returning();
	return updated ?? row;
}

/** Seed install_setup from legacy env-configured installs so the wizard skips. */
export async function syncInstallSetupFromEnvironment() {
	const row = await getInstallSetupRow();
	if (row.phase !== "pending") return row;
	const host = getManagementHostname();
	const adminEmail = normalizeAuthEmail(process.env.NEARZERO_ADMIN_EMAIL ?? "");
	const zone = getManagedDnsZone();
	const soa = getManagedDnsSoaEmail();
	const publicIp = getConfiguredPublicIp();
	if (!host && !adminEmail && !zone) return row;

	const now = new Date();
	const configured = Boolean(host && isValidAuthEmail(adminEmail));
	const [updated] = await db
		.update(installSetup)
		.set({
			phase: configured ? "configured" : "pending",
			managementHostname: host,
			adminEmail: isValidAuthEmail(adminEmail) ? adminEmail : null,
			managedDnsZone: zone,
			managedDnsSoaEmail: soa,
			publicIp,
			managedDnsSkipped: !zone && !isManagedDnsEnabledByInstaller(),
			configuredAt: configured ? now : null,
			updatedAt: now,
		})
		.where(eq(installSetup.id, row.id))
		.returning();
	return updated ?? row;
}

export type { ApiInstallSetupSubmit };
