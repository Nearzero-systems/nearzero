import dns from "node:dns";
import { promisify } from "node:util";
import { getPlatformDefaultDomain } from "@nearzero/server/constants";
import { db } from "@nearzero/server/db";
import { getWebServerSettings } from "@nearzero/server/services/web-server-settings";
import { generateRandomDomain } from "@nearzero/server/templates";
import { normalizeDnsHostname } from "@nearzero/server/utils/dns/zone-file";
import {
	manageDomain,
	removeDomain,
} from "@nearzero/server/utils/traefik/domain";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { z } from "zod";
import {
	type apiCreateDomain,
	applications,
	dnsRecords,
	dnsZones,
	domains,
	environments,
	previewDeployments,
} from "../db/schema";
import { findApplicationById } from "./application";
import { detectCDNProvider } from "./cdn";
import {
	findComposeById,
	reconcileComposeDomainRoutes,
	withComposeRoutingMutationLock,
	withDomainRoutingMutationLock,
} from "./compose";
import { deleteManagedDnsRecordForDomain, publishDnsZone } from "./dns";
import { resolveDomainTargetIp } from "./domain-target";
import { findServerById } from "./server";

const resolveDns = promisify(dns.resolve4);

export type Domain = typeof domains.$inferSelect;

function normalizeDnsName(name: string) {
	try {
		return normalizeDnsHostname(name);
	} catch (error) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: error instanceof Error ? error.message : "Invalid hostname",
			cause: error,
		});
	}
}

export function assertHostnameIsNotReservedForPlatform(
	host: string,
	dnsMode: "external" | "nearzero_managed" | "platform",
) {
	if (dnsMode === "platform") return;
	const configuredApex = getPlatformDefaultDomain();
	if (!configuredApex) return;
	const normalizedHost = normalizeDnsName(host);
	const platformApex = normalizeDnsName(configuredApex);
	if (
		normalizedHost === platformApex ||
		normalizedHost.endsWith(`.${platformApex}`)
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"This hostname is reserved for Nearzero's platform domain assignment",
		});
	}
}

export async function assertExternalDomainPointsToServer(
	host: string,
	serverId?: string | null,
) {
	const normalizedHost = normalizeDnsName(host);
	const expectedIp = await resolveDomainTargetIp(serverId);
	let resolvedIps: string[];
	try {
		resolvedIps = (await resolveDns(normalizedHost)).map(String);
	} catch (error) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: `Verify domain ownership first: ${normalizedHost} must resolve to ${expectedIp}`,
			cause: error,
		});
	}
	if (!resolvedIps.includes(expectedIp)) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: `Verify domain ownership first: ${normalizedHost} resolves elsewhere and must point to ${expectedIp} before Nearzero can publish its route`,
		});
	}
}

