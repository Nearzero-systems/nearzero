import {
	createDomain,
	findApplicationById,
	findComposeById,
	findDomainById,
	findDomainsByApplicationId,
	findDomainsByComposeId,
	findEnvironmentById,
	findPreviewDeploymentById,
	generateTraefikMeDomain,
	manageDomain,
	previewServiceDomain,
	provisionServiceDomain,
	reconcileComposeDomainRoutes,
	removeDomainById,
	resolveDomainTargetIp,
	syncManagedDnsRecordForDomain,
	updateDomainById,
	validateDomain,
	withDomainRoutingMutationLock,
} from "@nearzero/server";
import { domain as domainInput } from "@nearzero/server/db/validations/domain";
import {
	checkEnvironmentAccess,
	checkPermission,
	checkServicePermissionAndAccess,
} from "@nearzero/server/services/permission";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
	createTRPCRouter,
	protectedProcedure,
	withPermission,
} from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import { assertRuntimePlacement } from "@/server/api/utils/runtime-policy";
import {
	apiCreateDomain,
	apiFindCompose,
	apiFindDomain,
	apiFindOneApplication,
	apiUpdateDomain,
} from "@/server/db/schema";

async function resolveDomainServicePlacement(input: {
	applicationId?: string | null;
	composeId?: string | null;
	serverId?: string | null;
	serviceName?: string | null;
}) {
	if (input.applicationId && input.composeId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"A domain can target either an application or a compose service, not both",
		});
	}
	if (input.applicationId) {
		const application = await findApplicationById(input.applicationId);
		if (
			input.serverId &&
			application.serverId &&
			input.serverId !== application.serverId
		) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "The selected server does not match the application's server",
			});
		}
		return {
			serverId: application.serverId ?? input.serverId ?? null,
			resourceId: application.applicationId,
			resourceName: input.serviceName || application.appName,
			serviceType: "application",
			environmentId: application.environmentId,
			organizationId: application.environment.project.organizationId,
		};
	}
	if (input.composeId) {
		const compose = await findComposeById(input.composeId);
		if (
			input.serverId &&
			compose.serverId &&
			input.serverId !== compose.serverId
		) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message:
					"The selected server does not match the compose service's server",
			});
		}
		return {
			serverId: compose.serverId ?? input.serverId ?? null,
			resourceId: compose.composeId,
			resourceName: input.serviceName || compose.appName || compose.name,
			serviceType: "compose",
			environmentId: compose.environmentId,
			organizationId: compose.environment.project.organizationId,
		};
	}
	return {
		serverId: input.serverId ?? null,
		resourceId: undefined,
		resourceName: input.serviceName ?? undefined,
		serviceType: undefined,
		environmentId: undefined,
		organizationId: undefined,
	};
}

type DomainRouterContext = Parameters<typeof checkPermission>[0];
type DomainAction = "read" | "create" | "update" | "delete";

function assertOrganizationAccess(
	ctx: DomainRouterContext,
	organizationId: string | null | undefined,
) {
	if (!organizationId || organizationId !== ctx.session.activeOrganizationId) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "You are not allowed to access this domain resource",
		});
	}
}

async function assertDomainAccess(
	ctx: DomainRouterContext,
	domain: Awaited<ReturnType<typeof findDomainById>>,
	action: DomainAction,
) {
	if (domain.applicationId) {
		const application = await findApplicationById(domain.applicationId);
		assertOrganizationAccess(
			ctx,
			application.environment.project.organizationId,
		);
		await checkServicePermissionAndAccess(ctx, domain.applicationId, {
			domain: [action],
		});
		return;
	}
	if (domain.composeId) {
		const compose = await findComposeById(domain.composeId);
		assertOrganizationAccess(ctx, compose.environment.project.organizationId);
		await checkServicePermissionAndAccess(ctx, domain.composeId, {
			domain: [action],
		});
		return;
	}
	if (domain.previewDeploymentId) {
		const preview = await findPreviewDeploymentById(domain.previewDeploymentId);
		const application = await findApplicationById(preview.applicationId);
		assertOrganizationAccess(
			ctx,
			application.environment.project.organizationId,
		);
		await checkServicePermissionAndAccess(ctx, preview.applicationId, {
			domain: [action],
		});
		return;
	}

	assertOrganizationAccess(ctx, domain.organizationId);
	await checkPermission(ctx, { domain: [action] });
}

