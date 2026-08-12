import { resolve4 } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { db } from "@nearzero/server/db";
import { gitProvider, projects } from "@nearzero/server/db/schema";
import { asc, eq } from "drizzle-orm";
import { checkTraefikHealth } from "../utils/docker/utils";
import { isPublicIpv4 } from "./domain-target";
import { requiresRemoteRuntimeServer } from "./runtime-mode";
import { getReadyRuntimeServers } from "./runtime-policy";

const ACTIVATION_HTTPS_TIMEOUT_MS = 4_000;

export type ActivationServiceKind = "application" | "compose";
export type ActivationServiceStatus = "idle" | "running" | "done" | "error";
export type ActivationDeploymentStatus =
	| "not_started"
	| "running"
	| "done"
	| "error"
	| "cancelled";
export type ActivationSourceMode = "git" | "image" | "direct_git" | null;

type DeploymentResource = {
	deploymentId: string;
	status: Exclude<ActivationDeploymentStatus, "not_started"> | null;
	createdAt: string;
};

type DomainResource = {
	host: string;
	https: boolean;
	certificateType: "letsencrypt" | "none" | "custom";
	path: string | null;
	createdAt: string;
};

type ApplicationResource = {
	applicationId: string;
	name: string;
	applicationStatus: ActivationServiceStatus;
	sourceType:
		| "docker"
		| "git"
		| "github"
		| "gitlab"
		| "bitbucket"
		| "gitea"
		| "drop";
	createdAt: string;
	deployments: DeploymentResource[];
	domains: DomainResource[];
};

type ComposeResource = {
	composeId: string;
	name: string;
	composeStatus: ActivationServiceStatus;
	createdAt: string;
	deployments: DeploymentResource[];
	domains: DomainResource[];
};

export type OrganizationActivationResources = {
	localRuntimeReady: boolean;
	readyRemoteCount: number;
	gitProviderCount: number;
	projects: Array<{
		projectId: string;
		name: string;
		createdAt: string;
		environments: Array<{
			environmentId: string;
			name: string;
			isDefault: boolean;
			createdAt: string;
			applications: ApplicationResource[];
			compose: ComposeResource[];
		}>;
	}>;
};

export type OrganizationActivationStatus = {
	complete: boolean;
	canManage: boolean;
	completed: number;
	total: number;
	steps: {
		runtime: {
			complete: boolean;
			local: { ready: boolean };
			readyRemoteCount: number;
		};
		source: {
			complete: boolean;
			gitProviderCount: number;
			mode: ActivationSourceMode;
		};
		project: {
			complete: boolean;
			projectCount: number;
			environmentCount: number;
			first: {
				projectId: string;
				environmentId: string;
				name: string;
			} | null;
		};
		service: {
			complete: boolean;
			count: number;
			first: {
				kind: ActivationServiceKind;
				id: string;
				name: string;
				status: ActivationServiceStatus;
			} | null;
		};
		deployment: {
			complete: boolean;
			status: ActivationDeploymentStatus;
			deploymentId: string | null;
			serviceId: string | null;
			serviceKind: ActivationServiceKind | null;
		};
		domain: {
			complete: boolean;
			configured: boolean;
			count: number;
			httpsCount: number;
			host: string | null;
		};
	};
};

type NormalizedService = {
	kind: ActivationServiceKind;
	id: string;
	name: string;
	status: ActivationServiceStatus;
	createdAt: string;
	applicationSourceType?: ApplicationResource["sourceType"];
	deployments: DeploymentResource[];
	domains: DomainResource[];
};

export type ActivationHttpsVerification = {
	configured: boolean;
	verified: boolean;
	host: string | null;
	status: "not_configured" | "verified" | "failed";
	code:
		| "HTTPS_NOT_CONFIGURED"
		| "HTTPS_VERIFIED"
		| "DNS_UNRESOLVED"
		| "DNS_UNSAFE"
		| "TLS_OR_ROUTE_UNREACHABLE"
		| "VERIFICATION_TIMEOUT";
};

