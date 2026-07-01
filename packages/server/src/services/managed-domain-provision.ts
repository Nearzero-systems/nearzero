import { getPlatformDefaultDomain } from "@nearzero/server/constants";
import { db } from "@nearzero/server/db";
import { dnsZones, previewDeployments } from "@nearzero/server/db/schema";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import {
	createDomain,
	findDomainByOrganizationAndHost,
	findDomainsByApplicationId,
	findDomainsByComposeId,
	getDomainHost,
	syncManagedDnsRecordForDomain,
	type Domain,
	updateDomainById,
} from "./domain";
import { resolveDomainTargetIp } from "./domain-target";
import { findEnvironmentForDomain } from "./environment";
import { findApplicationById } from "./application";
import { findComposeById } from "./compose";
import { getWebServerSettings } from "./web-server-settings";
import { checkDnsHealth } from "./dns";
import {
	buildManagedPreviewHost,
	buildManagedServiceHost,
	buildPlatformDefaultServiceHost,
	buildPlatformDefaultPreviewHost,
	buildPreviewServiceSlug,
	slugifyServiceName,
} from "./managed-domain";
import { manageDomain } from "../utils/traefik/domain";
import {
	loadOrCreateConfig,
	loadOrCreateConfigRemote,
} from "../utils/traefik/application";
import { getRemoteDocker } from "../utils/servers/remote-docker";

export type ServiceDomainMode =
	| "org-zone"
	| "platform"
	| "preview"
	| "byod"
	| "none";

export type PreviewServiceDomainInput = {
	environmentId: string;
	serviceName: string;
	serverId?: string | null;
};

export type PreviewServiceDomainResult = {
	mode: ServiceDomainMode;
	enabled: boolean;
	host: string | null;
	targetIp: string | null;
	ipSource: "webServer" | "remoteServer" | null;
	zoneName: string | null;
	platformApex: string | null;
	visitUrl: string | null;
	warnings: string[];
};

export type ProvisionServiceDomainInput = {
	environmentId: string;
	serviceName: string;
	port: number;
	serverId?: string | null;
	path?: string;
} & (
	| { applicationId: string; domainType: "application" }
	| { composeId: string; domainType: "compose" }
);

export type DomainProvisionContext = {
	serviceType: "application" | "compose" | "preview";
	serviceId: string;
	environmentId: string;
	deployServerId?: string | null;
	resolvedPort: number;
	desiredHostMode?: ServiceDomainMode;
	preview?: {
		previewDeploymentId: string;
		pullRequestNumber: string;
		serviceName: string;
		applicationId: string;
	};
};

export type PreviewDomainPlan = {
	mode: ServiceDomainMode;
	host: string;
	targetIp: string | null;
	dnsZoneId?: string;
	managedByNearzero: boolean;
	https: boolean;
	certificateType: "letsencrypt" | "none" | "custom";
};

function serviceIdForProvision(input: ProvisionServiceDomainInput) {
	return input.domainType === "application" ? input.applicationId : input.composeId;
}

function domainBelongsToProvisionedService(
	domain: Domain,
	input: ProvisionServiceDomainInput,
) {
	return input.domainType === "application"
		? domain.applicationId === input.applicationId
		: domain.composeId === input.composeId;
}

function appendHostnameSuffix(host: string, suffix: string) {
	const parts = host.split(".");
	const first = parts.shift() || "service";
	return [`${first}-${suffix}`, ...parts].join(".");
}

async function resolveProvisionedHost(input: {
	organizationId: string;
	baseHost: string;
	provision: ProvisionServiceDomainInput;
}) {
	const existing = await findDomainByOrganizationAndHost(
		input.organizationId,
		input.baseHost,
	);
	if (!existing || domainBelongsToProvisionedService(existing, input.provision)) {
		return { host: input.baseHost, existing };
	}

	const serviceSuffix =
		slugifyServiceName(serviceIdForProvision(input.provision)).slice(0, 8) ||
		"service";
	const candidates = [
		appendHostnameSuffix(input.baseHost, serviceSuffix),
		appendHostnameSuffix(input.baseHost, `${serviceSuffix}-2`),
		appendHostnameSuffix(input.baseHost, `${serviceSuffix}-3`),
	];

	for (const host of candidates) {
		const conflict = await findDomainByOrganizationAndHost(
			input.organizationId,
			host,
		);
		if (!conflict || domainBelongsToProvisionedService(conflict, input.provision)) {
			return { host, existing: conflict };
		}
	}

	throw new TRPCError({
		code: "CONFLICT",
		message: "A managed hostname already exists for this service name",
	});
}

