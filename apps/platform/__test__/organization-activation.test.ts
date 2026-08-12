import {
	deriveOrganizationActivationStatus,
	type OrganizationActivationResources,
	verifyActivationHttpsCandidate,
} from "@nearzero/server/services/organization-activation";
import { describe, expect, it, vi } from "vitest";

function emptyResources(): OrganizationActivationResources {
	return {
		localRuntimeReady: true,
		readyRemoteCount: 0,
		gitProviderCount: 0,
		projects: [],
	};
}

function application(
	overrides: Partial<
		OrganizationActivationResources["projects"][number]["environments"][number]["applications"][number]
	> = {},
) {
	return {
		applicationId: "app-1",
		name: "Web",
		applicationStatus: "idle" as const,
		sourceType: "docker" as const,
		createdAt: "2026-08-12T03:00:00.000Z",
		deployments: [],
		domains: [],
		...overrides,
	};
}

function projectWithApplications(
	applications: ReturnType<typeof application>[],
): OrganizationActivationResources["projects"][number] {
	return {
		projectId: "project-1",
		name: "Storefront",
		createdAt: "2026-08-12T01:00:00.000Z",
		environments: [
			{
				environmentId: "environment-1",
				name: "production",
				isDefault: true,
				createdAt: "2026-08-12T02:00:00.000Z",
				applications,
				compose: [],
			},
		],
	};
}

describe("organization activation status", () => {
	it("derives progress from persisted resources and preserves manager context", () => {
		const result = deriveOrganizationActivationStatus(emptyResources(), true);

		expect(result).toEqual({
			complete: false,
			canManage: true,
			completed: 1,
			total: 6,
			steps: {
				runtime: {
					complete: true,
					local: { ready: true },
					readyRemoteCount: 0,
				},
				source: {
					complete: false,
					gitProviderCount: 0,
					mode: null,
				},
				project: {
					complete: false,
					projectCount: 0,
					environmentCount: 0,
					first: null,
				},
				service: { complete: false, count: 0, first: null },
				deployment: {
					complete: false,
					status: "not_started",
					deploymentId: null,
					serviceId: null,
					serviceKind: null,
				},
				domain: {
					complete: false,
					configured: false,
					count: 0,
					httpsCount: 0,
					host: null,
				},
			},
		});
	});

	it("makes image and direct-Git applications valid source paths", () => {
		const imageResult = deriveOrganizationActivationStatus(
			{
				...emptyResources(),
				projects: [projectWithApplications([application()])],
			},
			false,
		);
		expect(imageResult.canManage).toBe(false);
		expect(imageResult.steps.source).toEqual({
			complete: true,
			gitProviderCount: 0,
			mode: "image",
		});

		const directGitResult = deriveOrganizationActivationStatus(
			{
				...emptyResources(),
				projects: [
					projectWithApplications([application({ sourceType: "git" })]),
				],
			},
			true,
		);
		expect(directGitResult.steps.source.mode).toBe("direct_git");
		expect(directGitResult.steps.source.complete).toBe(true);
	});

	it("prefers a real connected provider over application source modes", () => {
		const result = deriveOrganizationActivationStatus(
			{
				...emptyResources(),
				gitProviderCount: 2,
				projects: [projectWithApplications([application()])],
			},
			true,
		);

		expect(result.steps.source).toEqual({
			complete: true,
			gitProviderCount: 2,
			mode: "git",
		});
	});

	it("returns the default environment identifiers for a direct Get Started link", () => {
		const resources = emptyResources();
		resources.projects = [
			{
				projectId: "project-1",
				name: "Storefront",
				createdAt: "2026-08-12T01:00:00.000Z",
				environments: [
					{
						environmentId: "staging-env",
						name: "staging",
						isDefault: false,
						createdAt: "2026-08-12T02:00:00.000Z",
						applications: [],
						compose: [],
					},
					{
						environmentId: "default-env",
						name: "production",
						isDefault: true,
						createdAt: "2026-08-12T03:00:00.000Z",
						applications: [],
						compose: [],
					},
				],
			},
		];

		expect(
			deriveOrganizationActivationStatus(resources, true).steps.project.first,
		).toEqual({
			projectId: "project-1",
			environmentId: "default-env",
			name: "Storefront",
		});
	});

	it("uses the latest deployment and requires service and deployment health", () => {
		const result = deriveOrganizationActivationStatus(
			{
				...emptyResources(),
				projects: [
					projectWithApplications([
						application({
							applicationStatus: "done",
							deployments: [
								{
									deploymentId: "old-success",
									status: "done",
									createdAt: "2026-08-12T04:00:00.000Z",
								},
								{
									deploymentId: "latest-error",
									status: "error",
									createdAt: "2026-08-12T05:00:00.000Z",
								},
							],
						}),
					]),
				],
			},
			true,
		);

		expect(result.steps.deployment).toMatchObject({
			complete: false,
			status: "error",
			deploymentId: "latest-error",
			serviceId: "app-1",
			serviceKind: "application",
		});
	});

	it("only configures HTTPS when the domain belongs to a successfully deployed service", () => {
		const domain = {
			host: "web.example.com",
			https: true,
			certificateType: "letsencrypt" as const,
			path: "/",
			createdAt: "2026-08-12T06:00:00.000Z",
		};
		const successful = application({
			applicationId: "healthy-app",
			applicationStatus: "done",
			deployments: [
				{
					deploymentId: "healthy-deployment",
					status: "done",
					createdAt: "2026-08-12T05:00:00.000Z",
				},
			],
		});
		const failedWithDomain = application({
			applicationId: "failed-app",
			applicationStatus: "error",
			createdAt: "2026-08-12T04:00:00.000Z",
			deployments: [
				{
					deploymentId: "failed-deployment",
					status: "error",
					createdAt: "2026-08-12T05:00:00.000Z",
				},
			],
			domains: [domain],
		});

		const notReady = deriveOrganizationActivationStatus(
			{
				...emptyResources(),
				projects: [projectWithApplications([successful, failedWithDomain])],
			},
			true,
		);
		expect(notReady.steps.domain).toMatchObject({
			complete: false,
			configured: false,
			count: 1,
			httpsCount: 1,
			host: null,
		});

		const ready = deriveOrganizationActivationStatus(
			{
				...emptyResources(),
				projects: [
					projectWithApplications([{ ...successful, domains: [domain] }]),
				],
			},
			true,
		);
		expect(ready.steps.domain).toMatchObject({
			complete: true,
			configured: true,
			host: "web.example.com",
		});
		expect(ready.complete).toBe(true);
	});
});

