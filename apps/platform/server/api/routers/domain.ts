import {
	createDomain,
	findApplicationById,
	findComposeById,
	findDomainById,
	findDomainsByApplicationId,
	findDomainsByComposeId,
	findPreviewDeploymentById,
	findServerById,
	generateTraefikMeDomain,
	manageDomain,
	previewServiceDomain,
	provisionServiceDomain,
	removeDomain,
	removeDomainById,
	resolveDomainTargetIp,
	syncManagedDnsRecordForDomain,
	updateDomainById,
	validateDomain,
} from "@nearzero/server";
import { checkServicePermissionAndAccess } from "@nearzero/server/services/permission";
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
	if (input.applicationId) {
		const application = await findApplicationById(input.applicationId);
		return {
			serverId: application.serverId ?? input.serverId ?? null,
			resourceId: application.applicationId,
			resourceName: input.serviceName || application.appName,
			serviceType: "application",
			environmentId: application.environmentId,
		};
	}
	if (input.composeId) {
		const compose = await findComposeById(input.composeId);
		return {
			serverId: compose.serverId ?? input.serverId ?? null,
			resourceId: compose.composeId,
			resourceName: input.serviceName || compose.appName || compose.name,
			serviceType: "compose",
			environmentId: compose.environmentId,
		};
	}
	return {
		serverId: input.serverId ?? null,
		resourceId: undefined,
		resourceName: input.serviceName ?? undefined,
		serviceType: undefined,
		environmentId: undefined,
	};
}

export const domainRouter = createTRPCRouter({
	create: protectedProcedure
		.input(apiCreateDomain)
		.mutation(async ({ input, ctx }) => {
			try {
				if (input.domainType === "compose" && input.composeId) {
					await checkServicePermissionAndAccess(ctx, input.composeId, {
						domain: ["create"],
					});
				} else if (input.domainType === "application" && input.applicationId) {
					await checkServicePermissionAndAccess(ctx, input.applicationId, {
						domain: ["create"],
					});
				}
				const placement = await resolveDomainServicePlacement(input);
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
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				domain: ["read"],
			});
			return await findDomainsByApplicationId(input.applicationId);
		}),
	byComposeId: protectedProcedure
		.input(apiFindCompose)
		.query(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				domain: ["read"],
			});
			return await findDomainsByComposeId(input.composeId);
		}),
	generateDomain: withPermission("domain", "create")
		.input(z.object({ appName: z.string(), serverId: z.string().optional() }))
		.mutation(async ({ input, ctx }) => {
			return generateTraefikMeDomain(
				input.appName,
				ctx.user.ownerId,
				input.serverId,
			);
		}),
	canGenerateTraefikMeDomains: withPermission("domain", "read")
		.input(z.object({ serverId: z.string().optional() }))
		.query(async ({ input }) => {
			try {
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
		.query(async ({ input }) =>
			previewServiceDomain({
				environmentId: input.environmentId,
				serviceName: input.serviceName,
				serverId: input.serverId,
			}),
		),

	provisionServiceDomain: protectedProcedure
		.input(
			z.object({
				environmentId: z.string().min(1),
				serviceName: z.string().min(1),
				port: z.number().int().min(1).max(65535).default(3000),
				serverId: z.string().optional().nullable(),
				path: z.string().optional(),
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
			const placement = await resolveDomainServicePlacement(input);
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
			const currentDomain = await findDomainById(input.domainId);
			const serviceId = currentDomain.applicationId || currentDomain.composeId;
			if (serviceId) {
				await checkServicePermissionAndAccess(ctx, serviceId, {
					domain: ["create"],
				});
			} else if (currentDomain.previewDeploymentId) {
				const preview = await findPreviewDeploymentById(
					currentDomain.previewDeploymentId,
				);
				await checkServicePermissionAndAccess(ctx, preview.applicationId, {
					domain: ["create"],
				});
			}

			const result = await updateDomainById(input.domainId, input);
			const domain = await findDomainById(input.domainId);
			await audit(ctx, {
				action: "update",
				resourceType: "domain",
				resourceId: domain.domainId,
				resourceName: domain.host,
			});
			if (domain.applicationId) {
				const application = await findApplicationById(domain.applicationId);
				await manageDomain(application, domain);
			} else if (domain.previewDeploymentId) {
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
			return result;
		}),
	one: protectedProcedure.input(apiFindDomain).query(async ({ input, ctx }) => {
		const domain = await findDomainById(input.domainId);
		const serviceId = domain.applicationId || domain.composeId;
		if (serviceId) {
			await checkServicePermissionAndAccess(ctx, serviceId, {
				domain: ["read"],
			});
		} else if (domain.previewDeploymentId) {
			const preview = await findPreviewDeploymentById(
				domain.previewDeploymentId,
			);
			await checkServicePermissionAndAccess(ctx, preview.applicationId, {
				domain: ["read"],
			});
		}
		return domain;
	}),
	delete: protectedProcedure
		.input(apiFindDomain)
		.mutation(async ({ input, ctx }) => {
			const domain = await findDomainById(input.domainId);
			const serviceId = domain.applicationId || domain.composeId;
			if (serviceId) {
				await checkServicePermissionAndAccess(ctx, serviceId, {
					domain: ["delete"],
				});
			} else if (domain.previewDeploymentId) {
				const preview = await findPreviewDeploymentById(
					domain.previewDeploymentId,
				);
				await checkServicePermissionAndAccess(ctx, preview.applicationId, {
					domain: ["delete"],
				});
			}

			const result = await removeDomainById(input.domainId);
			await audit(ctx, {
				action: "delete",
				resourceType: "domain",
				resourceId: domain.domainId,
				resourceName: domain.host,
			});

			if (domain.applicationId) {
				const application = await findApplicationById(domain.applicationId);
				await removeDomain(application, domain.uniqueConfigKey);
			}

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

	register: withPermission("domain", "create")
		.input(
			z.object({
				host: z.string().min(1),
				dnsMode: z
					.enum(["external", "nearzero_managed", "platform"])
					.default("external"),
				https: z.boolean().optional(),
				certificateType: z.enum(["letsencrypt", "none", "custom"]).optional(),
				customCertResolver: z.string().optional(),
				dnsZoneId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			await assertRuntimePlacement(ctx, "domain.assign", {
				serverId: null,
				allowAnyReadyServer: true,
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
				path: z.string().optional(),
				https: z.boolean().optional(),
				certificateType: z.enum(["letsencrypt", "none", "custom"]).optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const serviceId = input.applicationId || input.composeId;
			if (serviceId) {
				await checkServicePermissionAndAccess(ctx, serviceId, {
					domain: ["create"],
				});
			}
			const placement = await resolveDomainServicePlacement(input);
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
			const serviceId = current.applicationId || current.composeId;
			if (serviceId) {
				await checkServicePermissionAndAccess(ctx, serviceId, {
					domain: ["create"],
				});
			}
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
				path: z.string().optional(),
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
			const placement = await resolveDomainServicePlacement(input);
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