async function syncApplicationDomainRoute(
	input: ProvisionServiceDomainInput,
	domain: Domain | null,
): Promise<Domain | null> {
	if (!domain || input.domainType !== "application") {
		return domain;
	}

	const application = await findApplicationById(input.applicationId);
	await manageDomain(
		{
			...application,
			serverId: input.serverId ?? application.serverId,
		},
		domain,
	);
	return domain;
}

async function syncProvisionedDomain(
	input: ProvisionServiceDomainInput,
	domain: Domain,
	path: string,
): Promise<Domain> {
	const update: { port?: number; path?: string } = {};
	if (domain.port !== input.port) {
		update.port = input.port;
	}
	if ((domain.path ?? "/") !== path) {
		update.path = path;
	}

	const next =
		Object.keys(update).length > 0
			? (await updateDomainById(domain.domainId, update)) ?? domain
			: domain;
	return (await syncApplicationDomainRoute(input, next)) ?? next;
}

function replaceWildcardHost(baseDomain: string, previewSlug: string) {
	const normalized = baseDomain.trim().toLowerCase().replace(/\.$/, "");
	if (!normalized.startsWith("*.")) {
		throw new Error('The preview wildcard domain must start with "*."');
	}
	return normalized.replace("*", previewSlug);
}

export async function resolvePreviewDomainPlan(input: {
	applicationId: string;
	environmentId: string;
	serviceName: string;
	projectName: string;
	pullRequestNumber: string;
	serverId?: string | null;
	previewWildcard?: string | null;
	previewHttps?: boolean | null;
	previewCertificateType?: "letsencrypt" | "none" | "custom" | null;
}): Promise<PreviewDomainPlan> {
	const env = await findEnvironmentForDomain(input.environmentId);
	const previewSlug = buildPreviewServiceSlug({
		pullRequestNumber: input.pullRequestNumber,
		serviceName: input.serviceName,
		applicationId: input.applicationId,
	});
	const platformApex = getPlatformDefaultDomain();
	const targetIp = await resolveDomainTargetIp(input.serverId).catch(
		() => null,
	);

	if (env.dnsZoneId) {
		const zone = await db.query.dnsZones.findFirst({
			where: eq(dnsZones.dnsZoneId, env.dnsZoneId),
		});
		if (!zone) {
			throw new TRPCError({ code: "NOT_FOUND", message: "DNS zone not found" });
		}
		return {
			mode: "org-zone",
			host: buildManagedPreviewHost({
				appName: previewSlug,
				zoneName: zone.name,
				targetIp: targetIp ?? "",
			}),
			targetIp,
			dnsZoneId: zone.dnsZoneId,
			managedByNearzero: true,
			https: true,
			certificateType: "letsencrypt",
		};
	}

	if (platformApex) {
		return {
			mode: "platform",
			host: buildPlatformDefaultPreviewHost({
				previewSlug,
				projectName: input.projectName,
			}),
			targetIp,
			managedByNearzero: false,
			https: true,
			certificateType: "letsencrypt",
		};
	}

	if (input.previewWildcard?.trim()) {
		return {
			mode: "preview",
			host: replaceWildcardHost(input.previewWildcard, previewSlug),
			targetIp,
			managedByNearzero: false,
			https: input.previewHttps ?? true,
			certificateType: input.previewCertificateType ?? "letsencrypt",
		};
	}

	if (!targetIp) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Could not resolve a target IP for the preview domain",
		});
	}

	return {
		mode: "preview",
		host: buildManagedPreviewHost({
			appName: previewSlug,
			zoneName: "sslip.io",
			targetIp,
		}),
		targetIp,
		managedByNearzero: false,
		https: input.previewHttps ?? true,
		certificateType: input.previewCertificateType ?? "letsencrypt",
	};
}

