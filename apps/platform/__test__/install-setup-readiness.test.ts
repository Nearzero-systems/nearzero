import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import {
	getInstallSetupReadiness,
	type InstallSetupHttpsProbeResponse,
	type InstallSetupReadinessDependencies,
	type InstallSetupReadinessError,
	type InstallSetupReadinessState,
} from "@nearzero/server/services/install-setup-readiness";
import { describe, expect, it, vi } from "vitest";
import {
	handleInstallSetup,
	INSTALL_SETUP_JSON_BODY_LIMIT_BYTES,
	InstallSetupBodyTooLargeError,
	installSetupClientKey,
	installSetupRequestIsHttps,
	installSetupRequestToken,
	installSetupSessionCookie,
	installSetupPayloadErrorMessage,
	installSetupSubmitPayload,
	readInstallSetupJsonBody,
} from "../server/routes/install-setup";

const READY_STATE: InstallSetupReadinessState = {
	status: {
		required: false,
		phase: "configured",
		community: true,
		bootstrapClaimed: false,
		setupTokenConfigured: true,
		managementConfigured: true,
		managementHostname: "nearzero.example.com",
		adminEmailConfigured: true,
		publicIp: "8.8.8.8",
		managedDnsEnabled: true,
		managedDnsConfigured: true,
		managedDnsZone: "apps.example.com",
		managedDnsSkipped: false,
		canSubmit: false,
		resumeStep: "register",
	},
	adminEmail: "owner@example.com",
	managedDnsSoaEmail: "dns@example.com",
	lockedFields: {
		managementHostname: true,
		adminEmail: true,
		publicIp: true,
		managedDnsZone: false,
		managedDnsSoaEmail: false,
		managedDnsEnabled: true,
	},
};

function readyHttpsResponse(
	hostname = "nearzero.example.com",
): InstallSetupHttpsProbeResponse {
	return {
		statusCode: 200,
		contentType: "application/json; charset=utf-8",
		body: JSON.stringify({
			community: true,
			phase: "configured",
			setupTokenConfigured: true,
			managementHostname: hostname,
		}),
	};
}

function dependencies(
	overrides: Partial<InstallSetupReadinessDependencies> = {},
): InstallSetupReadinessDependencies {
	return {
		verifyToken: (token) => token === "valid-setup-token",
		loadState: async () => READY_STATE,
		resolveManagementAddresses: vi.fn(async () => ["8.8.8.8"]),
		probeManagementHttps: vi.fn(async () => readyHttpsResponse()),
		inspectDelegation: vi.fn(async (zone) => ({
			published: true,
			delegated: true,
			authoritative: true,
			expectedNameservers: zone.nameservers,
			observedNameservers: zone.nameservers,
			diagnostics: [],
		})),
		consumeRateLimit: () => true,
		now: () => Date.UTC(2026, 7, 11, 12, 0, 0),
		probeTimeoutMs: 50,
		totalTimeoutMs: 250,
		...overrides,
	};
}

