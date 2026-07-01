import type { CSSProperties } from "react";

/** 3×3 "N" matrix — same layout as primary sidebar icon; animates only while streaming. */

const N_PHASE: Record<number, number> = {
	0: 0,
	2: 1,
	3: 2,
	4: 3,
	6: 4,
	8: 5,
};

function SessionIdleDot() {
	return (
		<span className="nz-agent-session-idle-dot" aria-hidden="true">
			<span className="nz-agent-session-idle-dot__core" />
		</span>
	);
}

export function AgentSessionMatrixIcon({ streaming }: { streaming: boolean }) {
	return (
		<span
			className={[
				"nz-agent-dot-matrix nz-agent-session-matrix inline-grid shrink-0 grid-cols-3 grid-rows-3 text-[var(--nz-text-muted)]",
				streaming ? "nz-agent-session-matrix--streaming" : "",
			]
				.filter(Boolean)
				.join(" ")}
			aria-hidden="true"
		>
			{Array.from({ length: 9 }, (_, index) => {
				const isN = index in N_PHASE;
				return (
					<span
						key={index}
						className={[
							"nz-agent-dot-matrix__cell",
							isN
								? "nz-agent-dot-matrix__cell--n"
								: "nz-agent-dot-matrix__cell--muted",
						].join(" ")}
						style={
							isN
								? ({ "--nz-agent-dot-phase": N_PHASE[index] } as CSSProperties)
								: ({ "--nz-agent-dot-i": index } as CSSProperties)
						}
					/>
				);
			})}
		</span>
	);
}

export function AgentSessionStatusIcon({ streaming }: { streaming: boolean }) {
	if (!streaming) return <SessionIdleDot />;
	return <AgentSessionMatrixIcon streaming />;
}