export async function ensurePreviewDeploymentDomain(input: {
	previewDeploymentId: string;
	applicationId: string;
	serviceName: string;
	environmentId: string;
	projectName: string;
	appName: string;
	pullRequestNumber: string;
	port: number;
	serverId?: string | null;
	path?: string | null;
	previewWildcard?: string | null;
	previewHttps?: boolean | null;
	previewCertificateType?: "letsencrypt" | "none" | "custom" | null;
	previewCustomCertResolver?: string | null;
}): Promise<Domain> {
	const preview = await db.query.previewDeployments.findFirst({
		where: eq(previewDeployments.previewDeploymentId, input.previewDeploymentId),
		with: { domain: true },
	});
	if (!preview) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Preview Deployment not found",
		});
	}
	const application = await findApplicationById(input.applicationId);
	const plan = await resolvePreviewDomainPlan({
		applicationId: input.applicationId,
		environmentId: input.environmentId,
		serviceName: input.serviceName,
		projectName: input.projectName,
		pullRequestNumber: input.pullRequestNumber,
		serverId: input.serverId,
		previewWildcard: input.previewWildcard,
		previewHttps: input.previewHttps,
		previewCertificateType: input.previewCertificateType,
	});
	const path = input.path ?? "/";
	const domain =
		preview.domain ??
		(await createDomain({
			host: plan.host,
			path,
			port: input.port,
			https: plan.https,
			certificateType: plan.certificateType,
			customCertResolver: input.previewCustomCertResolver ?? undefined,
			domainType: "preview",
			previewDeploymentId: input.previewDeploymentId,
			dnsZoneId: plan.dnsZoneId,
			managedByNearzero: plan.managedByNearzero,
		}));

	const update: Partial<Domain> = {};
	if (domain.host !== plan.host) update.host = plan.host;
	if (domain.port !== input.port) update.port = input.port;
	if ((domain.path ?? "/") !== path) update.path = path;
	if (domain.https !== plan.https) update.https = plan.https;
	if (domain.certificateType !== plan.certificateType) {
		update.certificateType = plan.certificateType;
	}
	if ((domain.dnsZoneId ?? undefined) !== plan.dnsZoneId) {
		update.dnsZoneId = plan.dnsZoneId;
	}
	if (domain.managedByNearzero !== plan.managedByNearzero) {
		update.managedByNearzero = plan.managedByNearzero;
	}

	const next =
		Object.keys(update).length > 0
			? (await updateDomainById(domain.domainId, update)) ?? domain
			: domain;

	if (!preview.domainId) {
		await db
			.update(previewDeployments)
			.set({ domainId: next.domainId })
			.where(eq(previewDeployments.previewDeploymentId, input.previewDeploymentId));
	}

	if (next.managedByNearzero && next.dnsZoneId) {
		await syncManagedDnsRecordForDomain(next, {
			previewDeploymentId: input.previewDeploymentId,
			dnsZoneId: next.dnsZoneId,
			managedByNearzero: true,
			serverId: input.serverId,
			managedBy: "preview-domain",
		});
	}

	await manageDomain(
		{
			...application,
			appName: input.appName,
			serverId: input.serverId ?? application.serverId,
		},
		next,
	);
	return next;
}