describe("token-authorized install readiness", () => {
	it("reports exact management A, direct HTTPS, delegation, and authoritative SOA", async () => {
		const probeManagementHttps = vi.fn(async () => readyHttpsResponse());
		const inspectDelegation = vi.fn(
			async (
				zone: Parameters<
					InstallSetupReadinessDependencies["inspectDelegation"]
				>[0],
			) => ({
				published: true,
				delegated: true,
				authoritative: true,
				expectedNameservers: zone.nameservers,
				observedNameservers: zone.nameservers,
				diagnostics: [],
			}),
		);
		const result = await getInstallSetupReadiness(
			{ token: "valid-setup-token", clientKey: "operator" },
			dependencies({ probeManagementHttps, inspectDelegation }),
		);

		expect(result).toMatchObject({
			ready: true,
			configuration: {
				managementHostname: "nearzero.example.com",
				adminEmail: "owner@example.com",
				publicIp: "8.8.8.8",
				managedDnsZone: "apps.example.com",
				managedDnsSoaEmail: "dns@example.com",
				managedDnsEnabled: true,
			},
			management: {
				expectedAddresses: ["8.8.8.8"],
				observedAddresses: ["8.8.8.8"],
				ready: true,
				aRecord: { status: "ready", code: "A_RECORD_READY" },
				https: { status: "ready", code: "HTTPS_NEARZERO_READY" },
			},
			managedDns: {
				status: "ready",
				delegated: true,
				authoritativeSoa: true,
				ready: true,
			},
		});
		expect(probeManagementHttps).toHaveBeenCalledWith(
			{
				hostname: "nearzero.example.com",
				address: "8.8.8.8",
				port: 443,
			},
			expect.any(AbortSignal),
		);
		expect(inspectDelegation).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "apps.example.com",
				nameservers: ["ns1.apps.example.com", "ns2.apps.example.com"],
			}),
			expect.any(AbortSignal),
		);
	});

	it("checks HTTPS at the configured IP but keeps extra A records pending", async () => {
		const probeManagementHttps = vi.fn(async () => readyHttpsResponse());
		const result = await getInstallSetupReadiness(
			{ token: "valid-setup-token" },
			dependencies({
				resolveManagementAddresses: async () => ["1.1.1.1", "8.8.8.8"],
				probeManagementHttps,
			}),
		);

		expect(probeManagementHttps).toHaveBeenCalledOnce();
		expect(result.management.aRecord).toMatchObject({
			status: "pending",
			code: "A_RECORD_MISMATCH",
			matches: false,
		});
		expect(result.management.https.status).toBe("ready");
		expect(result.ready).toBe(false);
	});

	it("never probes a private address even if persisted configuration is corrupt", async () => {
		const resolveManagementAddresses = vi.fn(async () => ["127.0.0.1"]);
		const probeManagementHttps = vi.fn(async () => readyHttpsResponse());
		const result = await getInstallSetupReadiness(
			{ token: "valid-setup-token" },
			dependencies({
				loadState: async () => ({
					...READY_STATE,
					status: { ...READY_STATE.status, publicIp: "127.0.0.1" },
				}),
				resolveManagementAddresses,
				probeManagementHttps,
			}),
		);

		expect(result.management.aRecord.code).toBe("CONFIGURATION_INVALID");
		expect(resolveManagementAddresses).not.toHaveBeenCalled();
		expect(probeManagementHttps).not.toHaveBeenCalled();
	});

	it("rejects a valid TLS route that does not identify this Nearzero install", async () => {
		const genericRoute = await getInstallSetupReadiness(
			{ token: "valid-setup-token" },
			dependencies({
				probeManagementHttps: async () => ({
					statusCode: 200,
					contentType: "text/html; charset=utf-8",
					body: "<html>another service</html>",
				}),
			}),
		);
		expect(genericRoute.management.https).toMatchObject({
			status: "failed",
			code: "HTTPS_ROUTE_NOT_NEARZERO",
		});
		expect(genericRoute.ready).toBe(false);

		const otherNearzero = await getInstallSetupReadiness(
			{ token: "valid-setup-token" },
			dependencies({
				probeManagementHttps: async () =>
					readyHttpsResponse("nearzero.other.example.com"),
			}),
		);
		expect(otherNearzero.management.https.code).toBe(
			"HTTPS_ROUTE_NOT_NEARZERO",
		);
	});

	it("does not expose raw resolver or authoritative probe errors", async () => {
		const result = await getInstallSetupReadiness(
			{ token: "valid-setup-token" },
			dependencies({
				resolveManagementAddresses: async () => {
					throw new Error("resolver secret=do-not-return");
				},
				inspectDelegation: async () => ({
					published: true,
					delegated: false,
					authoritative: false,
					expectedNameservers: ["ns1.apps.example.com", "ns2.apps.example.com"],
					observedNameservers: [],
					diagnostics: ["socket secret=do-not-return"],
				}),
			}),
		);

		expect(result.management.aRecord.code).toBe("A_LOOKUP_FAILED");
		expect(result.managedDns.code).toBe(
			"MANAGED_DNS_DELEGATION_AND_SOA_PENDING",
		);
		expect(JSON.stringify(result)).not.toContain("do-not-return");
	});

	it("bounds DNS and HTTPS probes with safe timeout states", async () => {
		const never = new Promise<never>(() => undefined);
		const dnsResult = await getInstallSetupReadiness(
			{ token: "valid-setup-token" },
			dependencies({
				resolveManagementAddresses: async () => never,
				probeTimeoutMs: 10,
				totalTimeoutMs: 100,
			}),
		);
		expect(dnsResult.management.aRecord.code).toBe("A_LOOKUP_TIMEOUT");

		const tlsResult = await getInstallSetupReadiness(
			{ token: "valid-setup-token" },
			dependencies({
				probeManagementHttps: async () => never,
				probeTimeoutMs: 10,
				totalTimeoutMs: 100,
			}),
		);
		expect(tlsResult.management.https).toMatchObject({
			status: "failed",
			code: "HTTPS_TIMEOUT",
		});
	});

	it("does not probe configuration for an invalid token or claimed install", async () => {
		const loadState = vi.fn(async () => READY_STATE);
		await expect(
			getInstallSetupReadiness({ token: "wrong" }, dependencies({ loadState })),
		).rejects.toMatchObject<Partial<InstallSetupReadinessError>>({
			code: "UNAUTHORIZED",
		});
		expect(loadState).not.toHaveBeenCalled();

		await expect(
			getInstallSetupReadiness(
				{ token: "valid-setup-token" },
				dependencies({
					loadState: async () => ({
						...READY_STATE,
						status: { ...READY_STATE.status, bootstrapClaimed: true },
					}),
				}),
			),
		).rejects.toMatchObject<Partial<InstallSetupReadinessError>>({
			code: "FORBIDDEN",
		});
	});

	it("returns skipped managed DNS without attempting delegation", async () => {
		const inspectDelegation = vi.fn();
		const result = await getInstallSetupReadiness(
			{ token: "valid-setup-token" },
			dependencies({
				loadState: async () => ({
					...READY_STATE,
					status: {
						...READY_STATE.status,
						managedDnsSkipped: true,
						managedDnsZone: null,
					},
				}),
				inspectDelegation,
			}),
		);
		expect(result.managedDns).toMatchObject({
			status: "skipped",
			ready: true,
		});
		expect(inspectDelegation).not.toHaveBeenCalled();
	});

	it("returns a rate-limit error before doing authorized work", async () => {
		const loadState = vi.fn(async () => READY_STATE);
		await expect(
			getInstallSetupReadiness(
				{ token: "valid-setup-token", clientKey: "busy-client" },
				dependencies({ consumeRateLimit: () => false, loadState }),
			),
		).rejects.toMatchObject<Partial<InstallSetupReadinessError>>({
			code: "RATE_LIMITED",
		});
		expect(loadState).not.toHaveBeenCalled();
	});
});