export type ActivationHttpsProbeDependencies = {
	resolveAddresses: (hostname: string) => Promise<string[]>;
	probeHttps: (
		input: { hostname: string; address: string; path: string },
		signal: AbortSignal,
	) => Promise<{ statusCode: number }>;
	timeoutMs: number;
};

export type ActivationHttpsCandidate = {
	host: string;
	path?: string | null;
};

class ActivationHttpsProbeError extends Error {
	constructor(
		readonly code: "DNS_UNRESOLVED" | "DNS_UNSAFE" | "TLS_OR_ROUTE_UNREACHABLE",
	) {
		super(code);
		this.name = "ActivationHttpsProbeError";
	}
}

function compareCreatedAt(
	a: { createdAt: string },
	b: { createdAt: string },
): number {
	return a.createdAt.localeCompare(b.createdAt);
}

function latestDeployment(service: NormalizedService) {
	return [...service.deployments].sort((a, b) => compareCreatedAt(b, a))[0];
}

function isSuccessfullyDeployed(service: NormalizedService): boolean {
	return (
		service.status === "done" && latestDeployment(service)?.status === "done"
	);
}

function normalizeServices(
	projectRows: OrganizationActivationResources["projects"],
): NormalizedService[] {
	return projectRows
		.flatMap((project) =>
			project.environments.flatMap((environment) => [
				...environment.applications.map((application) => ({
					kind: "application" as const,
					id: application.applicationId,
					name: application.name,
					status: application.applicationStatus,
					createdAt: application.createdAt,
					applicationSourceType: application.sourceType,
					deployments: application.deployments,
					domains: application.domains,
				})),
				...environment.compose.map((service) => ({
					kind: "compose" as const,
					id: service.composeId,
					name: service.name,
					status: service.composeStatus,
					createdAt: service.createdAt,
					deployments: service.deployments,
					domains: service.domains,
				})),
			]),
		)
		.sort(compareCreatedAt);
}

function configuredHttpsDomain(services: NormalizedService[]) {
	return services
		.filter(isSuccessfullyDeployed)
		.flatMap((service) => service.domains)
		.filter((domain) => domain.https && domain.certificateType !== "none")
		.sort(compareCreatedAt)[0];
}

function hasAsciiControlOrSpace(value: string) {
	return Array.from(value).some((character) => {
		const code = character.charCodeAt(0);
		return code <= 32 || code === 127;
	});
}

function normalizeActivationHostname(value: string): string | null {
	const candidate = value.trim().toLowerCase().replace(/\.$/, "");
	if (
		!candidate ||
		candidate.length > 253 ||
		hasAsciiControlOrSpace(candidate) ||
		candidate.includes("://") ||
		candidate.includes("/") ||
		candidate.includes(":") ||
		isIP(candidate) !== 0
	) {
		return null;
	}
	const ascii = domainToASCII(candidate);
	if (
		!ascii ||
		!ascii.includes(".") ||
		!ascii
			.split(".")
			.every(
				(label) =>
					label.length > 0 &&
					label.length <= 63 &&
					/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
			)
	) {
		return null;
	}
	return ascii;
}

function safeActivationPath(value?: string | null) {
	const path = value?.trim() || "/";
	if (
		!path.startsWith("/") ||
		path.length > 2_048 ||
		hasAsciiControlOrSpace(path) ||
		path.includes("\\")
	) {
		return "/";
	}
	return path;
}

