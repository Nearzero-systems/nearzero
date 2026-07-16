import { db } from "@nearzero/server/db";
import {
	applications,
	compose,
	dnsZones,
	domains,
	environments,
	projects,
} from "@nearzero/server/db/schema";
import {
	manageDomain,
	removeDomain,
} from "@nearzero/server/utils/traefik/domain";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { normalizeDnsHostname } from "../utils/dns/zone-file";
import { findApplicationById } from "./application";
import {
	findComposeById,
	reconcileComposeDomainRoutes,
	withDomainRoutingMutationLock,
} from "./compose";
import { rethrowUnlessSchemaDrift } from "./db-schema-error";
import { deleteManagedDnsRecordForDomain } from "./dns";
import {
	assertExternalDomainPointsToServer,
	assertHostnameIsNotReservedForPlatform,
	type Domain,
	findDomainByHost,
	findDomainById,
	managedRecordNameForHost,
	syncManagedDnsRecordForDomain,
} from "./domain";
import { provisionServiceDomain } from "./managed-domain-provision";
import { findMemberByUserId } from "./permission";

export type CentralizedDomainRow = {
	domainId: string;
	host: string;
	https: boolean;
	dnsMode: string;
	managedByNearzero: boolean;
	dnsZoneId: string | null;
	dnsRecordId: string | null;
	domainType: string | null;
	serviceName: string | null;
	applicationId: string | null;
	composeId: string | null;
	previewDeploymentId: string | null;
	projectId: string | null;
	projectName: string | null;
	environmentId: string | null;
	environmentName: string | null;
	serviceLabel: string | null;
	serviceType: "application" | "compose" | null;
	href: string | null;
	status: "unassigned" | "ready" | "pending_dns";
};

export type EnvironmentDnsBindingRow = {
	environmentId: string;
	environmentName: string;
	projectId: string;
	projectName: string;
	dnsZoneId: string | null;
	zoneName: string | null;
	domainPrefix: string | null;
};

async function getAccessedServices(
	userId: string,
	organizationId: string,
	userRole: string,
): Promise<string[] | null> {
	if (userRole === "owner" || userRole === "admin") return null;
	const { accessedServices } = await findMemberByUserId(userId, organizationId);
	return accessedServices;
}

function domainStatus(row: Domain): CentralizedDomainRow["status"] {
	if (row.previewDeploymentId) return "ready";
	if (!row.applicationId && !row.composeId) return "unassigned";
	if (row.managedByNearzero && !row.dnsRecordId) return "pending_dns";
	return "ready";
}

async function resolveComposeDomainServiceName(
	composeId: string,
	requestedName?: string,
) {
	const requested = requestedName?.trim() ?? "";
	const { loadServices } = await import("./compose");
	const services = await loadServices(composeId, "cache").catch(
		() => [] as string[],
	);
	if (requested && services.includes(requested)) return requested;
	if (services.length === 1) return services[0] as string;
	if (requested && services.length === 0) return requested;
	throw new TRPCError({
		code: "BAD_REQUEST",
		message:
			services.length > 0
				? `Select a compose service for this domain (${services.join(", ")})`
				: "serviceName is required for compose domains",
	});
}

