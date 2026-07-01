import type { IncomingMessage, ServerResponse } from "node:http";
import { validateRequest } from "@nearzero/server";
import { db } from "@nearzero/server/db";
import { member } from "@nearzero/server/db/schema";
import { getAgentProviderStatus } from "@nearzero/server/services/agent-openrouter-key";
import {
	deleteThread,
	analyzeLogs,
	createThread,
	generateFollowUpSuggestions,
	insertMessage,
	listMessages,
	listThreads,
	renameThread,
	runTurnLoop,
	storeAttachment,
} from "@nearzero/agent";
import { and, eq } from "drizzle-orm";

function pathnameOf(req: IncomingMessage) {
	return (req.url ?? "/").split("?")[0] ?? "/";
}

async function readJson(req: IncomingMessage) {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(Buffer.from(chunk));
	const raw = Buffer.concat(chunks).toString("utf8");
	return raw ? JSON.parse(raw) : {};
}

async function readBuffer(req: IncomingMessage) {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks);
}

function json(res: ServerResponse, status: number, body: unknown) {
	res.statusCode = status;
	res.setHeader("content-type", "application/json");
	res.end(JSON.stringify(body));
}

async function identity(req: IncomingMessage) {
	const { user, session } = await validateRequest(req);
	if (!user || !session?.activeOrganizationId) return null;
	return { userId: user.id, organizationId: session.activeOrganizationId, user };
}

async function isOrgAdmin(userId: string, organizationId: string) {
	const row = await db.query.member.findFirst({
		where: and(
			eq(member.userId, userId),
			eq(member.organizationId, organizationId),
		),
	});
	return row?.role === "owner" || row?.role === "admin";
}

export async function handleAgent(req: IncomingMessage, res: ServerResponse) {
	const auth = await identity(req);
	if (!auth) return json(res, 401, { error: "Unauthorized" });

	const pathname = pathnameOf(req);
	const method = (req.method ?? "GET").toUpperCase();

	if (pathname === "/api/agent/provider-status" && method === "GET") {
		const provider = await getAgentProviderStatus(auth.organizationId);
		const canConfigure = await isOrgAdmin(auth.userId, auth.organizationId);
		return json(res, 200, {
			...provider,
			canConfigure,
		});
	}

	if (pathname === "/api/agent/message" && method === "POST") {
		const body = (await readJson(req)) as {
			text?: string;
			threadId?: string;
			aiId?: string;
			deepResearch?: boolean;
			retryAfterProviderSetup?: boolean;
			userInputResponse?: {
				field?: string;
				value?: string;
				secret?: boolean;
				context?: Record<string, string>;
			};
		};
		const memberRow = await db.query.member.findFirst({
			where: and(
				eq(member.userId, auth.userId),
				eq(member.organizationId, auth.organizationId),
			),
		});
		const userInputFields = new Set([
			"projectName",
			"gitProviderId",
			"gitRepository",
			"gitBranch",
			"serverId",
		]);
		const field = body.userInputResponse?.field;
		const inputResponse = body.userInputResponse;
		const userInputResponse =
			inputResponse && field && userInputFields.has(field)
				? {
						field: field as
							| "projectName"
							| "gitProviderId"
							| "gitRepository"
							| "gitBranch"
							| "serverId",
						value: String(inputResponse.value ?? ""),
						secret: Boolean(inputResponse.secret),
						context:
							inputResponse.context &&
							typeof inputResponse.context === "object"
								? inputResponse.context
								: undefined,
					}
				: null;
		res.statusCode = 200;
		res.setHeader("content-type", "text/event-stream; charset=utf-8");
		res.setHeader("cache-control", "no-cache, no-transform");
		res.setHeader("connection", "keep-alive");
		await runTurnLoop({
			identity: auth,
			threadId: body.threadId ?? null,
			aiId: body.aiId ?? null,
			text: String(body.text || ""),
			deepResearch: Boolean(body.deepResearch),
			retryAfterProviderSetup: Boolean(body.retryAfterProviderSetup),
			userInputResponse,
			isOrgAdmin: memberRow?.role === "owner" || memberRow?.role === "admin",
			userEmail: auth.user.email ?? undefined,
			userRole: memberRow?.role ?? undefined,
			writer: (chunk) => {
				res.write(chunk);
			},
		});
		res.end();
		return;
	}

	if (pathname === "/api/agent/analyze-logs" && method === "POST") {
		const body = (await readJson(req)) as { logs?: string; context?: "build" | "runtime" };
		return json(res, 200, {
			analysis: await analyzeLogs({
				organizationId: auth.organizationId,
				logs: String(body.logs || ""),
				context: body.context || "runtime",
			}),
		});
	}

	if (pathname === "/api/agent/threads" && method === "GET") {
		return json(res, 200, { threads: await listThreads(auth) });
	}

	if (pathname === "/api/agent/attachments" && method === "POST") {
		const buffer = await readBuffer(req);
		const attachment = await storeAttachment({
			name: req.headers["x-file-name"]?.toString() || "attachment.bin",
			contentType: req.headers["content-type"]?.toString(),
			buffer,
		});
		return json(res, 200, { attachment });
	}

	if (pathname === "/api/agent/threads" && method === "POST") {
		return json(res, 200, { threadId: await createThread(auth) });
	}

	const messageMatch = pathname.match(
		/^\/api\/agent\/threads\/([^/]+)\/messages$/,
	);
	if (messageMatch && method === "GET") {
		return json(res, 200, {
			messages: await listMessages(messageMatch[1]!, auth),
		});
	}

	const threadMatch = pathname.match(/^\/api\/agent\/threads\/([^/]+)$/);
	if (threadMatch && method === "PATCH") {
		const body = (await readJson(req)) as { title?: string };
		await renameThread(threadMatch[1]!, String(body.title || "Untitled"), auth);
		return json(res, 200, { ok: true });
	}
	if (threadMatch && method === "DELETE") {
		await deleteThread(threadMatch[1]!, auth);
		return json(res, 200, { ok: true });
	}

	if (pathname === "/api/agent/follow-up-suggestions" && method === "POST") {
		const body = (await readJson(req)) as {
			userMessage?: string;
			assistantMessage?: string;
			recentUserMessages?: unknown;
		};
		return json(res, 200, {
			suggestions: await generateFollowUpSuggestions({
				organizationId: auth.organizationId,
				userMessage: String(body.userMessage || ""),
				assistantMessage: String(body.assistantMessage || ""),
				recentUserMessages: Array.isArray(body.recentUserMessages)
					? body.recentUserMessages
							.filter((message): message is string => typeof message === "string")
							.slice(-6)
					: [],
			}),
		});
	}

	if (pathname === "/api/agent/threads/seed-branch" && method === "POST") {
		const body = (await readJson(req)) as {
			parentThreadId?: string;
			sourceMessageId?: string;
			transcript?: Array<{ role: "user" | "assistant"; content: string }>;
		};
		const threadId = await createThread(auth);
		for (const turn of body.transcript ?? []) {
			await insertMessage(threadId, turn.role, { text: turn.content });
		}
		return json(res, 200, {
			threadId,
			parentThreadId: body.parentThreadId ?? null,
			sourceMessageId: body.sourceMessageId ?? null,
		});
	}

	return json(res, 404, { error: "Agent route not found" });
}
