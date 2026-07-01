export function formatSessionRelativeTime(iso?: string | null): string {
	if (!iso) return "";
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return "";
	const diffMs = Date.now() - then;
	if (diffMs < 60_000) return "now";
	const mins = Math.floor(diffMs / 60_000);
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d`;
	return new Date(iso).toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
	});
}

export function sortAgentThreads<T extends { updatedAt?: string | null }>(
	threads: T[],
): T[] {
	return [...threads].sort((a, b) => {
		const aTime = new Date(a.updatedAt ?? 0).getTime();
		const bTime = new Date(b.updatedAt ?? 0).getTime();
		return bTime - aTime;
	});
}