export function managedRecordNameForHost(host: string, zoneName: string) {
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
		await deleteManagedDnsRecordForDomain(domain.domainId);
		await db
			.update(domains)
			.set({ dnsRecordId: null })
			.where(eq(domains.domainId, domain.domainId));
		return { ...domain, dnsRecordId: null };
	}

	let serverId = syncInput.serverId ?? undefined;
	let managedBy = syncInput.managedBy ?? "service-domain";
	if (!serverId && syncInput.applicationId) {
		serverId =
			(await findApplicationById(syncInput.applicationId)).serverId ??
			undefined;
	} else if (!serverId && syncInput.composeId) {
		serverId =
			(await findComposeById(syncInput.composeId)).serverId ?? undefined;
	} else if (syncInput.previewDeploymentId) {
		managedBy = "preview-domain";
		if (!serverId) {
			const preview = await db.query.previewDeployments.findFirst({
				where: eq(
					previewDeployments.previewDeploymentId,
					syncInput.previewDeploymentId,
				),
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
	if (!domain.organizationId || zone.organizationId !== domain.organizationId) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message:
				"The selected DNS zone does not belong to this domain's organization",
		});
	}

	const relative = managedRecordNameForHost(domain.host, zone.name);
	const { record, affectedZoneIds, previousLinkedRecords } =
		await db.transaction(async (tx) => {
			await tx.execute(
				sql`select pg_advisory_xact_lock(hashtextextended(${`domain:${domain.domainId}`}, 0))`,
			);
			// Serialize every owner-level mutation with the same key used by the user
			// DNS record API. Without this lock, two transactions could both observe an
			// empty owner and publish conflicting address records.
			await tx.execute(
				sql`select pg_advisory_xact_lock(hashtextextended(${`${zone.dnsZoneId}:${relative || "@"}`}, 0))`,
			);
			const [linkedRecords, ownerRecords] = await Promise.all([
				tx.query.dnsRecords.findMany({
					where: eq(dnsRecords.domainId, domain.domainId),
				}),
				tx.query.dnsRecords.findMany({
					where: and(
						eq(dnsRecords.dnsZoneId, zone.dnsZoneId),
						eq(dnsRecords.name, relative || "@"),
					),
				}),
			]);
			const conflict = ownerRecords.find(
				(candidate) =>
					candidate.domainId !== domain.domainId &&
					(candidate.type === "A" ||
						candidate.type === "AAAA" ||
						candidate.type === "CNAME"),
			);
			if (conflict) {
				throw new TRPCError({
					code: "CONFLICT",
					message: `DNS address record already exists for ${domain.host}`,
				});
			}

			const preferred =
				linkedRecords.find(
					(candidate) => candidate.dnsRecordId === domain.dnsRecordId,
				) ?? linkedRecords[0];
			const nextRecord = preferred
				? await tx
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
						.where(eq(dnsRecords.dnsRecordId, preferred.dnsRecordId))
						.returning()
						.then((rows) => rows[0])
				: await tx
						.insert(dnsRecords)
						.values({
							dnsZoneId: zone.dnsZoneId,
							name: relative || "@",
							type: "A",
							value: targetIp,
							managedBy,
							domainId: domain.domainId,
						})
						.returning()
						.then((rows) => rows[0]);
			if (!nextRecord) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error creating managed DNS record",
				});
			}

			const staleIds = linkedRecords
				.filter((candidate) => candidate.dnsRecordId !== nextRecord.dnsRecordId)
				.map((candidate) => candidate.dnsRecordId);
			if (staleIds.length > 0) {
				await tx
					.delete(dnsRecords)
					.where(inArray(dnsRecords.dnsRecordId, staleIds));
			}
			await tx
				.update(domains)
				.set({ dnsRecordId: nextRecord.dnsRecordId })
				.where(eq(domains.domainId, domain.domainId));
			return {
				record: nextRecord,
				previousLinkedRecords: linkedRecords,
				affectedZoneIds: Array.from(
					new Set([
						...linkedRecords.map((candidate) => candidate.dnsZoneId),
						zone.dnsZoneId,
					]),
				),
			};
		});
	if (!record) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating managed DNS record",
		});
	}

	let firstPublishError: unknown;
	for (const dnsZoneId of affectedZoneIds) {
		const affectedZone = await db.query.dnsZones.findFirst({
			where: eq(dnsZones.dnsZoneId, dnsZoneId),
		});
		if (!affectedZone) continue;
		try {
			await publishDnsZone(affectedZone.dnsZoneId, affectedZone.organizationId);
		} catch (error) {
			firstPublishError ??= error;
		}
	}
	if (firstPublishError) {
		await db.transaction(async (tx) => {
			await tx
				.delete(dnsRecords)
				.where(eq(dnsRecords.domainId, domain.domainId));
			if (previousLinkedRecords.length > 0) {
				await tx.insert(dnsRecords).values(previousLinkedRecords);
			}
			await tx
				.update(domains)
				.set({ dnsRecordId: domain.dnsRecordId })
				.where(eq(domains.domainId, domain.domainId));
		});
		for (const dnsZoneId of affectedZoneIds) {
			const affectedZone = await db.query.dnsZones.findFirst({
				where: eq(dnsZones.dnsZoneId, dnsZoneId),
			});
			if (affectedZone) {
				await publishDnsZone(
					affectedZone.dnsZoneId,
					affectedZone.organizationId,
				).catch(() => undefined);
			}
		}
		throw firstPublishError;
	}
	return { ...domain, dnsRecordId: record.dnsRecordId };
}

type CreateDomainInput = z.infer<typeof apiCreateDomain> & {
	dnsMode?: "external" | "nearzero_managed" | "platform";
	isSystemAssigned?: boolean;
};