function probeActivationHttps(
	input: { hostname: string; address: string; path: string },
	signal: AbortSignal,
) {
	return new Promise<{ statusCode: number }>((resolve, reject) => {
		let settled = false;
		const finish = (error?: unknown, statusCode?: number) => {
			if (settled) return;
			settled = true;
			if (error) reject(error);
			else if (statusCode !== undefined) resolve({ statusCode });
			else reject(new ActivationHttpsProbeError("TLS_OR_ROUTE_UNREACHABLE"));
		};

		try {
			const req = request(
				{
					protocol: "https:",
					hostname: input.hostname,
					port: 443,
					method: "GET",
					path: input.path,
					servername: input.hostname,
					rejectUnauthorized: true,
					agent: false,
					signal,
					headers: {
						accept: "*/*",
						host: input.hostname,
						"user-agent": "nearzero-activation-readiness/1",
					},
					// Resolve once, reject every non-public answer, then pin the socket to
					// the validated address while preserving Host, SNI, and TLS validation.
					lookup: (_hostname, _options, callback) =>
						callback(null, input.address, 4),
				},
				(response) => {
					const statusCode = response.statusCode ?? 0;
					// Headers prove the HTTPS endpoint answered. Destroy immediately so no
					// response body is retained or exposed and redirects are never followed.
					finish(undefined, statusCode);
					response.destroy();
				},
			);
			req.once("error", (error) => finish(error));
			req.end();
		} catch (error) {
			finish(error);
		}
	});
}

const defaultHttpsProbeDependencies: ActivationHttpsProbeDependencies = {
	resolveAddresses: resolve4,
	probeHttps: probeActivationHttps,
	timeoutMs: ACTIVATION_HTTPS_TIMEOUT_MS,
};

export async function verifyActivationHttpsCandidate(
	candidate: ActivationHttpsCandidate | null,
	dependencies: ActivationHttpsProbeDependencies = defaultHttpsProbeDependencies,
): Promise<ActivationHttpsVerification> {
	if (!candidate) {
		return {
			configured: false,
			verified: false,
			host: null,
			status: "not_configured",
			code: "HTTPS_NOT_CONFIGURED",
		};
	}

	const hostname = normalizeActivationHostname(candidate.host);
	if (!hostname) {
		return {
			configured: true,
			verified: false,
			host: null,
			status: "failed",
			code: "DNS_UNSAFE",
		};
	}

	const controller = new AbortController();
	let timedOut = false;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			(async () => {
				let addresses: string[];
				try {
					addresses = await dependencies.resolveAddresses(hostname);
				} catch {
					throw new ActivationHttpsProbeError("DNS_UNRESOLVED");
				}
				const uniqueAddresses = Array.from(new Set(addresses));
				if (
					uniqueAddresses.length === 0 ||
					uniqueAddresses.some((address) => !isPublicIpv4(address))
				) {
					throw new ActivationHttpsProbeError("DNS_UNSAFE");
				}
				for (const address of uniqueAddresses) {
					try {
						const probeResult = await dependencies.probeHttps(
							{
								hostname,
								address,
								path: safeActivationPath(candidate.path),
							},
							controller.signal,
						);
						const routeResponded =
							(probeResult.statusCode >= 200 && probeResult.statusCode < 400) ||
							probeResult.statusCode === 401 ||
							probeResult.statusCode === 403;
						if (routeResponded) return;
					} catch {
						// Multi-address hostnames are normal. Try each already validated public
						// address under the same abort signal and total deadline.
					}
				}
				throw new ActivationHttpsProbeError("TLS_OR_ROUTE_UNREACHABLE");
			})(),
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => {
					timedOut = true;
					controller.abort();
					reject(new Error("activation HTTPS verification timed out"));
				}, dependencies.timeoutMs);
			}),
		]);
		return {
			configured: true,
			verified: true,
			host: hostname,
			status: "verified",
			code: "HTTPS_VERIFIED",
		};
	} catch (error) {
		const code = timedOut
			? "VERIFICATION_TIMEOUT"
			: error instanceof ActivationHttpsProbeError
				? error.code
				: "TLS_OR_ROUTE_UNREACHABLE";
		return {
			configured: true,
			verified: false,
			host: hostname,
			status: "failed",
			code,
		};
	} finally {
		if (timeout) clearTimeout(timeout);
		controller.abort();
	}
}