describe("install setup session cookie", () => {
	it("is HttpOnly, strict, scoped, and secure only on HTTPS", () => {
		const plain = installSetupSessionCookie("token/value", false);
		expect(plain).toContain("nearzero_install_setup_token=token%2Fvalue");
		expect(plain).toContain("Max-Age=86400");
		expect(plain).toContain("Path=/");
		expect(plain).toContain("HttpOnly");
		expect(plain).toContain("SameSite=Strict");
		expect(plain).not.toContain("Secure");
		expect(installSetupSessionCookie("token", true)).toContain("Secure");
	});

	it("prefers the explicit header and otherwise reads the scoped cookie", () => {
		expect(
			installSetupRequestToken({
				headers: {
					cookie: "nearzero_install_setup_token=cookie-token",
					"x-nearzero-setup-token": "header-token",
				},
			}),
		).toBe("header-token");
		expect(
			installSetupRequestToken({
				headers: {
					cookie: "other=1; nearzero_install_setup_token=cookie%2Ftoken",
				},
			}),
		).toBe("cookie/token");
	});

	it("explains a missing setup token instead of a generic payload error", () => {
		expect(
			installSetupPayloadErrorMessage({
				name: "ZodError",
				issues: [
					{
						code: "invalid_type",
						expected: "string",
						received: "undefined",
						path: ["token"],
						message: "Required",
					},
				],
			}),
		).toBe(
			"Open the setup link from the installer to apply this configuration.",
		);
	});

	it("injects the HttpOnly session token into setup submission", () => {
		expect(
			installSetupSubmitPayload(
				{ managementHostname: "nearzero.example.com" },
				{
					headers: {
						cookie: "nearzero_install_setup_token=session-token",
					},
				},
			),
		).toEqual({
			managementHostname: "nearzero.example.com",
			token: "session-token",
		});
	});

	it("detects HTTPS through the trusted proxy signal or TLS socket", () => {
		const request = (value: {
			headers: IncomingMessage["headers"];
			encrypted?: boolean;
		}) =>
			({
				headers: value.headers,
				socket: { encrypted: value.encrypted },
			}) as unknown as Pick<IncomingMessage, "headers" | "socket">;

		expect(
			installSetupRequestIsHttps(
				request({ headers: { "x-forwarded-proto": "https" } }),
			),
		).toBe(true);
		expect(
			installSetupRequestIsHttps(request({ headers: {}, encrypted: true })),
		).toBe(true);
		expect(installSetupRequestIsHttps(request({ headers: {} }))).toBe(false);
	});

	it("uses the rightmost valid forwarded address and safely falls back", () => {
		const request = (
			forwarded: string | undefined,
			remoteAddress = "192.0.2.90",
		) =>
			({
				headers: forwarded ? { "x-forwarded-for": forwarded } : {},
				socket: { remoteAddress },
			}) as unknown as Pick<IncomingMessage, "headers" | "socket">;

		expect(
			installSetupClientKey(
				request("198.51.100.7, attacker-controlled, 203.0.113.24"),
			),
		).toBe("203.0.113.24");
		expect(installSetupClientKey(request("garbage, [2001:db8::1]:443"))).toBe(
			"2001:db8::1",
		);
		expect(installSetupClientKey(request("garbage"))).toBe("192.0.2.90");
		expect(installSetupClientKey(request(undefined))).toBe("192.0.2.90");
	});
});