export async function listCentralizedDomains(
	organizationId: string,
	userId: string,
	userRole: string,
): Promise<CentralizedDomainRow[]> {
	try {
		const accessedServices = await getAccessedServices(
			userId,
			organizationId,
			userRole,
		);

		const rows = await db.query.domains.findMany({
			where: and(isNull(domains.previewDeploymentId)),
			with: {
				application: {
					with: {
						environment: {
							with: { project: true },
						},
					},
				},
				compose: {
					with: {
						environment: {
							with: { project: true },
						},
					},
				},
			},
			orderBy: [asc(domains.host)],
		});

		const result: CentralizedDomainRow[] = [];

		for (const row of rows) {
			const app = row.application;
			const comp = row.compose;
			const serviceId = row.applicationId ?? row.composeId;

			const rowOrgId =
				row.organizationId ??
				app?.environment?.project?.organizationId ??
				comp?.environment?.project?.organizationId;
			if (rowOrgId !== organizationId) continue;

			if (accessedServices !== null) {
				const isLibrary = !serviceId;
				if (!isLibrary && serviceId && !accessedServices.includes(serviceId)) {
					continue;
				}
			}

			let projectId: string | null = null;
			let projectName: string | null = null;
			let environmentId: string | null = null;
			let environmentName: string | null = null;
			let serviceLabel: string | null = null;
			let serviceType: "application" | "compose" | null = null;
			let href: string | null = null;

			if (app?.environment?.project) {
				projectId = app.environment.project.projectId;
				projectName = app.environment.project.name;
				environmentId = app.environment.environmentId;
				environmentName = app.environment.name;
				serviceLabel = app.name;
				serviceType = "application";
				href = `/dashboard/project/${projectId}/environment/${environmentId}/services/application/${app.applicationId}`;
			} else if (comp?.environment?.project) {
				projectId = comp.environment.project.projectId;
				projectName = comp.environment.project.name;
				environmentId = comp.environment.environmentId;
				environmentName = comp.environment.name;
				serviceLabel = comp.name;
				serviceType = "compose";
				href = `/dashboard/project/${projectId}/environment/${environmentId}/services/compose/${comp.composeId}`;
			}

			result.push({
				domainId: row.domainId,
				host: row.host,
				https: row.https,
				dnsMode: row.dnsMode ?? "external",
				managedByNearzero: row.managedByNearzero,
				dnsZoneId: row.dnsZoneId,
				dnsRecordId: row.dnsRecordId,
				domainType: row.domainType,
				serviceName: row.serviceName,
				applicationId: row.applicationId,
				composeId: row.composeId,
				previewDeploymentId: row.previewDeploymentId,
				projectId,
				projectName,
				environmentId,
				environmentName,
				serviceLabel,
				serviceType,
				href,
				status: domainStatus(row),
			});
		}

		return result;
	} catch (error) {
		rethrowUnlessSchemaDrift(error, "Domain hostnames");
	}
}

export async function registerDomain(
	organizationId: string,
	input: {
		host: string;
		dnsMode?: "external" | "nearzero_managed";
		https?: boolean;
		certificateType?: "letsencrypt" | "none" | "custom";
		customCertResolver?: string;
		dnsZoneId?: string;
		serverId?: string | null;
	},
) {
	if ((input as { dnsMode?: string }).dnsMode === "platform") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"Platform domains are assigned by Nearzero and cannot be registered manually",
		});
	}
	let host: string;
	try {
		host = normalizeDnsHostname(input.host);
	} catch (error) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: error instanceof Error ? error.message : "Invalid hostname",
			cause: error,
		});
	}
	const dnsMode = input.dnsMode ?? "external";
	assertHostnameIsNotReservedForPlatform(host, dnsMode);
	const managedByNearzero = dnsMode === "nearzero_managed";
	if (dnsMode === "external" && input.serverId === undefined) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"Select the server this external hostname points to before registering it",
		});
	}

	if (managedByNearzero && !input.dnsZoneId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "dnsZoneId is required for Nearzero DNS mode",
		});
	}
	if (!managedByNearzero && input.dnsZoneId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "dnsZoneId is only valid for Nearzero-managed DNS",
		});
	}
	if (input.dnsZoneId) {
		const zone = await db.query.dnsZones.findFirst({
			where: and(
				eq(dnsZones.dnsZoneId, input.dnsZoneId),
				eq(dnsZones.organizationId, organizationId),
			),
		});
		if (!zone) {
			throw new TRPCError({ code: "NOT_FOUND", message: "DNS zone not found" });
		}
		managedRecordNameForHost(host, zone.name);
	}
	if (dnsMode === "external") {
		await assertExternalDomainPointsToServer(host, input.serverId);
	}

	const existing = await findDomainByHost(host);
	if (existing) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "This hostname is already claimed in this Nearzero installation",
		});
	}

	const [created] = await db
		.insert(domains)
		.values({
			host,
			organizationId,
			dnsMode,
			managedByNearzero,
			dnsZoneId: input.dnsZoneId ?? null,
			https: input.https ?? dnsMode !== "external",
			certificateType:
				input.certificateType ??
				(dnsMode === "external" ? "none" : "letsencrypt"),
			customCertResolver: input.customCertResolver,
		})
		.returning();

	if (!created) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Failed to register hostname",
		});
	}

	return created;
}