export function deriveOrganizationActivationStatus(
	resources: OrganizationActivationResources,
	canManage: boolean,
): OrganizationActivationStatus {
	const orderedProjects = [...resources.projects].sort(compareCreatedAt);
	const firstProjectWithEnvironment = orderedProjects.find(
		(project) => project.environments.length > 0,
	);
	const firstEnvironment = firstProjectWithEnvironment
		? [...firstProjectWithEnvironment.environments].sort((a, b) => {
				if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
				return compareCreatedAt(a, b);
			})[0]
		: undefined;

	const services = normalizeServices(orderedProjects);

	const hasImageSource = services.some(
		(service) => service.applicationSourceType === "docker",
	);
	const hasDirectGitSource = services.some(
		(service) => service.applicationSourceType === "git",
	);
	const sourceMode: ActivationSourceMode =
		resources.gitProviderCount > 0
			? "git"
			: hasImageSource
				? "image"
				: hasDirectGitSource
					? "direct_git"
					: null;

	const successfullyDeployedServices = services.filter(isSuccessfullyDeployed);
	const successfulService = successfullyDeployedServices[0];
	const successfulDeployment = successfulService
		? latestDeployment(successfulService)
		: undefined;
	const latestAttempt = services
		.flatMap((service) =>
			service.deployments.map((deployment) => ({ service, deployment })),
		)
		.sort((a, b) => compareCreatedAt(b.deployment, a.deployment))[0];
	const reportedDeployment =
		successfulDeployment && successfulService
			? { service: successfulService, deployment: successfulDeployment }
			: latestAttempt;

	const allDomains = services.flatMap((service) => service.domains);
	const httpsDomains = allDomains.filter(
		(domain) => domain.https && domain.certificateType !== "none",
	);
	const readyDomain = configuredHttpsDomain(successfullyDeployedServices);

	const steps: OrganizationActivationStatus["steps"] = {
		runtime: {
			complete: resources.localRuntimeReady || resources.readyRemoteCount > 0,
			local: { ready: resources.localRuntimeReady },
			readyRemoteCount: resources.readyRemoteCount,
		},
		source: {
			complete: sourceMode !== null,
			gitProviderCount: resources.gitProviderCount,
			mode: sourceMode,
		},
		project: {
			complete: Boolean(firstProjectWithEnvironment && firstEnvironment),
			projectCount: resources.projects.length,
			environmentCount: resources.projects.reduce(
				(total, project) => total + project.environments.length,
				0,
			),
			first:
				firstProjectWithEnvironment && firstEnvironment
					? {
							projectId: firstProjectWithEnvironment.projectId,
							environmentId: firstEnvironment.environmentId,
							name: firstProjectWithEnvironment.name,
						}
					: null,
		},
		service: {
			complete: services.length > 0,
			count: services.length,
			first: services[0]
				? {
						kind: services[0].kind,
						id: services[0].id,
						name: services[0].name,
						status: services[0].status,
					}
				: null,
		},
		deployment: {
			complete: Boolean(successfulDeployment),
			status: reportedDeployment?.deployment.status ?? "not_started",
			deploymentId: reportedDeployment?.deployment.deploymentId ?? null,
			serviceId: reportedDeployment?.service.id ?? null,
			serviceKind: reportedDeployment?.service.kind ?? null,
		},
		domain: {
			complete: Boolean(readyDomain),
			configured: Boolean(readyDomain),
			count: allDomains.length,
			httpsCount: httpsDomains.length,
			host: readyDomain?.host ?? null,
		},
	};

	const stepValues = Object.values(steps);
	const completed = stepValues.filter((step) => step.complete).length;

	return {
		complete: completed === stepValues.length,
		canManage,
		completed,
		total: stepValues.length,
		steps,
	};
}

async function checkLocalRuntimeReady(): Promise<boolean> {
	if (requiresRemoteRuntimeServer()) return false;
	try {
		return (await checkTraefikHealth()).status === "healthy";
	} catch {
		return false;
	}
}

