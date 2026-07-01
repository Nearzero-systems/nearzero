import dns from "node:dns";
import { promisify } from "node:util";
import { db } from "@nearzero/server/db";
import { getWebServerSettings } from "@nearzero/server/services/web-server-settings";
import { generateRandomDomain } from "@nearzero/server/templates";
import { manageDomain } from "@nearzero/server/utils/traefik/domain";
import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import {
	type apiCreateDomain,
	applications,
	dnsZones,
	dnsRecords,
	domains,
	environments,
	previewDeployments,
} from "../db/schema";
import { publishDnsZone, upsertDnsRecord, deleteManagedDnsRecordForDomain } from "./dns";
import { resolveDomainTargetIp } from "./domain-target";
import { findApplicationById } from "./application";
import { detectCDNProvider } from "./cdn";
import { findServerById } from "./server";
import { findComposeById } from "./compose";

export type Domain = typeof domains.$inferSelect;

function normalizeDnsName(name: string) {
	return name.trim().toLowerCase().replace(/\.$/, "");
}

function managedRecordNameForHost(host: string, zoneName: string) {
	const normalizedHost = normalizeDnsName(host);
	const zone = normalizeDnsName(zoneName);
	if (normalizedHost === zone) return "@";
	if (normalizedHost.endsWith(`.${zone}`)) {
		return normalizedHost.slice(0, -(zone.length + 1)) || "@";
	}
	throw new TRPCError({
		code: "BAD_REQUEST",
		message: `Hostname ${normalizedHost} is not inside the selected DNS zone ${zone}`,
	});
}

async function resolveComposeDomainServiceName(
	composeId: string | undefined | null,
	requestedName?: string | null,
) {
	if (!composeId) return requestedName ?? undefined;
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

export async function syncManagedDnsRecordForDomain(
	domain: Domain,
	input?: Pick<
		z.infer<typeof apiCreateDomain>,
		| "applicationId"
		| "composeId"
		| "previewDeploymentId"
		| "dnsZoneId"
		| "managedByNearzero"
	> & {
		serverId?: string | null;
		managedBy?: "service-domain" | "preview-domain";
	},
) {
	const syncInput = {
		managedByNearzero: domain.managedByNearzero,
		dnsZoneId: domain.dnsZoneId ?? undefined,
		applicationId: domain.applicationId ?? undefined,
		composeId: domain.composeId ?? undefined,
		previewDeploymentId: domain.previewDeploymentId ?? undefined,
		...input,
	};
	if (!syncInput.managedByNearzero || !syncInput.dnsZoneId || !domain.host) {
		return domain;
	}

	let serverId = syncInput.serverId ?? undefined;
	let managedBy = syncInput.managedBy ?? "service-domain";
	if (!serverId && syncInput.applicationId) {
		serverId =
			(await findApplicationById(syncInput.applicationId)).serverId ?? undefined;
	} else if (!serverId && syncInput.composeId) {
		serverId = (await findComposeById(syncInput.composeId)).serverId ?? undefined;
	} else if (syncInput.previewDeploymentId) {
		managedBy = "preview-domain";
		if (!serverId) {
			const preview = await db.query.previewDeployments.findFirst({
				where: eq(previewDeployments.previewDeploymentId, syncInput.previewDeploymentId),
				with: {
					// Only serverId is needed. We must scope the columns: a bare
					// `application: true` makes Drizzle emit json_build_array(<every
					// application column>), and the application table has >100 columns,
					// which exceeds Postgres's hard 100-argument limit for
					// json_build_array ("cannot pass more than 100 arguments to a
					// function") and throws.
					application: { columns: { serverId: true } },
				},
			});
			serverId = preview?.application?.serverId ?? undefined;
		}
	}

	const targetIp = await resolveDomainTargetIp(serverId);
	const zone = await db.query.dnsZones.findFirst({
		where: eq(dnsZones.dnsZoneId, syncInput.dnsZoneId),
	});
	if (!zone) {
		throw new TRPCError({ code: "NOT_FOUND", message: "DNS zone not found" });
	}

	const relative = managedRecordNameForHost(domain.host, zone.name);

	const existingManagedRecord = domain.dnsRecordId
		? await db.query.dnsRecords.findFirst({
				where: eq(dnsRecords.dnsRecordId, domain.dnsRecordId),
			})
		: await db.query.dnsRecords.findFirst({
				where: eq(dnsRecords.domainId, domain.domainId),
			});

	const record = existingManagedRecord
		? await db
				.update(dnsRecords)
				.set({
					dnsZoneId: zone.dnsZoneId,
					name: relative || "@",
					type: "A",
					value: targetIp,
					managedBy,
					domainId: domain.domainId,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(dnsRecords.dnsRecordId, existingManagedRecord.dnsRecordId))
				.returning()
				.then((rows) => rows[0])
		: await upsertDnsRecord(zone.organizationId, {
				dnsZoneId: zone.dnsZoneId,
				name: relative || "@",
				type: "A",
				value: targetIp,
				managedBy,
				domainId: domain.domainId,
			});
	if (!record) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating managed DNS record",
		});
	}

	await db
		.update(domains)
		.set({ dnsRecordId: record.dnsRecordId })
		.where(eq(domains.domainId, domain.domainId));

	await publishDnsZone(zone.dnsZoneId, zone.organizationId);
	return { ...domain, dnsRecordId: record.dnsRecordId };
}

