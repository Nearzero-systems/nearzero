import { getAgentConfig } from "../config";
import {
	ensureThread,
	insertMessage,
	insertStreamEvent,
	renameThread,
	type AgentIdentity,
} from "../store";
import { sseFrame, type AgentWireEnvelope } from "../wire";
import { runAgentToolLoop, generateThreadTitleWithProvider } from "./loop/run-agent-loop";
import {
	runHarnessIntents,
	runHarnessUserInputResponse,
} from "./harness-intents/run-harness-intents";
import { resolveProvider } from "./resolve-provider";
import {
	AgentUserInputRequiredError,
	type AgentUserInputResponse,
} from "./agent-user-input";

/**
 * Scoped agent turn loop — BYOK onboarding + multi-turn tools when a key exists.
 * Out of scope (do not extend here): attachmentIds on POST, seed-branch UI, project
 * picker onboarding, verify/delegate tools, stream resume / interrupted, aiId UI,
 * pre-send composer block, per-user keys, AgentConversationMenu wiring.
 */
type RunTurnInput = {
	identity: AgentIdentity;
	threadId?: string | null;
	aiId?: string | null;
	text: string;
	isOrgAdmin?: boolean;
	deepResearch?: boolean;
	userEmail?: string;
	userRole?: string;
	retryAfterProviderSetup?: boolean;
	userInputResponse?: AgentUserInputResponse | null;
	writer: (chunk: string) => void | Promise<void>;
};

export async function runTurnLoop(input: RunTurnInput) {
	const isNewThread = !input.threadId;
	const threadId = await ensureThread(input.threadId ?? null, input.identity);

	const emit = async (event: AgentWireEnvelope["event"]) => {
		const envelope = await insertStreamEvent(threadId, event);
		await input.writer(sseFrame(envelope));
	};

	const config = getAgentConfig();
	if (!config.enabled) {
		await emit({
			kind: "error",
			code: "agent_disabled",
			message: "Nearzero Agent is disabled.",
		});
		await emit({ kind: "done", completed: false });
		return threadId;
	}

	if (input.userInputResponse?.secret) {
		await emit({
			kind: "error",
			code: "secret_input_rejected",
			message: "Secret input cannot be submitted through Agent chat.",
		});
		await emit({ kind: "done", completed: false });
		return threadId;
	}

	if (!input.retryAfterProviderSetup) {
		await insertMessage(threadId, "user", { text: input.text });
	}

	if (isNewThread) {
		const provisionalTitle = provisionalThreadTitle(input.text);
		await renameThread(threadId, provisionalTitle, input.identity);
		await emit({ kind: "thread_title", title: provisionalTitle });
	}

	const toolContext = {
		organizationId: input.identity.organizationId,
		userId: input.identity.userId,
		userEmail: input.userEmail,
		userRole: input.userRole,
		threadId,
		aiId: input.aiId ?? null,
	};

	try {
		if (input.userInputResponse) {
			const harnessReply = await runHarnessUserInputResponse({
				response: input.userInputResponse,
				toolContext,
				emit,
			});
			if (harnessReply) {
				for (const chunk of chunkText(harnessReply)) {
					await emit({ kind: "assistant_delta", text: chunk });
				}
				await insertMessage(threadId, "assistant", { text: harnessReply });
				await emit({ kind: "assistant_message", text: harnessReply });
				await emit({ kind: "done", completed: true });
				return threadId;
			}
		}

		if (!input.retryAfterProviderSetup) {
			const harnessReply = await runHarnessIntents({
				userText: input.text,
				toolContext,
				emit,
			});
			if (harnessReply) {
				for (const chunk of chunkText(harnessReply)) {
					await emit({ kind: "assistant_delta", text: chunk });
				}
				await insertMessage(threadId, "assistant", { text: harnessReply });
				await emit({ kind: "assistant_message", text: harnessReply });
				await emit({ kind: "done", completed: true });
				return threadId;
			}
		}
	} catch (error) {
		if (error instanceof AgentUserInputRequiredError) {
			const request = error.request;
			await insertMessage(threadId, "assistant", {
				text: "",
				userInputRequest: request,
			});
			await emit({
				kind: "user_input_required",
				field: request.field,
				waitingLabel: request.waitingLabel,
				prompt: request.prompt,
				placeholder: request.placeholder,
				submitLabel: request.submitLabel,
				inputType: request.inputType,
				secret: request.secret,
				options: request.options,
				context: request.context,
			});
			await emit({ kind: "done", completed: true });
			return threadId;
		}
		const message =
			error instanceof Error ? error.message : "Agent backend error.";
		await insertMessage(threadId, "assistant", { text: message });
		await emit({ kind: "error", code: "agent_error", message });
		await emit({ kind: "done", completed: false });
		return threadId;
	}

	const provider = await resolveProvider({
		organizationId: input.identity.organizationId,
		aiId: input.aiId ?? null,
	});

	if (!provider) {
		const greeting = input.isOrgAdmin
			? config.onboardingGreetingAdmin
			: config.onboardingGreetingMember;
		const waitingLabel = input.isOrgAdmin
			? "Waiting for the key"
			: "Waiting for admin to configure OpenRouter";

		for (const chunk of chunkText(greeting)) {
			await emit({ kind: "assistant_delta", text: chunk });
		}
		await insertMessage(threadId, "assistant", { text: greeting });
		await emit({ kind: "assistant_message", text: greeting });
		await emit({
			kind: "provider_setup_required",
			canConfigure: Boolean(input.isOrgAdmin),
			waitingLabel,
		});
		await emit({ kind: "done", completed: true });
		return threadId;
	}

	if (isNewThread) {
		void generateThreadTitleWithProvider(provider, input.text)
			.then(async (title) => {
				await renameThread(threadId, title, input.identity);
				await emit({ kind: "thread_title", title });
			})
			.catch(() => undefined);
	}

	try {
		await runAgentToolLoop({
			threadId,
			identity: input.identity,
			provider,
			userText: input.text,
			deepResearch: input.deepResearch,
			retryAfterProviderSetup: input.retryAfterProviderSetup,
			toolContext,
			emit,
		});
		await emit({ kind: "done", completed: true });
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Agent backend error.";
		await insertMessage(threadId, "assistant", { text: message });
		await emit({ kind: "error", code: "agent_error", message });
		await emit({ kind: "done", completed: false });
	}

	return threadId;
}

function chunkText(text: string) {
	const chunks: string[] = [];
	for (let i = 0; i < text.length; i += 240) chunks.push(text.slice(i, i + 240));
	return chunks.length ? chunks : [""];
}

function provisionalThreadTitle(text: string) {
	return text.split(/\s+/).slice(0, 8).join(" ").slice(0, 72) || "New session";
}
