import { relations } from "drizzle-orm";
import { boolean, pgEnum, pgTable, text } from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { z } from "zod";
import { organization } from "./account";
import { bitbucket } from "./bitbucket";
import { gitea } from "./gitea";
import { github } from "./github";
import { gitlab } from "./gitlab";
import { user } from "./user";

export const gitProviderType = pgEnum("gitProviderType", [
	"github",
	"gitlab",
	"bitbucket",
	"gitea",
]);

export const gitProviderConnectionMode = pgEnum("gitProviderConnectionMode", [
	"byo",
	"nearzero_managed",
]);

export const gitProvider = pgTable("git_provider", {
	gitProviderId: text("gitProviderId")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	name: text("name").notNull(),
	providerType: gitProviderType("providerType").notNull().default("github"),
	connectionMode: gitProviderConnectionMode("connectionMode")
		.notNull()
		.default("byo"),
	createdAt: text("createdAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
	organizationId: text("organizationId")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	userId: text("userId")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
	sharedWithOrganization: boolean("sharedWithOrganization")
		.notNull()
		.default(false),
});

export const gitProviderRelations = relations(gitProvider, ({ one }) => ({
	github: one(github, {
		fields: [gitProvider.gitProviderId],
		references: [github.gitProviderId],
	}),
	gitlab: one(gitlab, {
		fields: [gitProvider.gitProviderId],
		references: [gitlab.gitProviderId],
	}),
	bitbucket: one(bitbucket, {
		fields: [gitProvider.gitProviderId],
		references: [bitbucket.gitProviderId],
	}),
	gitea: one(gitea, {
		fields: [gitProvider.gitProviderId],
		references: [gitea.gitProviderId],
	}),
	organization: one(organization, {
		fields: [gitProvider.organizationId],
		references: [organization.id],
	}),
	user: one(user, {
		fields: [gitProvider.userId],
		references: [user.id],
	}),
}));

export const gitProviderOAuthState = pgTable("git_provider_oauth_state", {
	stateId: text("stateId")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	stateHash: text("stateHash").notNull().unique(),
	providerType: gitProviderType("providerType").notNull(),
	organizationId: text("organizationId")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	userId: text("userId")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
	returnTo: text("returnTo"),
	createdAt: text("createdAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
	expiresAt: text("expiresAt").notNull(),
	consumedAt: text("consumedAt"),
});

export const apiRemoveGitProvider = z.object({
	gitProviderId: z.string().min(1),
});

export const apiToggleShareGitProvider = z.object({
	gitProviderId: z.string().min(1),
	sharedWithOrganization: z.boolean(),
});
