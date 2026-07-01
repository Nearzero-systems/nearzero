import {
	createContext,
	useCallback,
	useContext,
	useMemo,
	useState,
	type ReactNode,
} from "react";

export type AgentThreadSummary = {
	id: string;
	title?: string | null;
	updatedAt?: string | null;
};

type AgentThreadsContextValue = {
	threads: AgentThreadSummary[];
	refreshThreads: () => Promise<void>;
	patchThreadTitle: (threadId: string, title: string) => void;
	upsertThread: (thread: AgentThreadSummary) => void;
};

const AgentThreadsContext = createContext<AgentThreadsContextValue | null>(null);

export function AgentThreadsProvider({ children }: { children: ReactNode }) {
	const [threads, setThreads] = useState<AgentThreadSummary[]>([]);

	const refreshThreads = useCallback(async () => {
		const res = await fetch("/api/agent/threads");
		if (!res.ok) return;
		const data = (await res.json()) as { threads?: AgentThreadSummary[] };
		setThreads(data.threads ?? []);
	}, []);

	const patchThreadTitle = useCallback((threadId: string, title: string) => {
		setThreads((current) =>
			current.map((thread) =>
				thread.id === threadId ? { ...thread, title } : thread,
			),
		);
	}, []);

	const upsertThread = useCallback((thread: AgentThreadSummary) => {
		setThreads((current) => {
			const index = current.findIndex((item) => item.id === thread.id);
			if (index >= 0) {
				const next = [...current];
				next[index] = { ...next[index], ...thread };
				return next;
			}
			return [thread, ...current];
		});
	}, []);

	const value = useMemo(
		() => ({ threads, refreshThreads, patchThreadTitle, upsertThread }),
		[threads, refreshThreads, patchThreadTitle, upsertThread],
	);

	return (
		<AgentThreadsContext.Provider value={value}>
			{children}
		</AgentThreadsContext.Provider>
	);
}

export function useAgentThreads() {
	const value = useContext(AgentThreadsContext);
	if (!value) {
		throw new Error("useAgentThreads must be used inside AgentThreadsProvider");
	}
	return value;
}
