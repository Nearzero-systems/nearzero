import { relations } from "drizzle-orm";
import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organization } from "./account";

export const organizationSettings = pgTable("organization_settings", {
	organizationId: text("organizationId")
		.primaryKey()
		.references(() => organization.id, { onDelete: "cascade" }),
	allowAgentOpenRouterSetup: boolean("allowAgentOpenRouterSetup")
		.notNull()
		.default(true),
	allowAgentProjectCreation: boolean("allowAgentProjectCreation")
		.notNull()
		.default(true),
	allowAgentProjectUpdates: boolean("allowAgentProjectUpdates")
		.notNull()
		.default(true),
	allowAgentProductionActions: boolean("allowAgentProductionActions")
		.notNull()
		.default(false),
	allowAgentDevProjectDeletion: boolean("allowAgentDevProjectDeletion")
		.notNull()
		.default(false),
	allowAgentServiceCreation: boolean("allowAgentServiceCreation")
		.notNull()
		.default(true),
	allowAgentServiceImports: boolean("allowAgentServiceImports")
		.notNull()
		.default(false),
	allowAgentSshServiceSetup: boolean("allowAgentSshServiceSetup")
		.notNull()
		.default(false),
	allowAgentDomainAssignment: boolean("allowAgentDomainAssignment")
		.notNull()
		.default(true),
	allowAgentServerCreation: boolean("allowAgentServerCreation")
		.notNull()
		.default(false),
	allowAgentDeployments: boolean("allowAgentDeployments")
		.notNull()
		.default(false),
	openRouterApiKeyCiphertext: text("openRouterApiKeyCiphertext"),
	openRouterApiKeyConfiguredAt: text("openRouterApiKeyConfiguredAt"),
	openRouterApiKeyConfiguredByUserId: text("openRouterApiKeyConfiguredByUserId"),
	createdAt: text("createdAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
	updatedAt: text("updatedAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});

export const organizationSettingsRelations = relations(
	organizationSettings,
	({ one }) => ({
		organization: one(organization, {
			fields: [organizationSettings.organizationId],
			references: [organization.id],
		}),
	}),
);
