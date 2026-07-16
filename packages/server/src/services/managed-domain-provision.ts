import { db } from "@nearzero/server/db";
import { dnsZones, previewDeployments } from "@nearzero/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { normalizeDnsHostname } from "../utils/dns/zone-file";
import { serviceSpecReferencesNetwork } from "../utils/docker/utils";
import { getRemoteDocker } from "../utils/servers/remote-docker";
import {
	loadOrCreateConfig,
	loadOrCreateConfigRemote,
} from "../utils/traefik/application";
import { manageDomain } from "../utils/traefik/domain";
import { findApplicationById } from "./application";
import {
	findComposeById,
	reconcileComposeDomainRoutes,
	withComposeRoutingMutationLock,
} from "./compose";
import { checkDnsHealth, deleteManagedDnsRecordForDomain } from "./dns";
import {
	createDomain,
	type Domain,
	findDomainByHost,
	findDomainsByApplicationId,
	findDomainsByComposeId,
	getDomainHost,
	syncManagedDnsRecordForDomain,
	updateDomainById,
} from "./domain";
import { resolveDomainTargetIp } from "./domain-target";
import { findEnvironmentById, findEnvironmentForDomain } from "./environment";
import {
	buildManagedPreviewHost,
	buildManagedServiceHost,
	buildPreviewServiceSlug,
	canUsePlatformDomainForServer,
	isNearzeroAssignedDomain,
	platformDomainWildcardDnsHint,
	resolvePlatformDefaultDomain,
	slugifyServiceName,
} from "./managed-domain";
import { getWebServerSettings } from "./web-server-settings";

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
	deferComposeRouteReconciliation?: boolean;
	composeRoutingLockHeld?: boolean;
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
	return input.domainType === "application"
		? input.applicationId
		: input.composeId;
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
	baseHost: string;
	provision: ProvisionServiceDomainInput;
}) {
	const existing = await findDomainByHost(input.baseHost);
	if (
		!existing ||
		domainBelongsToProvisionedService(existing, input.provision)
	) {
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
		const conflict = await findDomainByHost(host);
		if (
			!conflict ||
			domainBelongsToProvisionedService(conflict, input.provision)
		) {
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
	managed?: {
		host?: string;
		dnsZoneId?: string | null;
		managedByNearzero: boolean;
		dnsMode: "external" | "nearzero_managed" | "platform";
		isSystemAssigned?: boolean;
	},
): Promise<Domain> {
	const update: Partial<Domain> = {};
	if (domain.port !== input.port) {
		update.port = input.port;
	}
	if ((domain.path ?? "/") !== path) {
		update.path = path;
	}
	if (managed) {
		if (managed.host && domain.host !== managed.host) {
			update.host = managed.host;
		}
		if (domain.managedByNearzero !== managed.managedByNearzero) {
			update.managedByNearzero = managed.managedByNearzero;
		}
		if ((domain.dnsZoneId ?? null) !== (managed.dnsZoneId ?? null)) {
			update.dnsZoneId = managed.dnsZoneId ?? null;
		}
		if (domain.dnsMode !== managed.dnsMode) update.dnsMode = managed.dnsMode;
		if (!domain.isSystemAssigned && managed.isSystemAssigned !== false) {
			update.isSystemAssigned = true;
		}
		if (managed.managedByNearzero) {
			if (!domain.https) update.https = true;
			if (domain.certificateType !== "letsencrypt") {
				update.certificateType = "letsencrypt";
			}
		}
	}

	const changed = Object.keys(update).length > 0;
	const composeBefore =
		input.domainType === "compose" && !input.deferComposeRouteReconciliation
			? await findComposeById(input.composeId)
			: null;
	const next = changed
		? ((await updateDomainById(domain.domainId, update, {
				allowPlatformHostnameChange: true,
			})) ?? domain)
		: domain;
	let composeRouteApplied = false;
	try {
		const routed = (await syncApplicationDomainRoute(input, next)) ?? next;
		if (composeBefore) {
			const reconciliation = await reconcileComposeDomainRoutes(
				composeBefore.composeId,
				[
					...composeBefore.domains.filter(
						(existing) => existing.domainId !== routed.domainId,
					),
					routed,
				],
			);
			composeRouteApplied = reconciliation.applied;
		}
		return await syncManagedDnsRecordForDomain(routed, {
			serverId: input.serverId,
		});
	} catch (error) {
		if (composeRouteApplied && composeBefore) {
			try {
				await reconcileComposeDomainRoutes(
					composeBefore.composeId,
					composeBefore.domains,
				);
			} catch (rollbackError) {
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message:
						"Managed domain update failed and its Compose route could not be rolled back; the domain record was retained for safe recovery",
					cause: new AggregateError(
						[error, rollbackError],
						"Compose domain route rollback failed",
					),
				});
			}
		}
		if (changed) {
			await updateDomainById(
				domain.domainId,
				{
					host: domain.host,
					port: domain.port,
					path: domain.path,
					https: domain.https,
					certificateType: domain.certificateType,
					dnsZoneId: domain.dnsZoneId,
					dnsRecordId: domain.dnsRecordId,
					managedByNearzero: domain.managedByNearzero,
					dnsMode: domain.dnsMode,
					isSystemAssigned: domain.isSystemAssigned,
				},
				{ allowPlatformHostnameChange: true },
			).catch(() => undefined);
		}
		await syncApplicationDomainRoute(input, domain).catch(() => undefined);
		if (domain.managedByNearzero && domain.dnsZoneId) {
			await syncManagedDnsRecordForDomain(domain, {
				serverId: input.serverId,
			}).catch(() => undefined);
		} else {
			await deleteManagedDnsRecordForDomain(domain.domainId).catch(
				() => undefined,
			);
		}
		throw error;
	}
}