type AssignDomainToServiceInput = {
	domainId: string;
	applicationId?: string;
	composeId?: string;
	serviceName?: string;
	port?: number;
	path?: string;
	https?: boolean;
	certificateType?: "letsencrypt" | "none" | "custom";
};

async function assignDomainToServiceUnlocked(
	input: AssignDomainToServiceInput,
) {
	const domain = await findDomainById(input.domainId);
	if (domain.previewDeploymentId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Preview domains cannot be reassigned from the library",
		});
	}

	if (
		Number(Boolean(input.applicationId)) + Number(Boolean(input.composeId)) !==
		1
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Choose exactly one application or compose service",
		});
	}

	const port = input.port ?? domain.port ?? 3000;
	const path = input.path ?? domain.path ?? "/";
	const https = input.https ?? domain.https;
	const oldApplication = domain.applicationId
		? await findApplicationById(domain.applicationId)
		: null;
	const targetApplication = input.applicationId
		? await findApplicationById(input.applicationId)
		: null;
	const targetCompose = input.composeId
		? await findComposeById(input.composeId)
		: null;
	const oldCompose = domain.composeId
		? await findComposeById(domain.composeId)
		: null;
	const targetOrganizationId =
		targetApplication?.environment.project.organizationId ??
		targetCompose?.environment.project.organizationId;
	if (
		!domain.organizationId ||
		targetOrganizationId !== domain.organizationId
	) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "A domain cannot be assigned across organizations",
		});
	}
	const serviceName = input.composeId
		? await resolveComposeDomainServiceName(input.composeId, input.serviceName)
		: null;
	const update = {
		applicationId: input.applicationId ?? null,
		composeId: input.composeId ?? null,
		domainType: input.applicationId
			? ("application" as const)
			: ("compose" as const),
		serviceName,
		port,
		path,
		https,
		certificateType: input.certificateType ?? domain.certificateType,
	};
	const candidate = { ...domain, ...update };
	let newRouteWritten = false;
	let oldRouteRemoved = false;
	let targetComposeRouteApplied = false;
	let oldComposeRouteApplied = false;
	let databaseUpdated = false;

	try {
		if (domain.dnsMode === "external" && !domain.managedByNearzero) {
			await assertExternalDomainPointsToServer(
				domain.host,
				targetApplication?.serverId ?? targetCompose?.serverId,
			);
		}
		if (targetApplication) {
			await manageDomain(targetApplication, candidate);
			newRouteWritten = true;
		}
		if (targetCompose) {
			const result = await reconcileComposeDomainRoutes(
				targetCompose.composeId,
				[
					...targetCompose.domains.filter(
						(existing) => existing.domainId !== domain.domainId,
					),
					candidate,
				],
			);
			targetComposeRouteApplied = result.applied;
		}
		if (
			oldApplication &&
			oldApplication.applicationId !== targetApplication?.applicationId
		) {
			await removeDomain(oldApplication, domain.uniqueConfigKey);
			oldRouteRemoved = true;
		}
		if (oldCompose && oldCompose.composeId !== targetCompose?.composeId) {
			const result = await reconcileComposeDomainRoutes(
				oldCompose.composeId,
				oldCompose.domains.filter(
					(existing) => existing.domainId !== domain.domainId,
				),
			);
			oldComposeRouteApplied = result.applied;
		}

		const [updated] = await db
			.update(domains)
			.set(update)
			.where(eq(domains.domainId, input.domainId))
			.returning();
		if (!updated) {
			throw new TRPCError({ code: "NOT_FOUND", message: "Domain not found" });
		}
		databaseUpdated = true;

		if (updated.managedByNearzero && updated.dnsZoneId) {
			return await syncManagedDnsRecordForDomain(updated);
		}
		return updated;
	} catch (error) {
		if (databaseUpdated) {
			await db
				.update(domains)
				.set({
					applicationId: domain.applicationId,
					composeId: domain.composeId,
					domainType: domain.domainType,
					serviceName: domain.serviceName,
					port: domain.port,
					path: domain.path,
					https: domain.https,
					certificateType: domain.certificateType,
					dnsRecordId: domain.dnsRecordId,
				})
				.where(eq(domains.domainId, domain.domainId))
				.catch(() => undefined);
		}
		if (newRouteWritten && targetApplication) {
			if (targetApplication.applicationId === oldApplication?.applicationId) {
				await manageDomain(oldApplication, domain).catch(() => undefined);
			} else {
				await removeDomain(targetApplication, domain.uniqueConfigKey).catch(
					() => undefined,
				);
			}
		}
		if (oldRouteRemoved && oldApplication) {
			await manageDomain(oldApplication, domain).catch(() => undefined);
		}
		if (targetComposeRouteApplied && targetCompose) {
			await reconcileComposeDomainRoutes(
				targetCompose.composeId,
				targetCompose.domains,
			).catch(() => undefined);
		}
		if (oldComposeRouteApplied && oldCompose) {
			await reconcileComposeDomainRoutes(
				oldCompose.composeId,
				oldCompose.domains,
			).catch(() => undefined);
		}
		if (domain.managedByNearzero && domain.dnsZoneId) {
			if (domain.applicationId || domain.composeId) {
				await syncManagedDnsRecordForDomain(domain).catch(() => undefined);
			} else {
				await deleteManagedDnsRecordForDomain(domain.domainId).catch(
					() => undefined,
				);
			}
		}
		throw error;
	}
}