export async function verifyApplicationDomainRoute(input: {
	appName: string;
	serverId?: string | null;
	domain: Domain;
}) {
	const messages: string[] = [];
	const routePort = input.domain.port || 80;
	const dnsMode = input.domain.managedByNearzero
		? input.domain.dnsZoneId
			? "nearzero-managed"
			: "managed-fallback"
		: "external";
	let targetIp: string | null = null;
	try {
		targetIp = await resolveDomainTargetIp(input.serverId);
	} catch {
		targetIp = null;
	}
	messages.push(
		`Domain assigned: ${getDomainHost(input.domain)} (target port ${routePort}, DNS ${dnsMode}, DNS target IP ${targetIp ?? "unresolved"})`,
	);
	if (
		input.domain.managedByNearzero &&
		input.domain.dnsZoneId &&
		!input.domain.dnsRecordId
	) {
		messages.push(
			"DNS needs setup: managed DNS record was not published yet.",
		);
	}

	const serviceName = `${input.appName}-service-${input.domain.uniqueConfigKey}`;
	const expectedUrl = `http://${input.appName}:${routePort}`;
	let routeOk = false;
	try {
		const config = input.serverId
			? await loadOrCreateConfigRemote(input.serverId, input.appName)
			: loadOrCreateConfig(input.appName);
		const service = config.http?.services?.[serviceName] as
			| { loadBalancer?: { servers?: Array<{ url?: string }> } }
			| undefined;
		const urls = service?.loadBalancer?.servers?.map((server) => server.url) ?? [];
		routeOk = urls.includes(expectedUrl);
		messages.push(
			routeOk
				? `Route verified: ${input.domain.host} -> ${expectedUrl}`
				: `Route needs attention: expected ${expectedUrl}, found ${urls.join(", ") || "no Traefik service"}`,
		);
	} catch (error) {
		messages.push(
			`Route verification skipped: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	let networkOk = false;
	try {
		const docker = await getRemoteDocker(input.serverId);
		const service = await docker.getService(input.appName).inspect();
		const networks = service.Spec?.TaskTemplate?.Networks ?? [];
		networkOk = networks.some(
			(network: { Target?: string }) => network.Target === "nearzero-network",
		);
		messages.push(
			networkOk
				? "Network verified: service is attached to nearzero-network"
				: "Network needs attention: service is not attached to nearzero-network",
		);
	} catch (error) {
		messages.push(
			`Network verification skipped: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	return {
		ok: routeOk && networkOk,
		messages,
	};
}

export async function previewServiceDomain(
	input: PreviewServiceDomainInput,
): Promise<PreviewServiceDomainResult> {
	const warnings: string[] = [];
	const env = await findEnvironmentForDomain(input.environmentId);
	const platformApex = getPlatformDefaultDomain();

	let targetIp: string | null = null;
	let ipSource: "webServer" | "remoteServer" | null = null;
	try {
		targetIp = await resolveDomainTargetIp(input.serverId);
		ipSource = input.serverId ? "remoteServer" : "webServer";
	} catch {
		warnings.push("Could not resolve this service routing target yet.");
	}

	let mode: ServiceDomainMode = "none";
	let host: string | null = null;
	let zoneName: string | null = null;

	if (env.dnsZoneId) {
		const zone = await db.query.dnsZones.findFirst({
			where: eq(dnsZones.dnsZoneId, env.dnsZoneId),
		});
		if (zone) {
			zoneName = zone.name;
			if (zone.status !== "active") {
				warnings.push(
					`DNS zone "${zone.name}" needs setup before managed hostnames will resolve reliably.`,
				);
			}
			host = buildManagedServiceHost({
				serviceName: input.serviceName,
				zoneName: zone.name,
				environment: env,
			});
			mode = "org-zone";
		}
	} else if (platformApex) {
		host = buildPlatformDefaultServiceHost({
			serviceName: input.serviceName,
			projectName: env.project.name,
			environment: env,
		});
		zoneName = platformApex;
		mode = "platform";
	} else if (targetIp) {
		host = buildManagedPreviewHost({
			appName: input.serviceName,
			zoneName: "sslip.io",
			targetIp,
		});
		zoneName = "sslip.io";
		mode = "preview";
	} else {
		mode = "byod";
	}

	const visitUrl = host && mode !== "byod" ? `https://${host}` : null;

	return {
		mode,
		enabled: mode !== "none" && mode !== "byod",
		host,
		targetIp,
		ipSource,
		zoneName,
		platformApex,
		visitUrl,
		warnings,
	};
}

export async function provisionServiceDomain(
	input: ProvisionServiceDomainInput,
): Promise<Domain | null> {
	const env = await findEnvironmentForDomain(input.environmentId);
	const platformApex = getPlatformDefaultDomain();
	const path = input.path ?? "/";

	if (env.dnsZoneId) {
		const zone = await db.query.dnsZones.findFirst({
			where: eq(dnsZones.dnsZoneId, env.dnsZoneId),
		});
		if (!zone) {
			throw new TRPCError({ code: "NOT_FOUND", message: "DNS zone not found" });
		}
		const host = buildManagedServiceHost({
			serviceName: input.serviceName,
			zoneName: zone.name,
			environment: env,
		});
		const resolved = await resolveProvisionedHost({
			organizationId: env.project.organizationId,
			baseHost: host,
			provision: input,
		});
		if (resolved.existing) {
			return syncProvisionedDomain(input, resolved.existing, path);
		}
		const domain = await createDomain({
			host: resolved.host,
			port: input.port,
			path,
			https: true,
			certificateType: "letsencrypt",
			domainType: input.domainType,
			dnsZoneId: env.dnsZoneId,
			managedByNearzero: true,
			...(input.domainType === "application"
				? { applicationId: input.applicationId }
				: { composeId: input.composeId }),
		});
		return syncProvisionedDomain(input, domain, path);
	}

	if (platformApex) {
		const host = buildPlatformDefaultServiceHost({
			serviceName: input.serviceName,
			projectName: env.project.name,
			environment: env,
		});
		const resolved = await resolveProvisionedHost({
			organizationId: env.project.organizationId,
			baseHost: host,
			provision: input,
		});
		if (resolved.existing) {
			return syncProvisionedDomain(input, resolved.existing, path);
		}
		const domain = await createDomain({
			host: resolved.host,
			port: input.port,
			path,
			https: true,
			certificateType: "letsencrypt",
			domainType: input.domainType,
			...(input.domainType === "application"
				? { applicationId: input.applicationId }
				: { composeId: input.composeId }),
		});
		return syncProvisionedDomain(input, domain, path);
	}

	const targetIp = await resolveDomainTargetIp(input.serverId).catch(
		() => null,
	);
	if (!targetIp) {
		return null;
	}
	const host = buildManagedPreviewHost({
		appName: input.serviceName,
		zoneName: "sslip.io",
		targetIp,
	});
	const resolved = await resolveProvisionedHost({
		organizationId: env.project.organizationId,
		baseHost: host,
		provision: input,
	});
	if (resolved.existing) {
		return syncProvisionedDomain(input, resolved.existing, path);
	}
	const domain = await createDomain({
		host: resolved.host,
		port: input.port,
		path,
		https: true,
		certificateType: "letsencrypt",
		domainType: input.domainType,
		managedByNearzero: false,
		...(input.domainType === "application"
			? { applicationId: input.applicationId }
			: { composeId: input.composeId }),
	});
	return syncProvisionedDomain(input, domain, path);
}

export async function ensureDefaultServiceDomain(input: {
	serviceType: "application" | "compose";
	serviceId: string;
	port?: number;
	serverId?: string | null;
}): Promise<Domain | null> {
	const port = input.port ?? 3000;
	const existing =
		input.serviceType === "application"
			? await findDomainsByApplicationId(input.serviceId)
			: await findDomainsByComposeId(input.serviceId);
	if (existing.length > 0) {
		const domain = existing[0] ?? null;
		if (!domain) {
			return domain;
		}
		const updated =
			domain.port === port
				? domain
				: (await updateDomainById(domain.domainId, { port })) ?? domain;
		if (input.serviceType === "application") {
			const application = await findApplicationById(input.serviceId);
			await manageDomain(
				{
					...application,
					serverId: input.serverId ?? application.serverId,
				},
				updated,
			);
		}
		return updated;
	}

	if (input.serviceType === "application") {
		const application = await findApplicationById(input.serviceId);
		return provisionServiceDomain({
			environmentId: application.environmentId,
			serviceName: application.name,
			port,
			serverId: input.serverId ?? application.serverId,
			applicationId: input.serviceId,
			domainType: "application",
		});
	}

	const compose = await findComposeById(input.serviceId);
	return provisionServiceDomain({
		environmentId: compose.environmentId,
		serviceName: compose.name,
		port,
		serverId: compose.serverId,
		composeId: input.serviceId,
		domainType: "compose",
	});
}

export async function getManagedDnsReadiness(organizationId: string) {
	const settings = await getWebServerSettings();
	const zones = await checkDnsHealth(organizationId);
	const platformApex = getPlatformDefaultDomain();
	return {
		platformApex,
		platformDefaultEnabled: Boolean(platformApex),
		webServerIp: settings?.serverIp ?? null,
		zones,
	};
}

export { getDomainHost };