function replaceWildcardHost(baseDomain: string, previewSlug: string) {
	const normalized = normalizeDnsHostname(baseDomain, {
		allowWildcard: true,
		requireFqdn: true,
	});
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
	const platformApex = await resolvePlatformDefaultDomain();
	const targetIp = await resolveDomainTargetIp(input.serverId).catch(
		() => null,
	);

	if (env.dnsZoneId) {
		const zone = await db.query.dnsZones.findFirst({
			where: and(
				eq(dnsZones.dnsZoneId, env.dnsZoneId),
				eq(dnsZones.organizationId, env.project.organizationId),
			),
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

	if (platformApex && canUsePlatformDomainForServer(input.serverId, platformApex)) {
		return {
			mode: "platform",
			host: buildManagedPreviewHost({
				appName: previewSlug,
				zoneName: platformApex,
				targetIp: targetIp ?? "",
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
		where: eq(
			previewDeployments.previewDeploymentId,
			input.previewDeploymentId,
		),
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
			isSystemAssigned: true,
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
	if (!domain.isSystemAssigned) update.isSystemAssigned = true;

	const next =
		Object.keys(update).length > 0
			? ((await updateDomainById(domain.domainId, update)) ?? domain)
			: domain;

	if (!preview.domainId) {
		await db
			.update(previewDeployments)
			.set({ domainId: next.domainId })
			.where(
				eq(previewDeployments.previewDeploymentId, input.previewDeploymentId),
			);
	}

	await manageDomain(
		{
			...application,
			appName: input.appName,
			serverId: input.serverId ?? application.serverId,
		},
		next,
	);
	return await syncManagedDnsRecordForDomain(next, {
		previewDeploymentId: input.previewDeploymentId,
		dnsZoneId: next.dnsZoneId ?? undefined,
		managedByNearzero: next.managedByNearzero,
		serverId: input.serverId,
		managedBy: "preview-domain",
	});
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
		messages.push("DNS needs setup: managed DNS record was not published yet.");
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
		const urls =
			service?.loadBalancer?.servers?.map((server) => server.url) ?? [];
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
		const [service, nearzeroNetwork] = await Promise.all([
			docker.getService(input.appName).inspect(),
			docker.getNetwork("nearzero-network").inspect(),
		]);
		networkOk = serviceSpecReferencesNetwork(service, nearzeroNetwork);
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
	const platformApex = await resolvePlatformDefaultDomain();

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
			where: and(
				eq(dnsZones.dnsZoneId, env.dnsZoneId),
				eq(dnsZones.organizationId, env.project.organizationId),
			),
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
	} else if (platformApex && canUsePlatformDomainForServer(input.serverId, platformApex)) {
		host = buildManagedServiceHost({
			serviceName: input.serviceName,
			zoneName: platformApex,
			environment: env,
		});
		zoneName = platformApex;
		mode = "platform";
		if (input.serverId && targetIp) {
			warnings.push(platformDomainWildcardDnsHint(platformApex, targetIp));
		}
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
	if (input.domainType === "compose" && !input.composeRoutingLockHeld) {
		return withComposeRoutingMutationLock(input.composeId, () =>
			provisionServiceDomain({ ...input, composeRoutingLockHeld: true }),
		);
	}
	const env = await findEnvironmentForDomain(input.environmentId);
	const platformApex = await resolvePlatformDefaultDomain();
	const path = input.path ?? "/";
	const attachedDomains =
		input.domainType === "application"
			? await findDomainsByApplicationId(input.applicationId)
			: await findDomainsByComposeId(input.composeId);
	const migratableFallback = attachedDomains.find(isNearzeroAssignedDomain);

	if (env.dnsZoneId) {
		const zone = await db.query.dnsZones.findFirst({
			where: and(
				eq(dnsZones.dnsZoneId, env.dnsZoneId),
				eq(dnsZones.organizationId, env.project.organizationId),
			),
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
			baseHost: host,
			provision: input,
		});
		if (resolved.existing) {
			return syncProvisionedDomain(input, resolved.existing, path, {
				host: resolved.host,
				dnsZoneId: zone.dnsZoneId,
				managedByNearzero: true,
				dnsMode: "nearzero_managed",
			});
		}
		if (migratableFallback) {
			return syncProvisionedDomain(input, migratableFallback, path, {
				host: resolved.host,
				dnsZoneId: zone.dnsZoneId,
				managedByNearzero: true,
				dnsMode: "nearzero_managed",
			});
		}
		const domain = await createDomain(
			{
				host: resolved.host,
				port: input.port,
				path,
				https: true,
				certificateType: "letsencrypt",
				domainType: input.domainType,
				dnsZoneId: env.dnsZoneId,
				managedByNearzero: true,
				isSystemAssigned: true,
				...(input.domainType === "application"
					? { applicationId: input.applicationId }
					: { composeId: input.composeId }),
			},
			{
				reconcileComposeRoute: !input.deferComposeRouteReconciliation,
				composeRoutingLockHeld: input.domainType === "compose",
			},
		);
		return domain;
	}

	if (platformApex && canUsePlatformDomainForServer(input.serverId, platformApex)) {
		const host = buildManagedServiceHost({
			serviceName: input.serviceName,
			zoneName: platformApex,
			environment: env,
		});
		const resolved = await resolveProvisionedHost({
			baseHost: host,
			provision: input,
		});
		if (resolved.existing) {
			return syncProvisionedDomain(input, resolved.existing, path, {
				host: resolved.host,
				managedByNearzero: false,
				dnsMode: "platform",
			});
		}
		if (migratableFallback) {
			return syncProvisionedDomain(input, migratableFallback, path, {
				host: resolved.host,
				managedByNearzero: false,
				dnsZoneId: null,
				dnsMode: "platform",
			});
		}
		const domain = await createDomain(
			{
				host: resolved.host,
				port: input.port,
				path,
				https: true,
				certificateType: "letsencrypt",
				domainType: input.domainType,
				dnsMode: "platform",
				isSystemAssigned: true,
				...(input.domainType === "application"
					? { applicationId: input.applicationId }
					: { composeId: input.composeId }),
			},
			{
				reconcileComposeRoute: !input.deferComposeRouteReconciliation,
				composeRoutingLockHeld: input.domainType === "compose",
			},
		);
		return domain;
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
		baseHost: host,
		provision: input,
	});
	if (resolved.existing) {
		return syncProvisionedDomain(input, resolved.existing, path, {
			host: resolved.host,
			managedByNearzero: false,
			dnsMode: "external",
		});
	}
	if (migratableFallback) {
		return syncProvisionedDomain(input, migratableFallback, path, {
			host: resolved.host,
			managedByNearzero: false,
			dnsZoneId: null,
			dnsMode: "external",
		});
	}
	const domain = await createDomain(
		{
			host: resolved.host,
			port: input.port,
			path,
			https: true,
			certificateType: "letsencrypt",
			domainType: input.domainType,
			managedByNearzero: false,
			isSystemAssigned: true,
			...(input.domainType === "application"
				? { applicationId: input.applicationId }
				: { composeId: input.composeId }),
		},
		{
			reconcileComposeRoute: !input.deferComposeRouteReconciliation,
			composeRoutingLockHeld: input.domainType === "compose",
		},
	);
	return domain;
}

export async function ensureDefaultServiceDomain(input: {
	serviceType: "application" | "compose";
	serviceId: string;
	port?: number;
	serverId?: string | null;
	deferComposeRouteReconciliation?: boolean;
	composeRoutingLockHeld?: boolean;
}): Promise<Domain | null> {
	if (input.serviceType === "compose" && !input.composeRoutingLockHeld) {
		return withComposeRoutingMutationLock(input.serviceId, () =>
			ensureDefaultServiceDomain({
				...input,
				composeRoutingLockHeld: true,
			}),
		);
	}
	const port = input.port ?? 3000;
	const existing =
		input.serviceType === "application"
			? await findDomainsByApplicationId(input.serviceId)
			: await findDomainsByComposeId(input.serviceId);
	if (existing.length > 0) {
		const migratableFallback = existing.find(isNearzeroAssignedDomain);
		if (migratableFallback) {
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
				serverId: input.serverId ?? compose.serverId,
				composeId: input.serviceId,
				domainType: "compose",
				deferComposeRouteReconciliation: input.deferComposeRouteReconciliation,
				composeRoutingLockHeld: input.composeRoutingLockHeld,
			});
		}
		const domain =
			existing.find((candidate) => candidate.managedByNearzero) ??
			existing[0] ??
			null;
		if (!domain) {
			return domain;
		}
		if (input.serviceType === "application") {
			const application = await findApplicationById(input.serviceId);
			return syncProvisionedDomain(
				{
					environmentId: application.environmentId,
					serviceName: application.name,
					port,
					serverId: input.serverId ?? application.serverId,
					applicationId: input.serviceId,
					domainType: "application",
				},
				domain,
				domain.path ?? "/",
			);
		}
		const compose = await findComposeById(input.serviceId);
		return syncProvisionedDomain(
			{
				environmentId: compose.environmentId,
				serviceName: compose.name,
				port,
				serverId: input.serverId ?? compose.serverId,
				composeId: input.serviceId,
				domainType: "compose",
				deferComposeRouteReconciliation: input.deferComposeRouteReconciliation,
				composeRoutingLockHeld: input.composeRoutingLockHeld,
			},
			domain,
			domain.path ?? "/",
		);
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
		serverId: input.serverId ?? compose.serverId,
		composeId: input.serviceId,
		domainType: "compose",
		deferComposeRouteReconciliation: input.deferComposeRouteReconciliation,
		composeRoutingLockHeld: input.composeRoutingLockHeld,
	});
}

export async function reconcileEnvironmentDefaultDomains(
	environmentId: string,
): Promise<{ attempted: number; updated: number; failed: number }> {
	const environment = await findEnvironmentById(environmentId);
	const services = [
		...environment.applications.map((application) => ({
			serviceType: "application" as const,
			serviceId: application.applicationId,
			serviceName: application.name,
			serverId: application.serverId,
			domains: application.domains,
		})),
		...environment.compose.map((compose) => ({
			serviceType: "compose" as const,
			serviceId: compose.composeId,
			serviceName: compose.name,
			serverId: compose.serverId,
			domains: compose.domains,
		})),
	];

	let attempted = 0;
	let updated = 0;
	let failed = 0;
	for (const service of services) {
		const assigned = service.domains.find(isNearzeroAssignedDomain);
		if (!assigned) continue;
		attempted += 1;
		try {
			const reconciled = await provisionServiceDomain({
				environmentId,
				serviceName:
					service.serviceType === "compose"
						? assigned.serviceName?.trim() || service.serviceName
						: service.serviceName,
				port: assigned.port ?? 3000,
				serverId: service.serverId,
				path: assigned.path ?? "/",
				...(service.serviceType === "application"
					? {
							applicationId: service.serviceId,
							domainType: "application" as const,
						}
					: {
							composeId: service.serviceId,
							domainType: "compose" as const,
						}),
			});
			if (reconciled) updated += 1;
			else failed += 1;
		} catch {
			// The environment binding is already durable. Report a count only; a
			// later ensure/deploy retries the same idempotent reconciliation without
			// exposing remote command or DNS provider errors through the API.
			failed += 1;
		}
	}

	return { attempted, updated, failed };
}

export async function getManagedDnsReadiness(organizationId: string) {
	const settings = await getWebServerSettings();
	const zones = await checkDnsHealth(organizationId);
	const platformApex = await resolvePlatformDefaultDomain();
	return {
		platformApex,
		platformDefaultEnabled: Boolean(platformApex),
		webServerIp: settings?.serverIp ?? null,
		zones,
	};
}

export { getDomainHost };
