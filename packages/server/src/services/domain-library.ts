import { db } from "@nearzero/server/db";
import { dnsZones, domains, environments, projects, applications, compose } from "@nearzero/server/db/schema";
import { manageDomain, removeDomain } from "@nearzero/server/utils/traefik/domain";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { findApplicationById } from "./application";
import { findComposeById } from "./compose";
import {
	findDomainById,
	syncManagedDnsRecordForDomain,
	type Domain,
} from "./domain";
import { deleteManagedDnsRecordForDomain } from "./dns";
import { findMemberByUserId } from "./permission";
import { provisionServiceDomain } from "./managed-domain-provision";

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
	const services = await loadServices(composeId, "cache").catch(() => [] as string[]);
	if (requested && services.includes(requested)) return requested;
	if (services.length === 1) return services[0];
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
}

export async function registerDomain(
	organizationId: string,
	input: {
		host: string;
		dnsMode?: "external" | "nearzero_managed" | "platform";
		https?: boolean;
		certificateType?: "letsencrypt" | "none" | "custom";
		customCertResolver?: string;
		dnsZoneId?: string;
	},
) {
	const host = input.host.trim().toLowerCase();
	const dnsMode = input.dnsMode ?? "external";
	const managedByNearzero = dnsMode === "nearzero_managed";

	if (managedByNearzero && !input.dnsZoneId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "dnsZoneId is required for Nearzero DNS mode",
		});
	}

	const existing = await db.query.domains.findFirst({
		where: and(
			eq(domains.organizationId, organizationId),
			eq(domains.host, host),
		),
	});
	if (existing) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "A hostname with this name already exists in your organization",
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
			https: input.https ?? false,
			certificateType: input.certificateType ?? "none",
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

export async function assignDomainToService(input: {
	domainId: string;
	applicationId?: string;
	composeId?: string;
	serviceName?: string;
	port?: number;
	path?: string;
	https?: boolean;
	certificateType?: "letsencrypt" | "none" | "custom";
}) {
	const domain = await findDomainById(input.domainId);
	if (domain.previewDeploymentId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Preview domains cannot be reassigned from the library",
		});
	}

	const port = input.port ?? domain.port ?? 3000;
	const path = input.path ?? domain.path ?? "/";
	const https = input.https ?? domain.https;

	if (input.applicationId) {
		const application = await findApplicationById(input.applicationId);
		const [updated] = await db
			.update(domains)
			.set({
				applicationId: input.applicationId,
				composeId: null,
				domainType: "application",
				serviceName: null,
				port,
				path,
				https,
				certificateType: input.certificateType ?? domain.certificateType,
			})
			.where(eq(domains.domainId, input.domainId))
			.returning();

		if (!updated) {
			throw new TRPCError({ code: "NOT_FOUND", message: "Domain not found" });
		}

		await manageDomain(application, updated);
		if (updated.managedByNearzero && updated.dnsZoneId) {
			return syncManagedDnsRecordForDomain(updated);
		}
		return updated;
	}

	if (input.composeId) {
		await findComposeById(input.composeId);
		const serviceName = await resolveComposeDomainServiceName(
			input.composeId,
			input.serviceName,
		);
		const [updated] = await db
			.update(domains)
			.set({
				composeId: input.composeId,
				applicationId: null,
				domainType: "compose",
				serviceName,
				port,
				path,
				https,
				certificateType: input.certificateType ?? domain.certificateType,
			})
			.where(eq(domains.domainId, input.domainId))
			.returning();

		if (!updated) {
			throw new TRPCError({ code: "NOT_FOUND", message: "Domain not found" });
		}

		if (updated.managedByNearzero && updated.dnsZoneId) {
			return syncManagedDnsRecordForDomain(updated);
		}
		return updated;
	}

	throw new TRPCError({
		code: "BAD_REQUEST",
		message: "applicationId or composeId is required",
	});
}

export async function unassignDomain(domainId: string) {
	const domain = await findDomainById(domainId);
	if (domain.previewDeploymentId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Preview domains cannot be unassigned",
		});
	}

	if (domain.applicationId) {
		const application = await findApplicationById(domain.applicationId);
		await removeDomain(application, domain.uniqueConfigKey);
	}

	if (domain.managedByNearzero) {
		await deleteManagedDnsRecordForDomain(domainId);
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

	return updated;
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
	const accessedServices = await getAccessedServices(
		userId,
		organizationId,
		userRole,
	);

	let envFilter = eq(projects.organizationId, organizationId);

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
}