export function assignDomainToService(input: AssignDomainToServiceInput) {
	return withDomainRoutingMutationLock(input.domainId, input.composeId, () =>
		assignDomainToServiceUnlocked(input),
	);
}

async function unassignDomainUnlocked(domainId: string) {
	const domain = await findDomainById(domainId);
	if (domain.previewDeploymentId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Preview domains cannot be unassigned",
		});
	}

	const application = domain.applicationId
		? await findApplicationById(domain.applicationId)
		: null;
	const composeService = domain.composeId
		? await findComposeById(domain.composeId)
		: null;
	let routeRemoved = false;
	let composeRouteApplied = false;
	let dnsRemoved = false;
	try {
		if (application) {
			await removeDomain(application, domain.uniqueConfigKey);
			routeRemoved = true;
		}
		if (composeService) {
			const result = await reconcileComposeDomainRoutes(
				composeService.composeId,
				composeService.domains.filter(
					(existing) => existing.domainId !== domain.domainId,
				),
			);
			composeRouteApplied = result.applied;
		}
		if (domain.managedByNearzero) {
			await deleteManagedDnsRecordForDomain(domainId);
			dnsRemoved = true;
		}

		const [updated] = await db
			.update(domains)
			.set({
				applicationId: null,
				composeId: null,
				serviceName: null,
				domainType: null,
				dnsRecordId: null,
			})
			.where(eq(domains.domainId, domainId))
			.returning();
		if (!updated) {
			throw new TRPCError({ code: "NOT_FOUND", message: "Domain not found" });
		}
		return updated;
	} catch (error) {
		if (routeRemoved && application) {
			await manageDomain(application, domain).catch(() => undefined);
		}
		if (composeRouteApplied && composeService) {
			await reconcileComposeDomainRoutes(
				composeService.composeId,
				composeService.domains,
			).catch(() => undefined);
		}
		if (dnsRemoved && domain.managedByNearzero && domain.dnsZoneId) {
			await syncManagedDnsRecordForDomain(domain).catch(() => undefined);
		}
		throw error;
	}
}

