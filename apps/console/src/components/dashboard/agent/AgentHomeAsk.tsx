import { motion } from "framer-motion";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { AgentChatMarkdown } from "./AgentChatMarkdown";
import { activityFromToolEvent } from "./agentToolLabels";
import {
	AgentComposerAccessorySlide,
	AgentComposerOptionsAccessory,
	type AgentMcqPrompt,
} from "./AgentComposerAccessory";
import { AgentMessageInputPrompt, saveOpenRouterKey } from "./AgentMessageInputPrompt";
import { AgentSessionsPanel } from "./AgentSessionsPanel";
import { AgentSourcesRow, type AgentSource } from "./AgentSourcesRow";
import { AgentThreadsProvider, useAgentThreads } from "./AgentThreadsContext";

type Message = {
	id: string;
	role: "user" | "assistant";
	content: string;
	sources?: AgentSource[];
	userInputRequest?: AgentUserInputRequest;
};

type AgentUserInputField =
	| "projectName"
	| "gitProviderId"
	| "gitRepository"
	| "gitBranch"
	| "serverId";

type AgentUserInputOption = {
	label: string;
	value: string;
	description?: string;
	action?: "submit" | "connectGitProvider";
	providerType?: "github" | "gitlab" | "bitbucket" | "gitea";
	href?: string;
};

type AgentUserInputRequest = {
	field: AgentUserInputField;
	prompt: string;
	waitingLabel: string;
	placeholder?: string;
	submitLabel?: string;
	inputType?: "text" | "password";
	secret?: boolean;
	options?: AgentUserInputOption[];
	context?: Record<string, string>;
};

type AgentUserInputResponse = {
	field: AgentUserInputField;
	value: string;
	secret?: boolean;
	context?: Record<string, string>;
};

type Props = {
	title: string;
	subtitle: string;
	initialThreadId?: string | null;
	canConfigureOpenRouter?: boolean;
};

type ApiMessage = {
	id: string;
	role: string;
	contentJson?: { text?: string; userInputRequest?: AgentUserInputRequest } | null;
};

type ActiveStreamSnapshot = {
	pendingId: string | null;
	threadId: string | null;
	assistantId: string;
	assistantText: string;
	messages: Message[];
	activity: string;
	toolInProgress: boolean;
};

const AGENT_GIT_CONNECT_PENDING_KEY = "nearzero.agent.pendingGitProviderConnect";

type PendingGitProviderConnect = {
	threadId: string | null;
	request: AgentUserInputRequest;
	value: string;
	label: string;
	savedAt: number;
};

