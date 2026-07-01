import { useEffect, useRef, useState } from "react";
import { useAgentThreads } from "./AgentThreadsContext";

function ChevronDownIcon() {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			className="h-4 w-4"
			aria-hidden="true"
		>
			<path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}

export function AgentConversationMenu({
	activeThreadId,
	onSelectThread,
	onNewChat,
}: {
	activeThreadId: string | null;
	onSelectThread: (threadId: string) => void;
	onNewChat?: () => void;
}) {
	const { threads, refreshThreads } = useAgentThreads();
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		void refreshThreads();
	}, [refreshThreads]);

	useEffect(() => {
		if (!open) return;
		function handlePointerDown(event: MouseEvent) {
			if (!rootRef.current?.contains(event.target as Node)) {
				setOpen(false);
			}
		}
		document.addEventListener("mousedown", handlePointerDown);
		return () => document.removeEventListener("mousedown", handlePointerDown);
	}, [open]);

	return (
		<div ref={rootRef} className="relative inline-block">
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				className="flex items-center gap-1.5 text-sm font-medium text-neutral-950 transition hover:text-neutral-600"
				aria-expanded={open}
				aria-haspopup="listbox"
			>
				New chat
				<ChevronDownIcon />
			</button>

			{open ? (
				<div className="absolute left-0 top-full z-20 mt-2 w-80 overflow-hidden rounded-md border border-neutral-200 bg-white shadow-lg">
					<div className="px-4 pb-2 pt-4 text-[11px] font-medium uppercase tracking-[0.12em] text-neutral-400">
						Conversations
					</div>
					<div className="max-h-72 overflow-y-auto px-2 pb-2">
						{onNewChat ? (
							<button
								type="button"
								onClick={() => {
									onNewChat();
									setOpen(false);
								}}
								className="mb-1 w-full rounded-md px-3 py-2 text-left text-xs text-neutral-700 transition hover:bg-neutral-50"
							>
								Start a new chat
							</button>
						) : null}
						{threads.map((thread) => (
							<button
								key={thread.id}
								type="button"
								onClick={() => {
									onSelectThread(thread.id);
									setOpen(false);
								}}
								className={[
									"w-full rounded-md px-3 py-2 text-left text-xs transition",
									thread.id === activeThreadId
										? "bg-neutral-100 text-neutral-950"
										: "text-neutral-700 hover:bg-neutral-50",
								].join(" ")}
							>
								<span className="line-clamp-1">
									{thread.title || "Untitled conversation"}
								</span>
							</button>
						))}
						{threads.length === 0 ? (
							<div className="px-3 py-2 text-xs text-neutral-400">
								No conversations yet.
							</div>
						) : null}
					</div>
				</div>
			) : null}
		</div>
	);
}