type CreateDomainOptions = {
	reconcileComposeRoute?: boolean;
	composeRoutingLockHeld?: boolean;
};

export const createDomain = async (
	input: CreateDomainInput,
	options: CreateDomainOptions = {},
): Promise<Domain> => {
	if (input.composeId && !options.composeRoutingLockHeld) {
		return withComposeRoutingMutationLock(input.composeId, () =>
			createDomain(input, { ...options, composeRoutingLockHeld: true }),
		);
	}
	if (input.managedByNearzero && !input.dnsZoneId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "dnsZoneId is required for Nearzero DNS mode",
		});
	}
	const attachmentCount = [
		input.applicationId,
		input.composeId,
		input.previewDeploymentId,
	].filter(Boolean).length;
	if (attachmentCount !== 1) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"A domain must belong to exactly one application, compose service, or preview",
		});
	}
	const host = normalizeDnsName(input.host);
	const serviceName =
		input.domainType === "compose" || input.composeId
			? await resolveComposeDomainServiceName(
					input.composeId,
					input.serviceName,
				)
			: input.serviceName;

	const managedDefaults =
		input.managedByNearzero && input.dnsZoneId
			? {
					https: input.https ?? true,
					certificateType: input.certificateType ?? "letsencrypt",
				}
			: {};

	let environmentId: string | undefined;
	let routeServerId: string | null | undefined;
	let applicationForRoute: Awaited<
		ReturnType<typeof findApplicationById>
	> | null = null;
	let composeForRoute: Awaited<ReturnType<typeof findComposeById>> | null =
		null;
	if (input.applicationId) {
		applicationForRoute = await findApplicationById(input.applicationId);
		environmentId = applicationForRoute.environmentId;
		routeServerId = applicationForRoute.serverId;
	} else if (input.composeId) {
		composeForRoute = await findComposeById(input.composeId);
		environmentId = composeForRoute.environmentId;
		routeServerId = composeForRoute.serverId;
	} else if (input.previewDeploymentId) {
		const preview = await db.query.previewDeployments.findFirst({
			where: eq(
				previewDeployments.previewDeploymentId,
				input.previewDeploymentId,
			),
		});
		if (!preview?.applicationId) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "Preview deployment not found",
			});
		}
		const previewApplication = await findApplicationById(preview.applicationId);
		environmentId = previewApplication.environmentId;
		routeServerId = previewApplication.serverId;
	}
	const environment = environmentId
		? await db.query.environments.findFirst({
				where: eq(environments.environmentId, environmentId),
				with: { project: true },
			})
		: null;
	const organizationId = environment?.project?.organizationId;
	if (!organizationId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Could not determine the domain organization",
		});
	}
	if (input.dnsZoneId) {
		const zone = await db.query.dnsZones.findFirst({
			where: eq(dnsZones.dnsZoneId, input.dnsZoneId),
		});
		if (!zone || zone.organizationId !== organizationId) {
			throw new TRPCError({
				code: "FORBIDDEN",
				message:
					"The selected DNS zone does not belong to this domain's organization",
			});
		}
		managedRecordNameForHost(host, zone.name);
	}
	const conflictingDomain = await findDomainByHost(host);
	if (conflictingDomain) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "This hostname is already claimed in this Nearzero installation",
		});
	}

	const { dnsMode: requestedDnsMode, ...domainInput } = input;
	const dnsMode =
		requestedDnsMode ??
		(input.managedByNearzero ? "nearzero_managed" : "external");
	assertHostnameIsNotReservedForPlatform(host, dnsMode);
	if (dnsMode === "external" && !input.managedByNearzero) {
		await assertExternalDomainPointsToServer(host, routeServerId);
	}
	const result = await db.transaction(async (tx) => {
		const domain = await tx
			.insert(domains)
			.values({
				...domainInput,
				...managedDefaults,
				serviceName,
				host,
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

		return domain;
	});

	let composeRouteApplied = false;
	try {
		if (applicationForRoute) {
			await manageDomain(applicationForRoute, result);
		}
		if (composeForRoute && options.reconcileComposeRoute !== false) {
			const reconciliation = await reconcileComposeDomainRoutes(
				composeForRoute.composeId,
				[
					...composeForRoute.domains.filter(
						(domain) => domain.domainId !== result.domainId,
					),
					result,
				],
			);
			composeRouteApplied = reconciliation.applied;
		}
		if (result.managedByNearzero && result.dnsZoneId) {
			return await syncManagedDnsRecordForDomain(result, input);
		}
		return result;
	} catch (error) {
		let cleanupFailed = false;
		if (applicationForRoute) {
			await removeDomain(applicationForRoute, result.uniqueConfigKey).catch(
				() => {
					cleanupFailed = true;
				},
			);
		}
		if (composeRouteApplied && composeForRoute) {
			await reconcileComposeDomainRoutes(
				composeForRoute.composeId,
				composeForRoute.domains,
			).catch(() => {
				cleanupFailed = true;
			});
		}
		await deleteManagedDnsRecordForDomain(result.domainId).catch(() => {
			cleanupFailed = true;
		});
		// Keep the database row when remote rollback fails. Losing the row would
		// make the still-published route or DNS record impossible to discover and
		// clean up safely on retry.
		if (!cleanupFailed) {
			await db.delete(domains).where(eq(domains.domainId, result.domainId));
		}
		throw error;
	}
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
	const normalizedHost = normalizeDnsName(host);
	return db.query.domains.findFirst({
		where: and(
			eq(domains.organizationId, organizationId),
			sql`lower(${domains.host}) = ${normalizedHost}`,
		),
	});
};

export const findDomainByHost = async (host: string) => {
	const normalizedHost = normalizeDnsName(host);
	return db.query.domains.findFirst({
		where: sql`lower(${domains.host}) = ${normalizedHost}`,
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

export const findDomainsByPreviewDeploymentIds = async (
	previewDeploymentIds: string[],
) => {
	if (previewDeploymentIds.length === 0) return [];
	return db.query.domains.findMany({
		where: inArray(domains.previewDeploymentId, previewDeploymentIds),
	});
};

export const updateDomainById = async (
	domainId: string,
	domainData: Partial<Domain>,
	options: { allowPlatformHostnameChange?: boolean } = {},
) => {
	const safeDomainData = { ...domainData };
	delete safeDomainData.domainId;
	const current = await findDomainById(domainId);
	const normalizedHost = safeDomainData.host
		? normalizeDnsName(safeDomainData.host)
		: undefined;
	const hostChanged = Boolean(
		normalizedHost && normalizedHost !== current.host,
	);
	const desiredDnsModeValue = safeDomainData.dnsMode ?? current.dnsMode;
	if (
		desiredDnsModeValue !== "external" &&
		desiredDnsModeValue !== "nearzero_managed" &&
		desiredDnsModeValue !== "platform"
	) {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: "Domain has an unsupported DNS mode",
		});
	}
	const desiredDnsMode = desiredDnsModeValue;
	if (normalizedHost) {
		assertHostnameIsNotReservedForPlatform(normalizedHost, desiredDnsMode);
	}
	if (
		hostChanged &&
		desiredDnsMode === "platform" &&
		!options.allowPlatformHostnameChange
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"Platform-assigned hostnames cannot be changed manually; configure an external or Nearzero-managed domain instead",
		});
	}
	if (normalizedHost && current.organizationId) {
		const conflict = await findDomainByHost(normalizedHost);
		if (conflict && conflict.domainId !== domainId) {
			throw new TRPCError({
				code: "CONFLICT",
				message:
					"This hostname is already claimed in this Nearzero installation",
			});
		}
	}
	const desiredZoneId =
		safeDomainData.dnsZoneId === undefined
			? current.dnsZoneId
			: safeDomainData.dnsZoneId;
	if (desiredZoneId) {
		const zone = await db.query.dnsZones.findFirst({
			where: eq(dnsZones.dnsZoneId, desiredZoneId),
		});
		if (
			!zone ||
			!current.organizationId ||
			zone.organizationId !== current.organizationId
		) {
			throw new TRPCError({
				code: "FORBIDDEN",
				message:
					"The selected DNS zone does not belong to this domain's organization",
			});
		}
		managedRecordNameForHost(normalizedHost ?? current.host, zone.name);
	}
	if (hostChanged && normalizedHost && desiredDnsMode === "external") {
		let routeServerId: string | null | undefined;
		if (current.applicationId) {
			routeServerId = (await findApplicationById(current.applicationId))
				.serverId;
		} else if (current.composeId) {
			routeServerId = (await findComposeById(current.composeId)).serverId;
		} else if (current.previewDeploymentId) {
			const preview = await db.query.previewDeployments.findFirst({
				where: eq(
					previewDeployments.previewDeploymentId,
					current.previewDeploymentId,
				),
			});
			if (preview?.applicationId) {
				routeServerId = (await findApplicationById(preview.applicationId))
					.serverId;
			}
		}
		if (
			!current.applicationId &&
			!current.composeId &&
			!current.previewDeploymentId
		) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message:
					"Assign this external domain to a service before changing its hostname",
			});
		}
		await assertExternalDomainPointsToServer(normalizedHost, routeServerId);
	}
	const domain = await db
		.update(domains)
		.set({
			...safeDomainData,
			...(normalizedHost && { host: normalizedHost }),
		})
		.where(eq(domains.domainId, domainId))
		.returning();

	return domain[0];
};