function readPendingGitProviderConnect(): PendingGitProviderConnect | null {
	try {
		const raw = window.sessionStorage.getItem(AGENT_GIT_CONNECT_PENDING_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as PendingGitProviderConnect;
		if (!parsed?.request || !parsed.value || Date.now() - parsed.savedAt > 30 * 60 * 1000) {
			window.sessionStorage.removeItem(AGENT_GIT_CONNECT_PENDING_KEY);
			return null;
		}
		return parsed;
	} catch {
		window.sessionStorage.removeItem(AGENT_GIT_CONNECT_PENDING_KEY);
		return null;
	}
}

function writePendingGitProviderConnect(input: PendingGitProviderConnect) {
	window.sessionStorage.setItem(
		AGENT_GIT_CONNECT_PENDING_KEY,
		JSON.stringify(input),
	);
}

function clearPendingGitProviderConnect() {
	window.sessionStorage.removeItem(AGENT_GIT_CONNECT_PENDING_KEY);
}

function mapApiMessage(row: ApiMessage): Message | null {
	if (row.role !== "user" && row.role !== "assistant") return null;
	const text =
		typeof row.contentJson === "object" && row.contentJson?.text != null
			? String(row.contentJson.text)
			: "";
	const userInputRequest =
		typeof row.contentJson === "object"
			? row.contentJson?.userInputRequest
			: undefined;
	if (row.role === "assistant" && !text.trim() && !userInputRequest) return null;
	return { id: row.id, role: row.role, content: text, userInputRequest };
}

type Suggestion = {
	icon: "shield" | "list" | "target" | "layers";
	text: string;
};

const suggestions: Suggestion[] = [
	{ icon: "shield", text: "How do I deploy this safely?" },
	{ icon: "list", text: "What should I check in the logs?" },
	{ icon: "target", text: "Can you turn this into a concrete plan?" },
	{ icon: "layers", text: "Compare stack options for a small SaaS" },
];

function AttachIcon() {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.8"
			className="h-4 w-4"
			aria-hidden="true"
		>
			<path
				d="M14.5 7.5 8.8 13.2a3 3 0 1 0 4.2 4.2l6.5-6.5a5 5 0 0 0-7.1-7.1L6.2 12.2a7 7 0 1 0 9.9 9.9l8.4-8.4"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

function SendIcon() {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.8"
			className="h-4 w-4"
			aria-hidden="true"
		>
			<path d="M5 12h14" strokeLinecap="round" />
			<path d="m13 6 6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}

function SuggestionIcon({ name }: { name: Suggestion["icon"] }) {
	if (name === "shield") {
		return (
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4 shrink-0 text-[var(--nz-text-muted)]" aria-hidden="true">
				<path d="M12 3 5 6v6c0 4.4 3 8.5 7 9.8 4-1.3 7-5.4 7-9.8V6l-7-3z" strokeLinecap="round" strokeLinejoin="round" />
			</svg>
		);
	}
	if (name === "list") {
		return (
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4 shrink-0 text-[var(--nz-text-muted)]" aria-hidden="true">
				<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" strokeLinecap="round" />
			</svg>
		);
	}
	if (name === "target") {
		return (
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4 shrink-0 text-[var(--nz-text-muted)]" aria-hidden="true">
				<circle cx="12" cy="12" r="8" />
				<circle cx="12" cy="12" r="3" />
				<path d="M12 2v2M12 20v2M2 12h2M20 12h2" strokeLinecap="round" />
			</svg>
		);
	}
	return (
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4 shrink-0 text-[var(--nz-text-muted)]" aria-hidden="true">
			<path d="M12 3 3 8l9 5 9-5-9-5z" strokeLinecap="round" strokeLinejoin="round" />
			<path d="M3 12l9 5 9-5M3 16l9 5 9-5" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}

function AgentHomeAskInner({
	title,
	subtitle,
	initialThreadId = null,
	canConfigureOpenRouter = false,
}: Props) {
	const { refreshThreads, patchThreadTitle, upsertThread } = useAgentThreads();
	const [input, setInput] = useState("");
	const [messages, setMessages] = useState<Message[]>([]);
	const [threadId, setThreadId] = useState<string | null>(initialThreadId);
	const [loadingThread, setLoadingThread] = useState(Boolean(initialThreadId));
	const [deepResearch, setDeepResearch] = useState(false);
	const [isLoading, setIsLoading] = useState(false);
	const [activity, setActivity] = useState("");
	const [streamingAssistantId, setStreamingAssistantId] = useState<string | null>(null);
	const [attachments, setAttachments] = useState<string[]>([]);
	const [followUps, setFollowUps] = useState<string[]>([]);
	const [setupPending, setSetupPending] = useState(false);
	const [waitingForKey, setWaitingForKey] = useState(false);
	const [showKeySetup, setShowKeySetup] = useState(false);
	const [pendingResendText, setPendingResendText] = useState<string | null>(null);
	const [mcqPrompt, setMcqPrompt] = useState<AgentMcqPrompt | null>(null);
	const [, setToolInProgress] = useState(false);
	const [userInputRequest, setUserInputRequest] =
		useState<AgentUserInputRequest | null>(null);
	const [streamingThreadId, setStreamingThreadId] = useState<string | null>(null);
	const [pendingSession, setPendingSession] = useState<{
		id: string;
		title: string;
		updatedAt: string;
	} | null>(null);
	const fileRef = useRef<HTMLInputElement | null>(null);
	const messagesEndRef = useRef<HTMLDivElement | null>(null);
	/** Prevents thread message reload while SSE assigns threadId mid-stream. */
	const streamThreadLockRef = useRef(false);
	const threadIdRef = useRef<string | null>(threadId);
	const viewThreadIdRef = useRef<string | null>(threadId);
	const streamThreadIdRef = useRef<string | null>(null);
	const activeStreamRef = useRef<ActiveStreamSnapshot | null>(null);
	const resumedGitConnectRef = useRef(false);

	const viewingStreamingSession =
		isLoading &&
		streamingThreadId != null &&
		(threadId ?? pendingSession?.id ?? null) === streamingThreadId;
	const canSend =
		input.trim().length > 0 &&
		!loadingThread &&
		!isLoading &&
		!viewingStreamingSession;
	const conversationActive =
		messages.length > 0 || Boolean(threadId) || Boolean(pendingSession);

	useEffect(() => {
		threadIdRef.current = threadId;
		viewThreadIdRef.current = threadId;
	}, [threadId]);

	useEffect(() => {
		if (resumedGitConnectRef.current || isLoading || loadingThread) return;
		const pending = readPendingGitProviderConnect();
		if (!pending) return;
		const currentThreadId = threadIdRef.current;
		if (pending.threadId && currentThreadId && pending.threadId !== currentThreadId) {
			return;
		}
		resumedGitConnectRef.current = true;
		clearPendingGitProviderConnect();
		setSetupPending(false);
		setUserInputRequest(null);
		setActivity("");
		void sendMessage(`Connected ${pending.label}`, {
			userInputResponse: {
				field: pending.request.field,
				value: pending.value,
				secret: false,
				context: pending.request.context,
			},
		});
	}, [threadId, isLoading, loadingThread]);

	function isViewingActiveStream(
		viewId: string | null,
		streamId: string | null,
		pendingId?: string | null,
	) {
		if (!streamId && !pendingId) return true;
		if (!viewId) return Boolean(pendingId);
		return viewId === streamId || Boolean(pendingId && viewId === pendingId);
	}

	function activeStreamMatchesThread(id: string) {
		const active = activeStreamRef.current;
		if (!active) return false;
		return active.threadId === id || active.pendingId === id;
	}

	function patchActiveStream(
		assistantId: string,
		updater: (snapshot: ActiveStreamSnapshot) => ActiveStreamSnapshot,
	) {
		const current = activeStreamRef.current;
		if (!current || current.assistantId !== assistantId) return;
		activeStreamRef.current = updater(current);
	}

	function patchActiveStreamAssistant(
		assistantId: string,
		content: string,
		mode: "append" | "replace",
	) {
		patchActiveStream(assistantId, (snapshot) => {
			const nextText =
				mode === "append" ? snapshot.assistantText + content : content;
			return {
				...snapshot,
				assistantText: nextText,
				messages: snapshot.messages.map((message) =>
					message.id === assistantId
						? { ...message, content: nextText }
						: message,
				),
			};
		});
	}

	async function loadThreadMessages(
		id: string,
		options?: {
			showLoading?: boolean;
			preserveStreamedAssistant?: { id: string; content: string };
		},
	) {
		if (options?.showLoading) setLoadingThread(true);
		try {
			const res = await fetch(`/api/agent/threads/${id}/messages`);
			if (!res.ok) return;
			const data = (await res.json()) as { messages?: ApiMessage[] };
			if (viewThreadIdRef.current !== id) return;
			let loaded =
				data.messages
					?.map(mapApiMessage)
					.filter((message): message is Message => message != null) ?? [];

			const streamed = options?.preserveStreamedAssistant;
			if (streamed?.content.trim()) {
				const lastAssistantIndex = loaded.findLastIndex(
					(message) => message.role === "assistant",
				);
				if (lastAssistantIndex >= 0) {
					const existing = loaded[lastAssistantIndex]!;
					if (streamed.content.length > existing.content.trim().length) {
						loaded = loaded.map((message, index) =>
							index === lastAssistantIndex
								? { ...message, content: streamed.content }
								: message,
						);
					}
				} else {
					loaded = [
						...loaded,
						{
							id: streamed.id,
							role: "assistant" as const,
							content: streamed.content,
						},
					];
				}
			}

			setMessages(loaded);
		} finally {
			if (options?.showLoading && viewThreadIdRef.current === id) {
				setLoadingThread(false);
			}
		}
	}

	function shouldSkipThreadReload(id: string) {
		const activeStreamId = streamThreadIdRef.current ?? streamingThreadId;
		return (
			streamThreadLockRef.current &&
			isLoading &&
			activeStreamId != null &&
			id === activeStreamId
		);
	}

	useEffect(() => {
		if (!threadId) {
			if (streamThreadLockRef.current && activeStreamRef.current?.pendingId) {
				return;
			}
			setMessages([]);
			setLoadingThread(false);
			return;
		}
		if (shouldSkipThreadReload(threadId)) return;

		let cancelled = false;
		void (async () => {
			if (cancelled) return;
			await loadThreadMessages(threadId, { showLoading: true });
		})();

		return () => {
			cancelled = true;
		};
	}, [threadId, isLoading, streamingThreadId]);

	useEffect(() => {
		if (!threadId || loadingThread || shouldSkipThreadReload(threadId)) return;
		if (messages.length > 0) return;
		void loadThreadMessages(threadId, { showLoading: true });
	}, [threadId, loadingThread, isLoading, streamingThreadId, messages.length]);

	useEffect(() => {
		if (conversationActive && messages.length > 0) {
			messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
		}
	}, [messages, isLoading, activity, conversationActive, showKeySetup]);

	async function uploadFile(file: File) {
		setActivity(`Uploading ${file.name}...`);
		const res = await fetch("/api/agent/attachments", {
			method: "POST",
			headers: {
				"content-type": file.type || "application/octet-stream",
				"x-file-name": file.name,
			},
			body: await file.arrayBuffer(),
		});
		if (!res.ok) throw new Error(await res.text());
		const data = (await res.json()) as { attachment: { id: string; name: string } };
		setAttachments((current) => [...current, data.attachment.id]);
		setMessages((current) => [
			...current,
			{
				id: crypto.randomUUID(),
				role: "assistant",
				content: `Attached ${data.attachment.name}`,
			},
		]);
		setActivity("");
	}

	async function sendMessage(
		text = input,
		options?: {
			skipUserBubble?: boolean;
			retryAfterProviderSetup?: boolean;
			userInputResponse?: AgentUserInputResponse;
		},
	) {
		const trimmed = text.trim();
		if (!trimmed || isLoading) return;

		const assistantId = crypto.randomUUID();
		let assistantText = "";
		const requestThreadId = threadIdRef.current;
		const isNewSession = !requestThreadId;
		const pendingId = isNewSession ? `pending-${assistantId}` : null;
		const provisionalTitle =
			trimmed.split(/\s+/).slice(0, 8).join(" ").slice(0, 72) || "New session";
		const streamMessages = [
			...(options?.skipUserBubble
				? messages
				: [
						...messages,
						{ id: crypto.randomUUID(), role: "user" as const, content: trimmed },
					]),
			{ id: assistantId, role: "assistant" as const, content: "" },
		];
		activeStreamRef.current = {
			pendingId,
			threadId: requestThreadId,
			assistantId,
			assistantText: "",
			messages: streamMessages,
			activity: "Thinking...",
			toolInProgress: false,
		};
		setMessages(streamMessages);
		setInput("");
		setFollowUps([]);
		setIsLoading(true);
		setStreamingAssistantId(assistantId);
		setActivity("Thinking...");
		setSetupPending(false);
		setWaitingForKey(false);
		setShowKeySetup(false);
		setMcqPrompt(null);
		setUserInputRequest(null);
		streamThreadLockRef.current = true;
		if (pendingId) {
			const now = new Date().toISOString();
			viewThreadIdRef.current = pendingId;
			setPendingSession({ id: pendingId, title: provisionalTitle, updatedAt: now });
			setStreamingThreadId(pendingId);
			streamThreadIdRef.current = pendingId;
		} else {
			viewThreadIdRef.current = requestThreadId;
			setStreamingThreadId(requestThreadId);
			streamThreadIdRef.current = requestThreadId;
		}
		setToolInProgress(false);

		let setupRequired = false;
		try {
			const res = await fetch("/api/agent/message", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					text: trimmed,
					threadId: requestThreadId,
					attachmentIds: attachments,
					deepResearch,
					retryAfterProviderSetup: options?.retryAfterProviderSetup ?? false,
					userInputResponse: options?.userInputResponse,
				}),
			});
			if (!res.ok || !res.body) throw new Error(await res.text());

			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			while (true) {
				const read = await reader.read();
				if (read.done) break;
				buffer += decoder.decode(read.value, { stream: true });
				const frames = buffer.split("\n\n");
				buffer = frames.pop() || "";
				for (const frame of frames) {
					const line = frame.split("\n").find((item) => item.startsWith("data: "));
					if (!line) continue;
					const envelope = JSON.parse(line.slice(6));
					if (envelope.threadId) {
						const resolvedId = envelope.threadId;
						if (streamThreadIdRef.current !== resolvedId) {
							const streamIsVisible = isViewingActiveStream(
								viewThreadIdRef.current ?? pendingId,
								resolvedId,
								pendingId,
							);
							streamThreadIdRef.current = resolvedId;
							setStreamingThreadId(resolvedId);
							setPendingSession(null);
							patchActiveStream(assistantId, (snapshot) => ({
								...snapshot,
								threadId: resolvedId,
							}));
							upsertThread({
								id: resolvedId,
								title: provisionalTitle,
								updatedAt: new Date().toISOString(),
							});
							void refreshThreads();
							if (streamIsVisible) {
								threadIdRef.current = resolvedId;
								viewThreadIdRef.current = resolvedId;
								setThreadId(resolvedId);
								const url = new URL(window.location.href);
								url.searchParams.set("thread", resolvedId);
								window.history.replaceState(null, "", url);
							}
						}
					}
					const event = envelope.event;
					const streamId =
						envelope.threadId ?? streamThreadIdRef.current ?? pendingId;
					const updateView = isViewingActiveStream(
						viewThreadIdRef.current ?? pendingId,
						streamId,
						pendingId,
					);
					if (event?.kind === "thread_title" && envelope.threadId) {
						patchThreadTitle(envelope.threadId, event.title);
					}
					if (event?.kind === "assistant_delta" && updateView) {
						setToolInProgress(false);
						assistantText += event.text;
						patchActiveStreamAssistant(assistantId, event.text, "append");
						setMessages((current) =>
							current.map((message) =>
								message.id === assistantId
									? { ...message, content: message.content + event.text }
									: message,
							),
						);
					}
					if (event?.kind === "assistant_delta" && !updateView) {
						assistantText += event.text;
						patchActiveStreamAssistant(assistantId, event.text, "append");
					}
					if (event?.kind === "assistant_message" && event.text?.trim() && updateView) {
						setToolInProgress(false);
						assistantText = event.text;
						patchActiveStreamAssistant(assistantId, event.text, "replace");
						setMessages((current) =>
							current.map((message) =>
								message.id === assistantId
									? { ...message, content: event.text }
									: message,
							),
						);
					}
					if (event?.kind === "assistant_message" && event.text?.trim() && !updateView) {
						assistantText = event.text;
						patchActiveStreamAssistant(assistantId, event.text, "replace");
					}
					if (event?.kind === "tool_start" && updateView) {
						const nextActivity =
							activityFromToolEvent(event.detail, event.toolName) || "Working";
						setToolInProgress(true);
						setActivity(nextActivity);
						patchActiveStream(assistantId, (snapshot) => ({
							...snapshot,
							activity: nextActivity,
							toolInProgress: true,
						}));
					}
					if (event?.kind === "tool_start" && !updateView) {
						const nextActivity =
							activityFromToolEvent(event.detail, event.toolName) || "Working";
						patchActiveStream(assistantId, (snapshot) => ({
							...snapshot,
							activity: nextActivity,
							toolInProgress: true,
						}));
					}
					if (event?.kind === "tool_end" && updateView) {
						setToolInProgress(true);
						setActivity("Thinking...");
						patchActiveStream(assistantId, (snapshot) => ({
							...snapshot,
							activity: "Thinking...",
							toolInProgress: true,
						}));
					}
					if (event?.kind === "tool_end" && !updateView) {
						patchActiveStream(assistantId, (snapshot) => ({
							...snapshot,
							activity: "Thinking...",
							toolInProgress: true,
						}));
					}
					if (event?.kind === "provider_setup_required" && updateView) {
						setupRequired = true;
						setSetupPending(true);
						setWaitingForKey(true);
						setActivity(event.waitingLabel || "Waiting for the key");
						setPendingResendText(trimmed);
						if (event.canConfigure && canConfigureOpenRouter) {
							setShowKeySetup(true);
						}
					}
					if (event?.kind === "provider_setup_required" && !updateView) {
						setupRequired = true;
						patchActiveStream(assistantId, (snapshot) => ({
							...snapshot,
							activity: event.waitingLabel || "Waiting for the key",
							toolInProgress: false,
						}));
					}
					if (event?.kind === "user_input_required" && updateView) {
						setupRequired = true;
						const request = {
							field: event.field,
							prompt: event.prompt,
							waitingLabel: event.waitingLabel,
							placeholder: event.placeholder,
							submitLabel: event.submitLabel,
							inputType: event.inputType,
							secret: event.secret,
							options: event.options,
							context: event.context,
						};
						setSetupPending(true);
						setActivity(event.waitingLabel || "Waiting for project name");
						setUserInputRequest(request);
						setMessages((current) =>
							current.map((message) =>
								message.id === assistantId
									? { ...message, userInputRequest: request }
									: message,
							),
						);
						patchActiveStream(assistantId, (snapshot) => ({
							...snapshot,
							activity: event.waitingLabel || "Waiting for project name",
							toolInProgress: false,
							messages: snapshot.messages.map((message) =>
								message.id === assistantId
									? { ...message, userInputRequest: request }
									: message,
							),
						}));
					}
					if (event?.kind === "user_input_required" && !updateView) {
						setupRequired = true;
						const request = {
							field: event.field,
							prompt: event.prompt,
							waitingLabel: event.waitingLabel,
							placeholder: event.placeholder,
							submitLabel: event.submitLabel,
							inputType: event.inputType,
							secret: event.secret,
							options: event.options,
							context: event.context,
						};
						patchActiveStream(assistantId, (snapshot) => ({
							...snapshot,
							activity: event.waitingLabel || "Waiting for project name",
							toolInProgress: false,
							messages: snapshot.messages.map((message) =>
								message.id === assistantId
									? { ...message, userInputRequest: request }
									: message,
							),
						}));
					}
					if (event?.kind === "error" && updateView) {
						patchActiveStreamAssistant(assistantId, event.message, "append");
						setMessages((current) =>
							current.map((message) =>
								message.id === assistantId
									? { ...message, content: message.content + event.message }
									: message,
							),
						);
					}
					if (event?.kind === "error" && !updateView) {
						patchActiveStreamAssistant(assistantId, event.message, "append");
					}
				}
			}
			if (
				!setupPending &&
				!setupRequired &&
				isViewingActiveStream(viewThreadIdRef.current, streamThreadIdRef.current)
			) {
				const followUpRes = await fetch("/api/agent/follow-up-suggestions", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						userMessage: trimmed,
						assistantMessage: assistantText,
						recentUserMessages: messages
							.filter((message) => message.role === "user")
							.slice(-6)
							.map((message) => message.content),
					}),
				});
				if (followUpRes.ok) {
					const data = (await followUpRes.json()) as { suggestions?: string[] };
					setFollowUps((data.suggestions ?? []).slice(0, 4));
				}
			}
			await refreshThreads();
		} finally {
			streamThreadLockRef.current = false;
			const finishedThreadId =
				activeStreamRef.current?.threadId ?? streamThreadIdRef.current;
			const viewingFinished =
				finishedThreadId != null &&
				viewThreadIdRef.current === finishedThreadId;
			setStreamingThreadId(null);
			streamThreadIdRef.current = null;
			setPendingSession(null);
			setToolInProgress(false);
			setIsLoading(false);
			setStreamingAssistantId(null);
			setAttachments([]);
			if (activeStreamRef.current?.assistantId === assistantId) {
				activeStreamRef.current = null;
			}
			if (viewingFinished && !setupRequired) {
				setActivity("");
			}
		}
	}

	async function handleUserInputSubmit(
		request: AgentUserInputRequest,
		value: string,
	) {
		if (request.secret) {
			throw new Error("Secret inputs must use a dedicated settings form.");
		}
		const trimmed = value.trim();
		const selectedOption = request.options?.find(
			(option) => option.value === trimmed,
		);
		if (
			request.field === "gitProviderId" &&
			(selectedOption?.action === "connectGitProvider" ||
				trimmed.startsWith("connect:"))
		) {
			const providerType =
				selectedOption?.providerType ?? trimmed.replace(/^connect:/, "");
			const label = selectedOption?.label ?? "Git provider";
			const target = new URL(
				selectedOption?.href || "/dashboard/settings/git-providers",
				window.location.origin,
			);
			target.searchParams.set("connect", providerType);
			target.searchParams.set(
				"returnTo",
				`${window.location.pathname}${window.location.search}`,
			);
			writePendingGitProviderConnect({
				threadId: threadIdRef.current,
				request,
				value: trimmed,
				label,
				savedAt: Date.now(),
			});
			setSetupPending(true);
			setUserInputRequest(request);
			setActivity(`Waiting for ${label} connection`);
			window.location.assign(target.toString());
			return;
		}
		setSetupPending(false);
		setUserInputRequest(null);
		setActivity("");
		const displayText =
			request.field === "projectName"
				? `Project name: ${trimmed}`
				: (selectedOption?.label ?? trimmed);
		await sendMessage(displayText, {
			userInputResponse: {
				field: request.field,
				value: trimmed,
				secret: false,
				context: request.context,
			},
		});
	}

	async function handleKeySaved() {
		setSetupPending(false);
		setWaitingForKey(false);
		setShowKeySetup(false);
		setMcqPrompt(null);
		setActivity("");
		const resend = pendingResendText;
		setPendingResendText(null);
		if (resend) {
			await sendMessage(resend, {
				skipUserBubble: true,
				retryAfterProviderSetup: true,
			});
		}
	}

	function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			if (canSend) void sendMessage();
		}
	}

	function startNewChat() {
		setThreadId(null);
		threadIdRef.current = null;
		viewThreadIdRef.current = null;
		setPendingSession(null);
		setMessages([]);
		setInput("");
		setFollowUps([]);
		setAttachments([]);
		setActivity("");
		setStreamingAssistantId(null);
		setShowKeySetup(false);
		setUserInputRequest(null);
		setMcqPrompt(null);
		setWaitingForKey(false);
		setPendingResendText(null);
		setSetupPending(false);
		setLoadingThread(false);
		const url = new URL(window.location.href);
		url.searchParams.delete("thread");
		window.history.replaceState(null, "", url);
	}

	function selectThread(nextThreadId: string) {
		if (nextThreadId.startsWith("pending-")) return;
		const isReselect = nextThreadId === threadId;
		if (isReselect && messages.length > 0) return;
		viewThreadIdRef.current = nextThreadId;
		const selectingActiveStream = activeStreamMatchesThread(nextThreadId);
		if (!isReselect) {
			threadIdRef.current = nextThreadId;
			setThreadId(nextThreadId);
		}
		setFollowUps([]);
		setAttachments([]);
		setStreamingAssistantId(
			selectingActiveStream ? activeStreamRef.current?.assistantId ?? null : null,
		);
		setShowKeySetup(false);
		setUserInputRequest(null);
		setMcqPrompt(null);
		setWaitingForKey(false);
		setPendingResendText(null);
		setSetupPending(false);
		const url = new URL(window.location.href);
		url.searchParams.set("thread", nextThreadId);
		window.history.replaceState(null, "", url);
		if (selectingActiveStream && activeStreamRef.current) {
			setMessages(activeStreamRef.current.messages);
			setActivity(activeStreamRef.current.activity);
			setToolInProgress(activeStreamRef.current.toolInProgress);
			return;
		}
		if (!shouldSkipThreadReload(nextThreadId)) {
			setActivity("");
			void loadThreadMessages(nextThreadId, { showLoading: true });
		}
	}

	const composerAccessoryOpen = Boolean(mcqPrompt);
	const mainComposerPlaceholder = composerAccessoryOpen
		? "Or reply directly…"
		: "Ask Nearzero about deployments, logs, or infrastructure.";

	const inputBox = (
		<div
			className={[
				"overflow-hidden border border-[var(--nz-border)] bg-[var(--nz-agent-composer-bg)]",
				composerAccessoryOpen ? "rounded-b-md rounded-t-none border-t-0" : "rounded-md",
			].join(" ")}
		>
			<textarea
				value={input}
				onChange={(event) => setInput(event.target.value)}
				onKeyDown={handleKeyDown}
				className="min-h-[104px] w-full resize-none bg-transparent px-4 pb-2 pt-4 text-xs leading-relaxed text-[var(--nz-text)] outline-none placeholder:text-[var(--nz-text-subtle)]"
				placeholder={mainComposerPlaceholder}
				aria-label={subtitle}
			/>
			<div className="flex items-center gap-1.5 px-3 pb-3">
				<input
					ref={fileRef}
					type="file"
					className="hidden"
					onChange={(event) => {
						const file = event.target.files?.[0];
						if (file) void uploadFile(file);
						event.currentTarget.value = "";
					}}
				/>
				<button
					type="button"
					onClick={() => fileRef.current?.click()}
					className="flex items-center justify-center rounded-md px-2 py-1 text-[var(--nz-text-muted)] transition hover:bg-[var(--nz-bg-hover)] hover:text-[var(--nz-text)]"
					aria-label="Attach file"
				>
					<AttachIcon />
				</button>
				<button
					type="button"
					onClick={() => setDeepResearch((value) => !value)}
					className={[
						"rounded-md border px-2 py-1 text-xs transition",
						deepResearch
							? "border-[var(--nz-primary)] bg-[var(--nz-primary)] text-[var(--nz-primary-fg)]"
							: "border-[var(--nz-border)] text-[var(--nz-text-muted)] hover:bg-[var(--nz-bg-hover)] hover:text-[var(--nz-text)]",
					].join(" ")}
				>
					Deep research
				</button>
				<div className="flex-1" />
				<button
					type="button"
					disabled={!canSend}
					onClick={() => void sendMessage()}
					className="flex items-center justify-center rounded-md px-2 py-1 text-[var(--nz-text-subtle)] transition hover:text-[var(--nz-text)] disabled:opacity-30"
					aria-label={isLoading ? "Sending" : "Send message"}
				>
					<SendIcon />
				</button>
			</div>
		</div>
	);

	const composerStack = (
		<div className="nz-agent-composer-stack w-full shrink-0">
			<AgentComposerAccessorySlide open={composerAccessoryOpen}>
				{mcqPrompt ? (
					<AgentComposerOptionsAccessory
						question={mcqPrompt.question}
						options={mcqPrompt.options}
						onSelect={() => {
							// Wired when agent emits MCQ prompts over SSE.
							setMcqPrompt(null);
						}}
						onDismiss={() => setMcqPrompt(null)}
					/>
				) : null}
			</AgentComposerAccessorySlide>
			{inputBox}
		</div>
	);

	const composerEase = [0.25, 0.1, 0.25, 1] as const;
	const visibleFollowUps = followUps.slice(0, 4);

	return (
		<div className="nz-agent-conversation-layout flex h-full min-h-0 w-full">
			<AgentSessionsPanel
				activeThreadId={threadId ?? pendingSession?.id ?? null}
				streamingThreadId={streamingThreadId}
				pendingSession={pendingSession}
				onNewSession={startNewChat}
				onSelectThread={selectThread}
				onThreadArchived={(archivedId) => {
					if (archivedId === threadId) startNewChat();
				}}
			/>
			<div className="nz-agent-chat">
				<main className="mx-auto flex h-full min-h-0 w-full max-w-[920px] flex-col px-5 py-6">
				<section
					className={
						conversationActive
							? "flex min-h-0 flex-1 flex-col overflow-hidden"
							: "flex min-h-0 flex-1 flex-col justify-center"
					}
				>
					<div
						className={
							conversationActive
								? "flex min-h-0 flex-1 flex-col overflow-hidden text-left"
								: "text-center"
						}
					>
						{loadingThread ? (
							<div className="flex flex-1 items-center justify-center py-12 text-xs text-[var(--nz-text-muted)]">
								Loading session…
							</div>
						) : null}

						{conversationActive && !loadingThread ? (
							<div className="scrollbar-hide flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-y-contain pb-5 [scrollbar-gutter:stable]">
								{messages.map((message, index) => {
									const previousSameRole =
										index > 0 && messages[index - 1]?.role === message.role;
									const showRoleLabel = !previousSameRole;
									const isStreaming =
										isLoading &&
										message.role === "assistant" &&
										message.id === streamingAssistantId;
									const isLastAssistant =
										message.role === "assistant" &&
										!messages.slice(index + 1).some((m) => m.role === "assistant");
									const assistantHasText = message.content.trim().length > 0;
									const inputRequestForMessage =
										message.role === "assistant"
											? message.userInputRequest ??
												(isLastAssistant ? userInputRequest : null)
											: null;
									const showActivityRow =
										(isStreaming && isLastAssistant) ||
										(waitingForKey && isLastAssistant) ||
										Boolean(inputRequestForMessage && isLastAssistant);
									const statusLabel =
										inputRequestForMessage?.waitingLabel ||
										activity ||
										"Thinking...";

									if (
										message.role === "assistant" &&
										!assistantHasText &&
										!showActivityRow &&
										!inputRequestForMessage
									) {
										return null;
									}

									return (
										<div
											key={message.id}
											className={[
												"grid grid-cols-[64px_minmax(0,1fr)] gap-4",
												previousSameRole ? "-mt-2" : "",
											].join(" ")}
										>
											<p className="pt-0.5 text-[11px] font-medium uppercase tracking-wide text-[var(--nz-text-subtle)]">
												{showRoleLabel
													? message.role === "user"
														? "User"
														: "Agent"
													: ""}
											</p>
											{message.role === "user" ? (
												<p className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--nz-text)]">
													{message.content}
												</p>
											) : (
												<div className="text-sm text-[var(--nz-text)]">
													{assistantHasText ? (
														<AgentChatMarkdown markdown={message.content} />
													) : null}
													<AgentSourcesRow sources={message.sources ?? []} />
													{showActivityRow ? (
														<div
															className={
																assistantHasText
																	? "mt-2 text-xs text-[var(--nz-text-muted)]"
																	: "text-xs text-[var(--nz-text-muted)]"
															}
														>
															<span className="nz-agent-key-shimmer">
																{statusLabel}
															</span>
														</div>
													) : null}
													{waitingForKey &&
													showKeySetup &&
													canConfigureOpenRouter &&
													isLastAssistant ? (
														<AgentMessageInputPrompt
															inputType="password"
															ariaLabel="OpenRouter API key"
															onSubmit={async (apiKey) => {
																await saveOpenRouterKey(apiKey);
																await handleKeySaved();
															}}
														/>
													) : null}
													{inputRequestForMessage && isLastAssistant ? (
														<AgentMessageInputPrompt
															field={inputRequestForMessage.field}
															inputType={inputRequestForMessage.inputType ?? "text"}
															prompt={inputRequestForMessage.prompt}
															placeholder={
																inputRequestForMessage.placeholder ?? "Enter a value"
															}
															submitLabel={
																inputRequestForMessage.submitLabel ?? "Continue"
															}
															options={inputRequestForMessage.options}
															ariaLabel={inputRequestForMessage.prompt}
															onSubmit={(value) =>
																handleUserInputSubmit(inputRequestForMessage, value)
															}
														/>
													) : null}
												</div>
											)}
										</div>
									);
								})}

								{visibleFollowUps.length > 0 ? (
									<div className="space-y-2">
										<p className="text-[11px] font-medium uppercase tracking-wide text-[var(--nz-text-subtle)]">
											Follow up with Agent
										</p>
										<div className="flex flex-wrap gap-2">
											{visibleFollowUps.map((followUp) => (
												<button
													key={followUp}
													type="button"
													onClick={() => void sendMessage(followUp)}
													className="rounded-full border border-[var(--nz-border)] bg-[var(--nz-bg-elevated)] px-3 py-1.5 text-xs text-[var(--nz-text-muted)] transition hover:bg-[var(--nz-bg-hover)] hover:text-[var(--nz-text)]"
												>
													{followUp}
												</button>
											))}
										</div>
									</div>
								) : null}

								<div ref={messagesEndRef} className="h-px w-full shrink-0" aria-hidden="true" />
							</div>
						) : null}

						{!conversationActive && !loadingThread ? (
							<motion.div
								initial={{ opacity: 0, y: 8 }}
								animate={{ opacity: 1, y: 0 }}
								className="mb-8"
							>
								<h1 className="font-display text-[clamp(1.25rem,2.5vw,1.75rem)] font-semibold leading-snug tracking-tight text-[var(--nz-text)]">
									{title}
								</h1>
							</motion.div>
						) : null}

						<motion.div
							initial={false}
							animate={{ marginTop: conversationActive ? 20 : 32 }}
							transition={{
								marginTop: { duration: 0.28, ease: composerEase },
							}}
							className="w-full shrink-0"
						>
							{composerStack}
						</motion.div>

						{!conversationActive && !loadingThread ? (
							<div className="mt-6 grid gap-3 sm:grid-cols-2">
								{suggestions.map((suggestion) => (
									<button
										key={suggestion.text}
										type="button"
										onClick={() => void sendMessage(suggestion.text)}
										className="flex items-start gap-2 rounded-md px-2 py-1 text-left text-xs leading-snug text-[var(--nz-text-muted)] transition hover:bg-[var(--nz-bg-hover)] hover:text-[var(--nz-text)]"
									>
										<SuggestionIcon name={suggestion.icon} />
										<span>{suggestion.text}</span>
									</button>
								))}
							</div>
						) : null}
					</div>
				</section>
				</main>
			</div>
		</div>
	);
}

export function AgentHomeAsk(props: Props) {
	return (
		<AgentThreadsProvider>
			<AgentHomeAskInner {...props} />
		</AgentThreadsProvider>
	);
}