function assertServiceEnvironment(
	requestedEnvironmentId: string,
	actualEnvironmentId: string | undefined,
) {
	if (!actualEnvironmentId || requestedEnvironmentId !== actualEnvironmentId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "The selected environment does not contain this service",
		});
	}
}

export const domainRouter = createTRPCRouter({
	create: protectedProcedure
		.input(apiCreateDomain)
		.mutation(async ({ input, ctx }) => {
			try {
				const targetCount =
					Number(!!input.applicationId) + Number(!!input.composeId);
				if (targetCount !== 1) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message:
							"Choose exactly one application or compose service for this domain",
					});
				}
				if (input.composeId) {
					if (input.domainType && input.domainType !== "compose") {
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: "domainType must match the selected compose service",
						});
					}
					await checkServicePermissionAndAccess(ctx, input.composeId, {
						domain: ["create"],
					});
				} else if (input.applicationId) {
					if (input.domainType && input.domainType !== "application") {
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: "domainType must match the selected application",
						});
					}
					await checkServicePermissionAndAccess(ctx, input.applicationId, {
						domain: ["create"],
					});
				}
				const placement = await resolveDomainServicePlacement(input);
				assertOrganizationAccess(ctx, placement.organizationId);
				await assertRuntimePlacement(ctx, "domain.assign", {
					serverId: placement.serverId,
					resourceType: "domain",
					resourceId: placement.resourceId,
					resourceName: input.host,
					serviceType: placement.serviceType,
					environmentId: placement.environmentId,
					auditMetadata: {
						host: input.host,
						domainType: input.domainType,
					},
				});
				const domain = await createDomain(input);
				await audit(ctx, {
					action: "create",
					resourceType: "domain",
					resourceId: domain.domainId,
					resourceName: domain.host,
				});
				return domain;
			} catch (error) {
				if (error instanceof TRPCError) throw error;
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						error instanceof Error
							? error.message
							: "Error creating the domain",
					cause: error,
				});
			}
		}),
	byApplicationId: protectedProcedure
		.input(apiFindOneApplication)
		.query(async ({ input, ctx }) => {
			const application = await findApplicationById(input.applicationId);
			assertOrganizationAccess(
				ctx,
				application.environment.project.organizationId,
			);
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				domain: ["read"],
			});
			return await findDomainsByApplicationId(input.applicationId);
		}),
	byComposeId: protectedProcedure
		.input(apiFindCompose)
		.query(async ({ input, ctx }) => {
			const compose = await findComposeById(input.composeId);
			assertOrganizationAccess(ctx, compose.environment.project.organizationId);
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				domain: ["read"],
			});
			return await findDomainsByComposeId(input.composeId);
		}),
	generateDomain: withPermission("domain", "create")
		.input(
			z.object({
				appName: z.string().trim().min(1).max(128),
				serverId: z.string().min(1).optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			await assertRuntimePlacement(ctx, "domain.assign", {
				serverId: input.serverId ?? null,
				resourceType: "domain",
				resourceName: input.appName,
			});
			return generateTraefikMeDomain(
				input.appName,
				ctx.user.ownerId,
				input.serverId,
			);
		}),
	canGenerateTraefikMeDomains: withPermission("domain", "read")
		.input(z.object({ serverId: z.string().optional() }))
		.query(async ({ input, ctx }) => {
			try {
				await assertRuntimePlacement(ctx, "domain.assign", {
					serverId: input.serverId ?? null,
					resourceType: "domain",
				});
				return await resolveDomainTargetIp(input.serverId);
			} catch {
				return "";
			}
		}),

	previewServiceDomain: protectedProcedure
		.input(
			z.object({
				environmentId: z.string().min(1),
				serviceName: z.string().min(1),
				serverId: z.string().optional().nullable(),
			}),
		)
		.query(async ({ input, ctx }) => {
			await checkEnvironmentAccess(ctx, input.environmentId, "read");
			const environment = await findEnvironmentById(input.environmentId);
			assertOrganizationAccess(ctx, environment.project.organizationId);
			await assertRuntimePlacement(ctx, "domain.assign", {
				serverId: input.serverId ?? null,
				resourceType: "domain",
				resourceName: input.serviceName,
				environmentId: input.environmentId,
			});
			return previewServiceDomain({
				environmentId: input.environmentId,
				serviceName: input.serviceName,
				serverId: input.serverId,
			});
		}),

	provisionServiceDomain: protectedProcedure
		.input(
			z.object({
				environmentId: z.string().min(1),
				serviceName: z.string().min(1),
				port: z.number().int().min(1).max(65535).default(3000),
				serverId: z.string().optional().nullable(),
				path: domainInput.shape.path,
				domainType: z.enum(["application", "compose"]),
				applicationId: z.string().optional(),
				composeId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const serviceId = input.applicationId || input.composeId;
			if (!serviceId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "applicationId or composeId is required",
				});
			}
			await checkServicePermissionAndAccess(ctx, serviceId, {
				domain: ["create"],
			});
			if (
				(input.domainType === "application" && !input.applicationId) ||
				(input.domainType === "compose" && !input.composeId) ||
				(input.applicationId && input.composeId)
			) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "domainType must match exactly one selected service",
				});
			}
			const placement = await resolveDomainServicePlacement(input);
			assertOrganizationAccess(ctx, placement.organizationId);
			assertServiceEnvironment(input.environmentId, placement.environmentId);
			await assertRuntimePlacement(ctx, "domain.assign", {
				serverId: placement.serverId,
				resourceType: "domain",
				resourceId: serviceId,
				resourceName: input.serviceName,
				serviceType: placement.serviceType,
				environmentId: input.environmentId,
				auditMetadata: {
					domainType: input.domainType,
					path: input.path,
				},
			});
			if (input.domainType === "application" && input.applicationId) {
				const domain = await provisionServiceDomain({
					environmentId: input.environmentId,
					serviceName: input.serviceName,
					port: input.port,
					serverId: placement.serverId,
					path: input.path,
					applicationId: input.applicationId,
					domainType: "application",
				});
				if (!domain) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message:
							"No managed DNS zone or platform default domain is configured for this environment",
					});
				}
				await audit(ctx, {
					action: "create",
					resourceType: "domain",
					resourceId: domain.domainId,
					resourceName: domain.host,
					metadata: {
						source: "provisionServiceDomain",
						environmentId: input.environmentId,
						serviceId,
						domainType: input.domainType,
					},
				});
				return domain;
			}
			if (input.domainType === "compose" && input.composeId) {
				const domain = await provisionServiceDomain({
					environmentId: input.environmentId,
					serviceName: input.serviceName,
					port: input.port,
					serverId: placement.serverId,
					path: input.path,
					composeId: input.composeId,
					domainType: "compose",
				});
				if (!domain) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message:
							"No managed DNS zone or platform default domain is configured for this environment",
					});
				}
				await audit(ctx, {
					action: "create",
					resourceType: "domain",
					resourceId: domain.domainId,
					resourceName: domain.host,
					metadata: {
						source: "provisionServiceDomain",
						environmentId: input.environmentId,
						serviceId,
						domainType: input.domainType,
					},
				});
				return domain;
			}
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Invalid domain provision input",
			});
		}),

	update: protectedProcedure
		.input(apiUpdateDomain)
		.mutation(async ({ input, ctx }) => {
			const initialDomain = await findDomainById(input.domainId);
			await assertDomainAccess(ctx, initialDomain, "update");
			if (
				initialDomain.dnsMode === "platform" &&
				input.host !== initialDomain.host
			) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						"Platform-assigned hostnames cannot be changed manually; add an external or Nearzero-managed domain instead",
				});
			}

			return withDomainRoutingMutationLock(
				input.domainId,
				initialDomain.composeId,
				async () => {
					const currentDomain = await findDomainById(input.domainId);
					const composeBefore = currentDomain.composeId
						? await findComposeById(currentDomain.composeId)
						: null;
					let applicationRouteMutationAttempted = false;
					let composeRouteApplied = false;
					try {
						const result = await updateDomainById(input.domainId, {
							...input,
							isSystemAssigned:
								input.host !== currentDomain.host
									? false
									: currentDomain.isSystemAssigned,
						});
						const domain = await findDomainById(input.domainId);
						if (domain.applicationId) {
							applicationRouteMutationAttempted = true;
							const application = await findApplicationById(
								domain.applicationId,
							);
							await manageDomain(application, domain);
						} else if (domain.composeId && composeBefore) {
							const reconciliation = await reconcileComposeDomainRoutes(
								domain.composeId,
								[
									...composeBefore.domains.filter(
										(existing) => existing.domainId !== domain.domainId,
									),
									domain,
								],
							);
							composeRouteApplied = reconciliation.applied;
						} else if (domain.previewDeploymentId) {
							applicationRouteMutationAttempted = true;
							const previewDeployment = await findPreviewDeploymentById(
								domain.previewDeploymentId,
							);
							const application = await findApplicationById(
								previewDeployment.applicationId,
							);
							application.appName = previewDeployment.appName;
							await manageDomain(application, domain);
						}
						if (domain.managedByNearzero && domain.dnsZoneId) {
							await syncManagedDnsRecordForDomain(domain);
						}
						await audit(ctx, {
							action: "update",
							resourceType: "domain",
							resourceId: domain.domainId,
							resourceName: domain.host,
						});
						return result;
					} catch (error) {
						let routeRollbackError: unknown;
						if (
							applicationRouteMutationAttempted &&
							currentDomain.applicationId
						) {
							const application = await findApplicationById(
								currentDomain.applicationId,
							);
							await manageDomain(application, currentDomain).catch(
								(rollbackError) => {
									routeRollbackError = rollbackError;
								},
							);
						} else if (composeRouteApplied && composeBefore) {
							await reconcileComposeDomainRoutes(
								composeBefore.composeId,
								composeBefore.domains,
							).catch((rollbackError) => {
								routeRollbackError = rollbackError;
							});
						} else if (
							applicationRouteMutationAttempted &&
							currentDomain.previewDeploymentId
						) {
							const preview = await findPreviewDeploymentById(
								currentDomain.previewDeploymentId,
							);
							const application = await findApplicationById(
								preview.applicationId,
							);
							application.appName = preview.appName;
							await manageDomain(application, currentDomain).catch(
								(rollbackError) => {
									routeRollbackError = rollbackError;
								},
							);
						}

						if (routeRollbackError) {
							throw new TRPCError({
								code: "INTERNAL_SERVER_ERROR",
								message:
									"Domain update failed and its route could not be rolled back; the domain record was retained for safe recovery",
								cause: new AggregateError(
									[error, routeRollbackError],
									"Domain route rollback failed",
								),
							});
						}

						await updateDomainById(
							input.domainId,
							{
								host: currentDomain.host,
								path: currentDomain.path,
								port: currentDomain.port,
								customEntrypoint: currentDomain.customEntrypoint,
								https: currentDomain.https,
								certificateType: currentDomain.certificateType,
								customCertResolver: currentDomain.customCertResolver,
								serviceName: currentDomain.serviceName,
								domainType: currentDomain.domainType,
								internalPath: currentDomain.internalPath,
								stripPath: currentDomain.stripPath,
								middlewares: currentDomain.middlewares,
								dnsRecordId: currentDomain.dnsRecordId,
								isSystemAssigned: currentDomain.isSystemAssigned,
							},
							{ allowPlatformHostnameChange: true },
						);
						if (currentDomain.managedByNearzero && currentDomain.dnsZoneId) {
							await syncManagedDnsRecordForDomain(currentDomain);
						}
						throw error;
					}
				},
			);
		}),
	one: protectedProcedure.input(apiFindDomain).query(async ({ input, ctx }) => {
		const domain = await findDomainById(input.domainId);
		await assertDomainAccess(ctx, domain, "read");
		return domain;
	}),
	delete: protectedProcedure
		.input(apiFindDomain)
		.mutation(async ({ input, ctx }) => {
			const domain = await findDomainById(input.domainId);
			await assertDomainAccess(ctx, domain, "delete");

			const result = await removeDomainById(input.domainId);
			await audit(ctx, {
				action: "delete",
				resourceType: "domain",
				resourceId: domain.domainId,
				resourceName: domain.host,
			});

			return result;
		}),

	validateDomain: withPermission("domain", "read")
		.input(
			z.object({
				domain: z.string(),
				serverIp: z.string().optional(),
			}),
		)
		.mutation(async ({ input }) => {
			return validateDomain(input.domain, input.serverIp);
		}),

	listCentralized: withPermission("domain", "read").query(async ({ ctx }) => {
		const { listCentralizedDomains } = await import(
			"@nearzero/server/services/domain-library"
		);
		return listCentralizedDomains(
			ctx.session.activeOrganizationId,
			ctx.user.id,
			ctx.user.role,
		);
	}),

	/** Platform apex for Domains hub (does not require dns.read). */
	platformInfo: withPermission("domain", "read").query(async () => {
		const { resolvePlatformDefaultDomain } = await import(
			"@nearzero/server/services/managed-domain"
		);
		const { getWebServerSettings } = await import(
			"@nearzero/server/services/web-server-settings"
		);
		const { resolveDefaultManagedNameservers } = await import(
			"@nearzero/server/utils/dns/default-nameservers"
		);
		const platformApex = await resolvePlatformDefaultDomain();
		const settings = await getWebServerSettings();
		const defaultNameservers = platformApex
			? resolveDefaultManagedNameservers({
					zoneName: platformApex,
					platformApex,
				})
			: [];
		return {
			platformApex,
			enabled: Boolean(platformApex),
			webServerIp: settings?.serverIp ?? null,
			defaultNameservers,
		};
	}),

	register: withPermission("domain", "create")
		.input(
			z.object({
				host: domainInput.shape.host,
				dnsMode: z.enum(["external", "nearzero_managed"]).default("external"),
				https: z.boolean().optional(),
				certificateType: z.enum(["letsencrypt", "none", "custom"]).optional(),
				customCertResolver: z.string().optional(),
				dnsZoneId: z.string().optional(),
				serverId: z.string().optional().nullable(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			if (input.dnsMode === "external" && input.serverId === undefined) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						"Select the server this external hostname points to before registering it",
				});
			}
			await assertRuntimePlacement(ctx, "domain.assign", {
				serverId:
					input.dnsMode === "external" ? (input.serverId ?? null) : null,
				allowAnyReadyServer: input.dnsMode !== "external",
				resourceType: "domain",
				resourceName: input.host,
				auditMetadata: { source: "register", dnsMode: input.dnsMode },
			});
			const { registerDomain } = await import(
				"@nearzero/server/services/domain-library"
			);
			const domain = await registerDomain(
				ctx.session.activeOrganizationId,
				input,
			);
			await audit(ctx, {
				action: "create",
				resourceType: "domain",
				resourceId: domain.domainId,
				resourceName: domain.host,
				metadata: { source: "register", dnsMode: input.dnsMode },
			});
			return domain;
		}),

	assignToService: withPermission("domain", "update")
		.input(
			z.object({
				domainId: z.string().min(1),
				applicationId: z.string().optional(),
				composeId: z.string().optional(),
				serviceName: z.string().optional(),
				port: z.number().int().min(1).max(65535).optional(),
				path: domainInput.shape.path,
				https: z.boolean().optional(),
				certificateType: z.enum(["letsencrypt", "none", "custom"]).optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const currentDomain = await findDomainById(input.domainId);
			await assertDomainAccess(ctx, currentDomain, "update");
			if (Number(!!input.applicationId) + Number(!!input.composeId) !== 1) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Choose exactly one application or compose service",
				});
			}
			const serviceId = input.applicationId || input.composeId;
			if (serviceId) {
				await checkServicePermissionAndAccess(ctx, serviceId, {
					domain: ["create"],
				});
			}
			const placement = await resolveDomainServicePlacement(input);
			assertOrganizationAccess(ctx, placement.organizationId);
			assertOrganizationAccess(ctx, currentDomain.organizationId);
			if (currentDomain.organizationId !== placement.organizationId) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "A domain cannot be assigned across organizations",
				});
			}
			await assertRuntimePlacement(ctx, "domain.assign", {
				serverId: placement.serverId,
				resourceType: "domain",
				resourceId: input.domainId,
				resourceName: input.serviceName,
				serviceType: placement.serviceType,
				environmentId: placement.environmentId,
				auditMetadata: {
					applicationId: input.applicationId,
					composeId: input.composeId,
				},
			});
			const { assignDomainToService } = await import(
				"@nearzero/server/services/domain-library"
			);
			const domain = await assignDomainToService(input);
			await audit(ctx, {
				action: "update",
				resourceType: "domain",
				resourceId: domain.domainId,
				resourceName: domain.host,
				metadata: { source: "assignToService" },
			});
			return domain;
		}),

	unassign: withPermission("domain", "update")
		.input(z.object({ domainId: z.string().min(1) }))
		.mutation(async ({ input, ctx }) => {
			const current = await findDomainById(input.domainId);
			await assertDomainAccess(ctx, current, "update");
			const { unassignDomain } = await import(
				"@nearzero/server/services/domain-library"
			);
			const domain = await unassignDomain(input.domainId);
			await audit(ctx, {
				action: "update",
				resourceType: "domain",
				resourceId: domain?.domainId,
				resourceName: domain?.host,
				metadata: { source: "unassign" },
			});
			return domain;
		}),

	generateSubdomain: withPermission("domain", "create")
		.input(
			z.object({
				environmentId: z.string().min(1),
				serviceName: z.string().min(1),
				port: z.number().int().min(1).max(65535).default(3000),
				serverId: z.string().optional().nullable(),
				path: domainInput.shape.path,
				domainType: z.enum(["application", "compose"]),
				applicationId: z.string().optional(),
				composeId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const serviceId = input.applicationId || input.composeId;
			if (!serviceId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "applicationId or composeId is required",
				});
			}
			await checkServicePermissionAndAccess(ctx, serviceId, {
				domain: ["create"],
			});
			if (
				(input.domainType === "application" && !input.applicationId) ||
				(input.domainType === "compose" && !input.composeId) ||
				(input.applicationId && input.composeId)
			) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "domainType must match exactly one selected service",
				});
			}
			const placement = await resolveDomainServicePlacement(input);
			assertOrganizationAccess(ctx, placement.organizationId);
			assertServiceEnvironment(input.environmentId, placement.environmentId);
			await assertRuntimePlacement(ctx, "domain.assign", {
				serverId: placement.serverId,
				resourceType: "domain",
				resourceId: serviceId,
				resourceName: input.serviceName,
				serviceType: placement.serviceType,
				environmentId: input.environmentId,
				auditMetadata: {
					source: "generateSubdomain",
					domainType: input.domainType,
				},
			});
			const { generateSubdomainForService } = await import(
				"@nearzero/server/services/domain-library"
			);
			const domain = await generateSubdomainForService(input);
			if (!domain) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						"No managed DNS zone or platform default domain is configured. Use Add hostname with External DNS instead.",
				});
			}
			await audit(ctx, {
				action: "create",
				resourceType: "domain",
				resourceId: domain.domainId,
				resourceName: domain.host,
				metadata: { source: "generateSubdomain" },
			});
			return domain;
		}),
});
