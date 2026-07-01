import { db } from "@nearzero/server/db";
import { organizationSettings } from "@nearzero/server/db/schema";
import { eq } from "drizzle-orm";

export type OrganizationSettingsRow = typeof organizationSettings.$inferSelect;

export async function getOrganizationSettings(
	organizationId: string,
): Promise<OrganizationSettingsRow> {
	const existing = await db.query.organizationSettings.findFirst({
		where: eq(organizationSettings.organizationId, organizationId),
	});
	if (existing) return existing;

	const [created] = await db
		.insert(organizationSettings)
		.values({ organizationId })
		.returning();

	if (!created) {
		throw new Error("Failed to create organization settings");
	}

	return created;
}

export async function updateOrganizationAgentSettings(
	organizationId: string,
	input: {
		allowAgentOpenRouterSetup?: boolean;
		allowAgentProjectCreation?: boolean;
		allowAgentProjectUpdates?: boolean;
		allowAgentProductionActions?: boolean;
		allowAgentDevProjectDeletion?: boolean;
		allowAgentServiceCreation?: boolean;
		allowAgentServiceImports?: boolean;
		allowAgentSshServiceSetup?: boolean;
		allowAgentDomainAssignment?: boolean;
		allowAgentServerCreation?: boolean;
		allowAgentDeployments?: boolean;
	},
): Promise<OrganizationSettingsRow> {
	await getOrganizationSettings(organizationId);

	const [updated] = await db
		.update(organizationSettings)
		.set({
			...(input.allowAgentOpenRouterSetup !== undefined
				? { allowAgentOpenRouterSetup: input.allowAgentOpenRouterSetup }
				: {}),
			...(input.allowAgentProjectCreation !== undefined
				? { allowAgentProjectCreation: input.allowAgentProjectCreation }
				: {}),
			...(input.allowAgentProjectUpdates !== undefined
				? { allowAgentProjectUpdates: input.allowAgentProjectUpdates }
				: {}),
			...(input.allowAgentProductionActions !== undefined
				? { allowAgentProductionActions: input.allowAgentProductionActions }
				: {}),
			...(input.allowAgentDevProjectDeletion !== undefined
				? { allowAgentDevProjectDeletion: input.allowAgentDevProjectDeletion }
				: {}),
			...(input.allowAgentServiceCreation !== undefined
				? { allowAgentServiceCreation: input.allowAgentServiceCreation }
				: {}),
			...(input.allowAgentServiceImports !== undefined
				? { allowAgentServiceImports: input.allowAgentServiceImports }
				: {}),
			...(input.allowAgentSshServiceSetup !== undefined
				? { allowAgentSshServiceSetup: input.allowAgentSshServiceSetup }
				: {}),
			...(input.allowAgentDomainAssignment !== undefined
				? { allowAgentDomainAssignment: input.allowAgentDomainAssignment }
				: {}),
			...(input.allowAgentServerCreation !== undefined
				? { allowAgentServerCreation: input.allowAgentServerCreation }
				: {}),
			...(input.allowAgentDeployments !== undefined
				? { allowAgentDeployments: input.allowAgentDeployments }
				: {}),
			updatedAt: new Date().toISOString(),
		})
		.where(eq(organizationSettings.organizationId, organizationId))
		.returning();

	if (!updated) {
		throw new Error("Failed to update organization settings");
	}

	return updated;
}

export async function canAgentOperateInProduction(
	organizationId: string,
): Promise<boolean> {
	const settings = await getOrganizationSettings(organizationId);
	return settings.allowAgentProductionActions;
}