const removeDomainByIdUnlocked = async (domainId: string) => {
	const existing = await findDomainById(domainId);
	let application = existing.applicationId
		? await findApplicationById(existing.applicationId)
		: null;
	const composeService = existing.composeId
		? await findComposeById(existing.composeId)
		: null;
	if (!application && existing.previewDeploymentId) {
		const preview = await db.query.previewDeployments.findFirst({
			where: eq(
				previewDeployments.previewDeploymentId,
				existing.previewDeploymentId,
			),
		});
		if (preview?.applicationId) {
			application = await findApplicationById(preview.applicationId);
			application.appName = preview.appName;
		}
	}
	let routeRemoved = false;
	let composeRouteApplied = false;
	let dnsRemoved = false;
	try {
		if (application) {
			await removeDomain(application, existing.uniqueConfigKey);
			routeRemoved = true;
		}
		if (composeService) {
			const result = await reconcileComposeDomainRoutes(
				composeService.composeId,
				composeService.domains.filter(
					(domain) => domain.domainId !== existing.domainId,
				),
			);
			composeRouteApplied = result.applied;
		}
		await deleteManagedDnsRecordForDomain(domainId);
		dnsRemoved = Boolean(existing.managedByNearzero && existing.dnsZoneId);
		const result = await db
			.delete(domains)
			.where(eq(domains.domainId, domainId))
			.returning();

		return result[0];
	} catch (error) {
		if (routeRemoved && application) {
			await manageDomain(application, existing).catch(() => undefined);
		}
		if (composeRouteApplied && composeService) {
			await reconcileComposeDomainRoutes(
				composeService.composeId,
				composeService.domains,
			).catch(() => undefined);
		}
		if (dnsRemoved && existing.managedByNearzero && existing.dnsZoneId) {
			await syncManagedDnsRecordForDomain(existing).catch(() => undefined);
		}
		throw error;
	}
};