export const createDomain = async (input: z.infer<typeof apiCreateDomain>) => {
	if (input.managedByNearzero && !input.dnsZoneId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "dnsZoneId is required for Nearzero DNS mode",
		});
	}
	const serviceName =
		input.domainType === "compose" || input.composeId
			? await resolveComposeDomainServiceName(input.composeId, input.serviceName)
			: input.serviceName;

	const managedDefaults =
		input.managedByNearzero && input.dnsZoneId
			? {
					https: input.https ?? true,
					certificateType: input.certificateType ?? "letsencrypt",
				}
			: {};

	const result = await db.transaction(async (tx) => {
		let organizationId: string | undefined;
		let dnsMode: string = input.managedByNearzero ? "nearzero_managed" : "external";

		if (input.applicationId) {
			const app = await findApplicationById(input.applicationId);
			const env = await tx.query.environments.findFirst({
				where: eq(environments.environmentId, app.environmentId),
				with: { project: true },
			});
			organizationId = env?.project?.organizationId;
		} else if (input.composeId) {
			const comp = await findComposeById(input.composeId);
			const env = await tx.query.environments.findFirst({
				where: eq(environments.environmentId, comp.environmentId),
				with: { project: true },
			});
			organizationId = env?.project?.organizationId;
		} else if (input.previewDeploymentId) {
			const preview = await tx.query.previewDeployments.findFirst({
				where: eq(previewDeployments.previewDeploymentId, input.previewDeploymentId),
			});
			if (preview?.applicationId) {
				const app = await findApplicationById(preview.applicationId);
				const env = await tx.query.environments.findFirst({
					where: eq(environments.environmentId, app.environmentId),
					with: { project: true },
				});
				organizationId = env?.project?.organizationId;
			}
		}

		const domain = await tx
			.insert(domains)
			.values({
				...input,
				...managedDefaults,
				serviceName,
				host: input.host?.trim().toLowerCase(),
				organizationId,
				dnsMode,
			} as typeof domains.$inferInsert)
			.returning()
			.then((response) => response[0]);

		if (!domain) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error creating domain",
			});
		}

		if (domain.applicationId) {
			const application = await findApplicationById(domain.applicationId);
			await manageDomain(application, domain);
		}

		return domain;
	});

	if (result.managedByNearzero && result.dnsZoneId) {
		return syncManagedDnsRecordForDomain(result, input);
	}

	return result;
};

export const generateTraefikMeDomain = async (
	appName: string,
	_userId: string,
	serverId?: string,
) => {
	if (serverId) {
		const server = await findServerById(serverId);
		return generateRandomDomain({
			serverIp: server.ipAddress,
			projectName: appName,
		});
	}

	if (process.env.NODE_ENV === "development") {
		return generateRandomDomain({
			serverIp: "",
			projectName: appName,
		});
	}
	const settings = await getWebServerSettings();
	return generateRandomDomain({
		serverIp: settings?.serverIp || "",
		projectName: appName,
	});
};

export const generateWildcardDomain = (
	appName: string,
	serverDomain: string,
) => {
	return `${appName}-${serverDomain}`;
};

export const findDomainById = async (domainId: string) => {
	const domain = await db.query.domains.findFirst({
		where: eq(domains.domainId, domainId),
	});
	if (!domain) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Domain not found",
		});
	}
	// Attach the application as a plain root-select row instead of Drizzle's
	// relational include. The relational include would emit json_build_array over
	// every application column (>100), exceeding Postgres's 100-argument function
	// limit and throwing. Root selects are not affected by that limit, so this
	// preserves the same `{ ...domain, application }` shape safely.
	const application = domain.applicationId
		? ((await db.query.applications.findFirst({
				where: eq(applications.applicationId, domain.applicationId),
			})) ?? null)
		: null;
	return { ...domain, application };
};