function requestWithBody(
	url: string,
	chunks: Array<Buffer | string>,
	headers: IncomingMessage["headers"] = {},
) {
	const req = Readable.from(chunks) as unknown as IncomingMessage;
	Object.assign(req, {
		url,
		method: "POST",
		headers,
		socket: { remoteAddress: "127.0.0.1" },
	});
	return req;
}

function responseCapture() {
	let body = "";
	const headers = new Map<string, number | string | readonly string[]>();
	const res = {
		statusCode: 200,
		setHeader(name: string, value: number | string | readonly string[]) {
			headers.set(name.toLowerCase(), value);
			return this;
		},
		end(value?: string | Buffer) {
			body = value?.toString() ?? "";
			return this;
		},
	} as unknown as ServerResponse;
	return { res, headers, readBody: () => body };
}

describe("install setup JSON body limits", () => {
	it("rejects an oversized chunked body before retaining it", async () => {
		const req = requestWithBody("/api/install/setup/session", [
			Buffer.alloc(INSTALL_SETUP_JSON_BODY_LIMIT_BYTES, 32),
			Buffer.from("x"),
		]);
		await expect(readInstallSetupJsonBody(req)).rejects.toBeInstanceOf(
			InstallSetupBodyTooLargeError,
		);
	});

	it.each(["/api/install/setup/session", "/api/install/setup"])(
		"returns a safe 413 for %s without token or setup work",
		async (url) => {
			const req = requestWithBody(url, ["{}"], {
				"content-length": String(INSTALL_SETUP_JSON_BODY_LIMIT_BYTES + 1),
			});
			const capture = responseCapture();
			await handleInstallSetup(req, capture.res);

			expect(capture.res.statusCode).toBe(413);
			expect(capture.headers.get("cache-control")).toBe("no-store");
			expect(JSON.parse(capture.readBody())).toEqual({
				message: "Install setup request body is too large",
				code: "PAYLOAD_TOO_LARGE",
			});
		},
	);
});