export function unassignDomain(domainId: string) {
	return withDomainRoutingMutationLock(domainId, null, () =>
		unassignDomainUnlocked(domainId),
	);
}

export async function generateSubdomainForService(input: {
	environmentId: string;
	serviceName: string;
	port: number;
	serverId?: string | null;
	path?: string;
	applicationId?: string;
	composeId?: string;
	domainType: "application" | "compose";
}) {
	const serviceId = input.applicationId ?? input.composeId;
	if (!serviceId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "applicationId or composeId is required",
		});
	}

	if (input.domainType === "application" && input.applicationId) {
		return provisionServiceDomain({
			environmentId: input.environmentId,
			serviceName: input.serviceName,
			port: input.port,
			serverId: input.serverId,
			path: input.path,
			applicationId: input.applicationId,
			domainType: "application",
		});
	}

	if (input.domainType === "compose" && input.composeId) {
		return provisionServiceDomain({
			environmentId: input.environmentId,
			serviceName: input.serviceName,
			port: input.port,
			serverId: input.serverId,
			path: input.path,
			composeId: input.composeId,
			domainType: "compose",
		});
	}

	return null;
}

export async function listEnvironmentDnsBindings(
	organizationId: string,
	userId: string,
	userRole: string,
): Promise<EnvironmentDnsBindingRow[]> {
	try {
		const accessedServices = await getAccessedServices(
			userId,
			organizationId,
			userRole,
		);

		const envFilter = eq(projects.organizationId, organizationId);

		const rows = await db
			.select({
				environmentId: environments.environmentId,
				environmentName: environments.name,
				projectId: projects.projectId,
				projectName: projects.name,
				dnsZoneId: environments.dnsZoneId,
				domainPrefix: environments.domainPrefix,
				zoneName: dnsZones.name,
			})
			.from(environments)
			.innerJoin(projects, eq(environments.projectId, projects.projectId))
			.leftJoin(dnsZones, eq(environments.dnsZoneId, dnsZones.dnsZoneId))
			.where(envFilter)
			.orderBy(asc(projects.name), asc(environments.name));

		if (accessedServices !== null) {
			if (accessedServices.length === 0) return [];
			const [appEnvIds, composeEnvIds] = await Promise.all([
				db
					.selectDistinct({ environmentId: applications.environmentId })
					.from(applications)
					.where(inArray(applications.applicationId, accessedServices)),
				db
					.selectDistinct({ environmentId: compose.environmentId })
					.from(compose)
					.where(inArray(compose.composeId, accessedServices)),
			]);
			const allowed = new Set(
				[...appEnvIds, ...composeEnvIds].map((r) => r.environmentId),
			);
			return rows
				.filter((row) => allowed.has(row.environmentId))
				.map((row) => ({
					environmentId: row.environmentId,
					environmentName: row.environmentName,
					projectId: row.projectId,
					projectName: row.projectName,
					dnsZoneId: row.dnsZoneId,
					zoneName: row.zoneName,
					domainPrefix: row.domainPrefix,
				}));
		}

		return rows.map((row) => ({
			environmentId: row.environmentId,
			environmentName: row.environmentName,
			projectId: row.projectId,
			projectName: row.projectName,
			dnsZoneId: row.dnsZoneId,
			zoneName: row.zoneName,
			domainPrefix: row.domainPrefix,
		}));
	} catch (error) {
		rethrowUnlessSchemaDrift(error, "Environment DNS bindings");
	}
}
