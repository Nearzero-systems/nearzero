import {
	clearOrgOpenRouterKey,
	getAgentProviderStatus,
	setOrgOpenRouterKey,
} from "@nearzero/server/services/agent-openrouter-key";
import { assertAgentPolicy } from "@nearzero/server/services/agent-policy";
import {
	getOrganizationSettings,
	updateOrganizationAgentSettings,
} from "@nearzero/server/services/organization-settings";
import { z } from "zod";
import {
	adminProcedure,
	createTRPCRouter,
	protectedProcedure,
} from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";

const agentPolicySettingsSchema = z.object({
	allowAgentOpenRouterSetup: z.boolean().optional(),
	allowAgentProjectCreation: z.boolean().optional(),
	allowAgentProjectUpdates: z.boolean().optional(),
	allowAgentProductionActions: z.boolean().optional(),
	allowAgentDevProjectDeletion: z.boolean().optional(),
	allowAgentServiceCreation: z.boolean().optional(),
	allowAgentServiceImports: z.boolean().optional(),
	allowAgentSshServiceSetup: z.boolean().optional(),
	allowAgentDomainAssignment: z.boolean().optional(),
	allowAgentServerCreation: z.boolean().optional(),
	allowAgentDeployments: z.boolean().optional(),
});

const agentPolicySettingKeys = Object.keys(
	agentPolicySettingsSchema.shape,
) as Array<keyof z.infer<typeof agentPolicySettingsSchema>>;

export const organizationSettingsRouter = createTRPCRouter({
	getAgentSettings: adminProcedure.query(async ({ ctx }) => {
		const settings = await getOrganizationSettings(
			ctx.session.activeOrganizationId,
		);
		const provider = await getAgentProviderStatus(
			ctx.session.activeOrganizationId,
		);
		return {
			...settings,
			openRouterConfigured: provider.configured,
			openRouterSource: provider.source,
			hasStoredOrgKey: Boolean(settings.openRouterApiKeyCiphertext),
		};
	}),

	getAgentProviderStatus: protectedProcedure.query(async ({ ctx }) => {
		const provider = await getAgentProviderStatus(
			ctx.session.activeOrganizationId,
		);
		return {
			...provider,
			canConfigure: ctx.user.role === "owner" || ctx.user.role === "admin",
		};
	}),

	setOrgOpenRouterKey: adminProcedure
		.input(z.object({ apiKey: z.string().min(8).max(512) }))
		.mutation(async ({ ctx, input }) => {
			const organizationId = ctx.session.activeOrganizationId;
			await assertAgentPolicy(
				{
					organizationId,
					userId: ctx.user.id,
					userEmail: ctx.user.email ?? undefined,
					userRole: ctx.user.role ?? undefined,
				},
				"agent.openrouter.setup",
				{
					resourceType: "settings",
					resourceName: "agent-openrouter-key",
					auditMetadata: { configured: true },
				},
			);
			const updated = await setOrgOpenRouterKey(
				organizationId,
				ctx.user.id,
				input.apiKey,
			);
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "agent-openrouter-key",
				metadata: { configured: true },
			});
			return {
				ok: true,
				configuredAt: updated.openRouterApiKeyConfiguredAt,
			};
		}),

	clearOrgOpenRouterKey: adminProcedure.mutation(async ({ ctx }) => {
		const organizationId = ctx.session.activeOrganizationId;
		await assertAgentPolicy(
			{
				organizationId,
				userId: ctx.user.id,
				userEmail: ctx.user.email ?? undefined,
				userRole: ctx.user.role ?? undefined,
			},
			"agent.openrouter.setup",
			{
				resourceType: "settings",
				resourceName: "agent-openrouter-key",
				auditMetadata: { configured: false },
			},
		);
		await clearOrgOpenRouterKey(organizationId);
		await audit(ctx, {
			action: "delete",
			resourceType: "settings",
			resourceName: "agent-openrouter-key",
		});
		return { ok: true };
	}),

	updateAgentSettings: adminProcedure
		.input(
			agentPolicySettingsSchema.refine(
				(input) =>
					agentPolicySettingKeys.some((key) => input[key] !== undefined),
				{ message: "At least one agent setting must be provided" },
			),
		)
		.mutation(async ({ ctx, input }) => {
			const organizationId = ctx.session.activeOrganizationId;
			const previous = await getOrganizationSettings(organizationId);
			const updated = await updateOrganizationAgentSettings(
				organizationId,
				input,
			);

			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "agent-settings",
				metadata: {
					previous: Object.fromEntries(
						agentPolicySettingKeys.map((key) => [key, previous[key]]),
					),
					next: Object.fromEntries(
						agentPolicySettingKeys.map((key) => [key, updated[key]]),
					),
				},
			});

			return updated;
		}),
});
