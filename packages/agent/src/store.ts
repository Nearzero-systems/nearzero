import { and, asc, desc, eq, max } from "drizzle-orm";
import { nanoid } from "nanoid";
import { agentDb } from "./db";
import { agentMessages, agentStreamEvents, agentThreads } from "./db/schema";
import type { AgentWirePayload } from "./wire";

export type AgentIdentity = {
	userId: string;
	organizationId: string;
};

export async function createThread(identity: AgentIdentity) {
	const id = nanoid();
	await agentDb.insert(agentThreads).values({
		id,
		createdByUserId: identity.userId,
		organizationId: identity.organizationId,
		status: "idle",
	});
	return id;
}

export async function ensureThread(threadId: string | null, identity: AgentIdentity) {
	if (!threadId) return createThread(identity);
	const existing = await agentDb.query.agentThreads.findFirst({
		where: and(
			eq(agentThreads.id, threadId),
			eq(agentThreads.organizationId, identity.organizationId),
		),
	});
	return existing ? existing.id : createThread(identity);
}

export async function listThreads(identity: AgentIdentity) {
	return agentDb.query.agentThreads.findMany({
		where: eq(agentThreads.organizationId, identity.organizationId),
		orderBy: desc(agentThreads.updatedAt),
		limit: 50,
	});
}

export async function listMessages(threadId: string, identity: AgentIdentity) {
	await assertThreadAccess(threadId, identity);
	return agentDb.query.agentMessages.findMany({
		where: eq(agentMessages.threadId, threadId),
		orderBy: asc(agentMessages.sortKey),
	});
}

export async function renameThread(
	threadId: string,
	title: string,
	identity: AgentIdentity,
) {
	await assertThreadAccess(threadId, identity);
	await agentDb
		.update(agentThreads)
		.set({ title, updatedAt: new Date().toISOString() })
		.where(eq(agentThreads.id, threadId));
}

export async function deleteThread(threadId: string, identity: AgentIdentity) {
	await assertThreadAccess(threadId, identity);
	await agentDb.delete(agentMessages).where(eq(agentMessages.threadId, threadId));
	await agentDb
		.delete(agentStreamEvents)
		.where(eq(agentStreamEvents.threadId, threadId));
	await agentDb.delete(agentThreads).where(eq(agentThreads.id, threadId));
}

export async function insertMessage(
	threadId: string,
	role: "user" | "assistant" | "tool",
	content: unknown,
) {
	const [{ value } = { value: 0 }] = await agentDb
		.select({ value: max(agentMessages.sortKey) })
		.from(agentMessages)
		.where(eq(agentMessages.threadId, threadId));
	const sortKey = Number(value || 0) + 1;
	const id = nanoid();
	await agentDb.insert(agentMessages).values({
		id,
		threadId,
		role,
		contentJson: content,
		sortKey,
	});
	await agentDb
		.update(agentThreads)
		.set({ updatedAt: new Date().toISOString() })
		.where(eq(agentThreads.id, threadId));
	return id;
}

export async function insertStreamEvent(
	threadId: string,
	event: AgentWirePayload,
) {
	const [{ value } = { value: 0 }] = await agentDb
		.select({ value: max(agentStreamEvents.seq) })
		.from(agentStreamEvents)
		.where(eq(agentStreamEvents.threadId, threadId));
	const seq = Number(value || 0) + 1;
	await agentDb.insert(agentStreamEvents).values({
		threadId,
		seq,
		payloadJson: event,
	});
	return { seq, threadId, event };
}

async function assertThreadAccess(threadId: string, identity: AgentIdentity) {
	const thread = await agentDb.query.agentThreads.findFirst({
		where: and(
			eq(agentThreads.id, threadId),
			eq(agentThreads.organizationId, identity.organizationId),
		),
	});
	if (!thread) throw new Error("Agent thread not found");
	return thread;
}