describe("activation HTTPS verification", () => {
	it("reports that no eligible deployed-service domain is configured", async () => {
		await expect(verifyActivationHttpsCandidate(null)).resolves.toEqual({
			configured: false,
			verified: false,
			host: null,
			status: "not_configured",
			code: "HTTPS_NOT_CONFIGURED",
		});
	});

	it("rejects any private DNS answer before opening a connection", async () => {
		const probeHttps = vi.fn(async () => ({ statusCode: 200 }));
		const result = await verifyActivationHttpsCandidate(
			{ host: "web.example.com", path: "/health" },
			{
				resolveAddresses: async () => ["93.184.216.34", "127.0.0.1"],
				probeHttps,
				timeoutMs: 100,
			},
		);

		expect(result).toMatchObject({
			configured: true,
			verified: false,
			status: "failed",
			code: "DNS_UNSAFE",
		});
		expect(probeHttps).not.toHaveBeenCalled();
	});

	it("pins HTTPS to a validated public address and returns no response data", async () => {
		const probeHttps = vi.fn(async () => ({ statusCode: 200 }));
		const result = await verifyActivationHttpsCandidate(
			{ host: "Web.Example.com.", path: "/health" },
			{
				resolveAddresses: async () => ["93.184.216.34", "93.184.216.35"],
				probeHttps,
				timeoutMs: 100,
			},
		);

		expect(probeHttps).toHaveBeenCalledWith(
			{
				hostname: "web.example.com",
				address: "93.184.216.34",
				path: "/health",
			},
			expect.any(AbortSignal),
		);
		expect(result).toEqual({
			configured: true,
			verified: true,
			host: "web.example.com",
			status: "verified",
			code: "HTTPS_VERIFIED",
		});
		expect(result).not.toHaveProperty("body");
		expect(result).not.toHaveProperty("statusCode");
	});

	it("redacts resolver and TLS errors and bounds verification time", async () => {
		const unresolved = await verifyActivationHttpsCandidate(
			{ host: "web.example.com" },
			{
				resolveAddresses: async () => {
					throw new Error("resolver secret");
				},
				probeHttps: async () => ({ statusCode: 200 }),
				timeoutMs: 100,
			},
		);
		expect(unresolved.code).toBe("DNS_UNRESOLVED");
		expect(JSON.stringify(unresolved)).not.toContain("secret");

		const failed = await verifyActivationHttpsCandidate(
			{ host: "web.example.com" },
			{
				resolveAddresses: async () => ["93.184.216.34"],
				probeHttps: async () => {
					throw new Error("certificate response secret");
				},
				timeoutMs: 100,
			},
		);
		expect(failed.code).toBe("TLS_OR_ROUTE_UNREACHABLE");
		expect(JSON.stringify(failed)).not.toContain("secret");

		const redirected = await verifyActivationHttpsCandidate(
			{ host: "web.example.com" },
			{
				resolveAddresses: async () => ["93.184.216.34"],
				probeHttps: async () => ({ statusCode: 302 }),
				timeoutMs: 100,
			},
		);
		expect(redirected).toMatchObject({
			verified: true,
			code: "HTTPS_VERIFIED",
		});

		const notFound = await verifyActivationHttpsCandidate(
			{ host: "web.example.com" },
			{
				resolveAddresses: async () => ["93.184.216.34"],
				probeHttps: async () => ({ statusCode: 404 }),
				timeoutMs: 100,
			},
		);
		expect(notFound).toMatchObject({
			verified: false,
			code: "TLS_OR_ROUTE_UNREACHABLE",
		});

		const probes: string[] = [];
		const secondAddressReady = await verifyActivationHttpsCandidate(
			{ host: "web.example.com" },
			{
				resolveAddresses: async () => ["93.184.216.34", "93.184.216.35"],
				probeHttps: async ({ address }) => {
					probes.push(address);
					if (address === "93.184.216.34") throw new Error("unreachable");
					return { statusCode: 200 };
				},
				timeoutMs: 100,
			},
		);
		expect(secondAddressReady.verified).toBe(true);
		expect(probes).toEqual(["93.184.216.34", "93.184.216.35"]);

		const timedOut = await verifyActivationHttpsCandidate(
			{ host: "web.example.com" },
			{
				resolveAddresses: async () => ["93.184.216.34"],
				probeHttps: () => new Promise(() => undefined),
				timeoutMs: 5,
			},
		);
		expect(timedOut.code).toBe("VERIFICATION_TIMEOUT");
	});
});
