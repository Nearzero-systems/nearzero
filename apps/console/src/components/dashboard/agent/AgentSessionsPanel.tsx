import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentThreadSummary } from "./AgentThreadsContext";
import { useAgentThreads } from "./AgentThreadsContext";
import { AgentSessionStatusIcon } from "./AgentSessionMatrixIcon";
import {
	formatSessionRelativeTime,
	sortAgentThreads,
} from "@/lib/agent-sessions-ui";

function SessionTrashIcon() {
	return (
		<svg
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			className="h-3.5 w-3.5"
			aria-hidden="true"
		>
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				d="M2.5 4.5h11M5.5 4.5V3.75A.75.75 0 0 1 6.25 3h3.5a.75.75 0 0 1 .75.75V4.5M6.25 7v4.75M9.75 7v4.75M4 4.5l.45 8.1a.75.75 0 0 0 .75.7h6.6a.75.75 0 0 0 .75-.7L12.5 4.5"
			/>
		</svg>
	);
}

function SessionRow({
	thread,
	active,
	streaming,
	onSelect,
	onArchive,
	archiving,
}: {
	thread: AgentThreadSummary;
	active: boolean;
	streaming: boolean;
	onSelect: () => void;
	onArchive: () => void;
	archiving: boolean;
}) {
	const title = thread.title?.trim() || "Untitled session";
	const timeLabel = formatSessionRelativeTime(thread.updatedAt);

	return (
		<li>
			<div
				className={[
					"nz-agent-session-row group",
					active ? "nz-agent-session-row--active" : "",
					streaming ? "nz-agent-session-row--streaming" : "",
				]
					.filter(Boolean)
					.join(" ")}
			>
				<button
					type="button"
					onClick={onSelect}
					className="nz-agent-session-row__main"
					aria-current={active ? "true" : undefined}
				>
					<span className="nz-agent-session-row__icon">
						<AgentSessionStatusIcon streaming={streaming} />
					</span>
					<span className="nz-agent-session-row__title">{title}</span>
				</button>

				<div className="nz-agent-session-row__actions">
					{timeLabel ? (
						<span className="nz-agent-session-row__time">{timeLabel}</span>
					) : null}
					<button
						type="button"
						className="nz-agent-session-row__delete"
						disabled={archiving}
						onClick={(event) => {
							event.stopPropagation();
							onArchive();
						}}
						aria-label="Delete session"
						title="Delete"
					>
						<SessionTrashIcon />
					</button>
				</div>
			</div>
		</li>
	);
}

export function AgentSessionsPanel({
	activeThreadId,
	streamingThreadId = null,
	pendingSession = null,
	onSelectThread,
	onNewSession,
	onThreadArchived,
}: {
	activeThreadId: string | null;
	streamingThreadId?: string | null;
	pendingSession?: AgentThreadSummary | null;
	onSelectThread: (threadId: string) => void;
	onNewSession: () => void;
	onThreadArchived?: (threadId: string) => void;
}) {
	const { threads, refreshThreads } = useAgentThreads();
	const [archivingId, setArchivingId] = useState<string | null>(null);

	useEffect(() => {
		void refreshThreads();
	}, [refreshThreads]);

	const sortedThreads = useMemo(() => {
		const merged = [...threads];
		if (
			pendingSession &&
			!merged.some((thread) => thread.id === pendingSession.id)
		) {
			merged.unshift(pendingSession);
		}
		return sortAgentThreads(merged);
	}, [threads, pendingSession]);

	const handleArchive = useCallback(
		async (threadId: string) => {
			if (threadId.startsWith("pending-")) return;
			setArchivingId(threadId);
			try {
				const res = await fetch(`/api/agent/threads/${threadId}`, {
					method: "DELETE",
				});
				if (!res.ok) return;
				await refreshThreads();
				onThreadArchived?.(threadId);
			} finally {
				setArchivingId(null);
			}
		},
		[refreshThreads, onThreadArchived],
	);

	return (
		<aside
			id="nz-agent-sessions-panel"
			className="nz-agent-sessions"
			aria-label="Agent sessions"
		>
			<div className="nz-agent-sessions__header">
				<button
					type="button"
					onClick={onNewSession}
					className="nz-agent-sessions__new"
				>
					+ New session
				</button>
			</div>

			<div className="scrollbar-hide nz-agent-sessions__list min-h-0 flex-1 overflow-y-auto">
				{sortedThreads.length === 0 ? (
					<p className="nz-agent-sessions__empty">
						No sessions yet. Start one above.
					</p>
				) : (
					<ul>
						{sortedThreads.map((thread) => (
							<SessionRow
								key={thread.id}
								thread={thread}
								active={thread.id === activeThreadId}
								streaming={
									Boolean(streamingThreadId) &&
									thread.id === streamingThreadId
								}
								onSelect={() => onSelectThread(thread.id)}
								onArchive={() => void handleArchive(thread.id)}
								archiving={archivingId === thread.id}
							/>
						))}
					</ul>
				)}
			</div>
		</aside>
	);
}
