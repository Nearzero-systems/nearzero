import { integer, jsonb, pgEnum, pgTable, text } from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";

export const agentThreadStatus = pgEnum("agentThreadStatus", [
	"idle",
	"running",
	"interrupted",
	"error",
	"completed",
]);

export const agentThreads = pgTable("agent_thread", {
	id: text("id")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	organizationId: text("organizationId").notNull(),
	createdByUserId: text("createdByUserId").notNull(),
	title: text("title"),
	status: agentThreadStatus("status").notNull().default("idle"),
	lastError: text("lastError"),
	continuationRevision: integer("continuationRevision").notNull().default(0),
	parentThreadId: text("parentThreadId"),
	createdAt: text("createdAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
	updatedAt: text("updatedAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});

export const agentMessages = pgTable("agent_message", {
	id: text("id")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	threadId: text("threadId").notNull(),
	role: text("role").notNull(),
	contentJson: jsonb("contentJson").notNull(),
	sortKey: integer("sortKey").notNull(),
	clientMessageId: text("clientMessageId"),
	createdAt: text("createdAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});

export const agentStreamEvents = pgTable("agent_stream_event", {
	threadId: text("threadId").notNull(),
	seq: integer("seq").notNull(),
	payloadJson: jsonb("payloadJson").notNull(),
	createdAt: text("createdAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});

export const agentBranchRoots = pgTable("agent_branch_root", {
	id: text("id")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	sourceThreadId: text("sourceThreadId").notNull(),
	sourceMessageId: text("sourceMessageId").notNull(),
	createdThreadId: text("createdThreadId").notNull(),
	createdAt: text("createdAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});
