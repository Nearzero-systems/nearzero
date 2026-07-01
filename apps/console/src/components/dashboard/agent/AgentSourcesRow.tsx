export type AgentSource = {
	title: string;
	url?: string;
};

const chipClass =
	"rounded-full border border-[var(--nz-border)] bg-[var(--nz-bg-elevated)] px-2 py-1 text-xs text-[var(--nz-text-muted)] transition hover:border-[var(--nz-border-strong)] hover:text-[var(--nz-text)]";

export function AgentSourcesRow({ sources }: { sources: AgentSource[] }) {
	if (!sources.length) return null;
	return (
		<div className="mt-3 flex flex-wrap gap-2">
			{sources.map((source) =>
				source.url ? (
					<a
						key={source.url}
						href={source.url}
						target="_blank"
						rel="noreferrer"
						className={chipClass}
					>
						{source.title}
					</a>
				) : (
					<span key={source.title} className={chipClass}>
						{source.title}
					</span>
				),
			)}
		</div>
	);
}