export const removeDomainById = (domainId: string) =>
	withDomainRoutingMutationLock(domainId, null, () =>
		removeDomainByIdUnlocked(domainId),
	);

export const getDomainHost = (domain: Domain) => {
	return `${domain.https ? "https" : "http"}://${domain.host}`;
};

export async function resyncManagedDomainsForApplication(
	applicationId: string,
) {
	const domainsList = await findDomainsByApplicationId(applicationId);
	for (const row of domainsList) {
		if (row.managedByNearzero && row.dnsZoneId) {
			await syncManagedDnsRecordForDomain(row);
		}
	}
}

export async function resyncManagedDomainsForCompose(composeId: string) {
	const domainsList = await findDomainsByComposeId(composeId);
	for (const row of domainsList) {
		if (row.managedByNearzero && row.dnsZoneId) {
			await syncManagedDnsRecordForDomain(row);
		}
	}
}

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

		// A CDN address cannot prove that the caller controls the origin target. A
		// future TXT verification flow can support proxied records without weakening
		// this check; until then, require a direct record during route assignment.
		if (cdnProvider) {
			if (expectedIp && !resolvedIps.includes(expectedIp)) {
				return {
					isValid: false,
					resolvedIp: resolvedIps.join(", "),
					cdnProvider: cdnProvider.displayName,
					error: `Temporarily disable the DNS proxy and point this hostname to ${expectedIp} so Nearzero can verify control before publishing the route`,
				};
			}
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