async function countConnectedGitProviders(organizationId: string) {
	const providerRows = await db.query.gitProvider.findMany({
		where: eq(gitProvider.organizationId, organizationId),
		columns: {
			providerType: true,
		},
		with: {
			github: { columns: { githubId: true } },
			gitlab: { columns: { gitlabId: true } },
			bitbucket: { columns: { bitbucketId: true } },
			gitea: { columns: { giteaId: true } },
		},
	});

	return providerRows.filter((provider) => {
		switch (provider.providerType) {
			case "github":
				return Boolean(provider.github);
			case "gitlab":
				return Boolean(provider.gitlab);
			case "bitbucket":
				return Boolean(provider.bitbucket);
			case "gitea":
				return Boolean(provider.gitea);
		}
	}).length;
}

async function loadOrganizationProjects(organizationId: string) {
	return db.query.projects.findMany({
		where: eq(projects.organizationId, organizationId),
		columns: {
			projectId: true,
			name: true,
			createdAt: true,
		},
		orderBy: [asc(projects.createdAt)],
		with: {
			environments: {
				columns: {
					environmentId: true,
					name: true,
					isDefault: true,
					createdAt: true,
				},
				orderBy: (environment, { desc: descending, asc: ascending }) => [
					descending(environment.isDefault),
					ascending(environment.createdAt),
				],
				with: {
					applications: {
						columns: {
							applicationId: true,
							name: true,
							applicationStatus: true,
							sourceType: true,
							createdAt: true,
						},
						orderBy: (application, { asc: ascending }) => [
							ascending(application.createdAt),
						],
						with: {
							deployments: {
								where: (deployment, { eq: equals }) =>
									equals(deployment.isPreviewDeployment, false),
								columns: {
									deploymentId: true,
									status: true,
									createdAt: true,
								},
								orderBy: (deployment, { desc: descending }) => [
									descending(deployment.createdAt),
								],
								limit: 1,
							},
							domains: {
								columns: {
									host: true,
									https: true,
									certificateType: true,
									path: true,
									createdAt: true,
								},
								orderBy: (domain, { asc: ascending }) => [
									ascending(domain.createdAt),
								],
							},
						},
					},
					compose: {
						columns: {
							composeId: true,
							name: true,
							composeStatus: true,
							createdAt: true,
						},
						orderBy: (service, { asc: ascending }) => [
							ascending(service.createdAt),
						],
						with: {
							deployments: {
								where: (deployment, { eq: equals }) =>
									equals(deployment.isPreviewDeployment, false),
								columns: {
									deploymentId: true,
									status: true,
									createdAt: true,
								},
								orderBy: (deployment, { desc: descending }) => [
									descending(deployment.createdAt),
								],
								limit: 1,
							},
							domains: {
								columns: {
									host: true,
									https: true,
									certificateType: true,
									path: true,
									createdAt: true,
								},
								orderBy: (domain, { asc: ascending }) => [
									ascending(domain.createdAt),
								],
							},
						},
					},
				},
			},
		},
	});
}

export async function getOrganizationActivationStatus(input: {
	organizationId: string;
	canManage: boolean;
}): Promise<OrganizationActivationStatus> {
	const [localRuntimeReady, readyRemoteServers, gitProviderCount, projectRows] =
		await Promise.all([
			checkLocalRuntimeReady(),
			getReadyRuntimeServers(input.organizationId),
			countConnectedGitProviders(input.organizationId),
			loadOrganizationProjects(input.organizationId),
		]);

	return deriveOrganizationActivationStatus(
		{
			localRuntimeReady,
			readyRemoteCount: readyRemoteServers.length,
			gitProviderCount,
			projects: projectRows,
		},
		input.canManage,
	);
}

export async function verifyOrganizationActivationHttps(
	organizationId: string,
): Promise<ActivationHttpsVerification> {
	const projectRows = await loadOrganizationProjects(organizationId);
	const candidate = configuredHttpsDomain(normalizeServices(projectRows));
	return verifyActivationHttpsCandidate(
		candidate ? { host: candidate.host, path: candidate.path } : null,
	);
}