export const findDomainByOrganizationAndHost = async (
	organizationId: string,
	host: string,
) => {
	const normalizedHost = host.trim().toLowerCase();
	return db.query.domains.findFirst({
		where: and(
			eq(domains.organizationId, organizationId),
			sql`lower(${domains.host}) = ${normalizedHost}`,
		),
	});
};

export const findDomainsByApplicationId = async (applicationId: string) => {
	// All returned domains belong to the same application, so fetch it once as a
	// plain row and attach it. We avoid `with: { application: true }` because the
	// application table has >100 columns and Drizzle's relational include emits
	// json_build_array(<all columns>), which exceeds Postgres's hard 100-argument
	// limit ("cannot pass more than 100 arguments to a function"). That failure
	// was silently breaking managed-domain (DNS) provisioning after deploy.
	const [domainsArray, application] = await Promise.all([
		db.query.domains.findMany({
			where: eq(domains.applicationId, applicationId),
		}),
		db.query.applications.findFirst({
			where: eq(applications.applicationId, applicationId),
		}),
	]);

	return domainsArray.map((domain) => ({
		...domain,
		application: application ?? null,
	}));
};

export const findDomainsByComposeId = async (composeId: string) => {
	const domainsArray = await db.query.domains.findMany({
		where: eq(domains.composeId, composeId),
		with: {
			compose: true,
		},
	});

	return domainsArray;
};

export const updateDomainById = async (
	domainId: string,
	domainData: Partial<Domain>,
) => {
	const domain = await db
		.update(domains)
		.set({
			...domainData,
			...(domainData.host && { host: domainData.host.trim().toLowerCase() }),
		})
		.where(eq(domains.domainId, domainId))
		.returning();

	return domain[0];
};

export const removeDomainById = async (domainId: string) => {
	const existing = await findDomainById(domainId);
	if (existing.managedByNearzero) {
		await deleteManagedDnsRecordForDomain(domainId);
	}
	const result = await db
		.delete(domains)
		.where(eq(domains.domainId, domainId))
		.returning();

	return result[0];
};

export const getDomainHost = (domain: Domain) => {
	return `${domain.https ? "https" : "http"}://${domain.host}`;
};

export async function resyncManagedDomainsForApplication(applicationId: string) {
	const domainsList = await findDomainsByApplicationId(applicationId);
	for (const row of domainsList) {
		if (row.managedByNearzero && row.dnsZoneId) {
			await syncManagedDnsRecordForDomain(row);
		}
	}
}

const resolveDns = promisify(dns.resolve4);

export const validateDomain = async (
	domain: string,
	expectedIp?: string,
): Promise<{
	isValid: boolean;
	resolvedIp?: string;
	error?: string;
	isCloudflare?: boolean;
	cdnProvider?: string;
}> => {
	try {
		// Remove protocol and path if present
		const cleanDomain = domain.replace(/^https?:\/\//, "").split("/")[0];

		// Resolve the domain to get its IP
		const ips = await resolveDns(cleanDomain || "");

		const resolvedIps = ips.map((ip) => ip.toString());

		// Check if any IP belongs to a CDN provider
		const cdnProvider = ips
			.map((ip) => detectCDNProvider(ip))
			.find((provider) => provider !== null);

		// If behind a CDN, we consider it valid but inform the user
		if (cdnProvider) {
			return {
				isValid: true,
				resolvedIp: resolvedIps.join(", "),
				cdnProvider: cdnProvider.displayName,
				error: cdnProvider.warningMessage,
			};
		}

		// If we have an expected IP, validate against it
		if (expectedIp) {
			return {
				isValid: resolvedIps.includes(expectedIp),
				resolvedIp: resolvedIps.join(", "),
				error: !resolvedIps.includes(expectedIp)
					? `Domain resolves to ${resolvedIps.join(", ")} but should point to ${expectedIp}`
					: undefined,
			};
		}

		// If no expected IP, just return the resolved IP
		return {
			isValid: true,
			resolvedIp: resolvedIps.join(", "),
		};
	} catch (error) {
		return {
			isValid: false,
			error:
				error instanceof Error ? error.message : "Failed to resolve domain",
		};
	}
};
