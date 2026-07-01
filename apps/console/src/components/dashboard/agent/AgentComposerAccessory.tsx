import { AnimatePresence, motion } from "framer-motion";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export type AgentComposerOption = {
	id: string;
	label: string;
};

type OptionsAccessoryProps = {
	question: string;
	options: AgentComposerOption[];
	onSelect: (optionId: string) => void;
	customPlaceholder?: string;
	onCustomSubmit?: (value: string) => void;
	onSkip?: () => void;
	onDismiss?: () => void;
};

function KeyBadge({ n }: { n: number }) {
	return (
		<span
			className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded border border-[var(--nz-border)] bg-[var(--nz-bg-elevated)] px-1 text-[10px] font-medium tabular-nums text-[var(--nz-text-muted)] shadow-[0_1px_0_var(--nz-border)]"
			aria-hidden="true"
		>
			{n}
		</span>
	);
}

/** MCQ keyboard accessory — slides up above the composer (not used for direct text input). */
export function AgentComposerOptionsAccessory({
	question,
	options,
	onSelect,
	customPlaceholder = "Something else",
	onCustomSubmit,
	onSkip,
	onDismiss,
}: OptionsAccessoryProps) {
	const [focusedIndex, setFocusedIndex] = useState(0);
	const [customValue, setCustomValue] = useState("");
	const customRef = useRef<HTMLInputElement | null>(null);

	return (
		<div className="nz-agent-composer-accessory overflow-hidden rounded-t-md border border-b-0 border-[var(--nz-border)] bg-[var(--nz-bg-elevated)]">
			<div className="flex items-start justify-between gap-2 border-b border-[var(--nz-border)] px-3 py-2.5">
				<p className="text-xs leading-relaxed text-[var(--nz-text)]">{question}</p>
				{onDismiss ? (
					<button
						type="button"
						onClick={onDismiss}
						className="mt-0.5 shrink-0 text-[var(--nz-text-subtle)] hover:text-[var(--nz-text)]"
						aria-label="Dismiss"
					>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3.5 w-3.5">
							<path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" />
						</svg>
					</button>
				) : null}
			</div>
			{options.map((option, index) => (
				<button
					key={option.id}
					type="button"
					onClick={() => onSelect(option.id)}
					onMouseEnter={() => setFocusedIndex(index)}
					className={[
						"flex w-full items-center gap-3 border-b border-[var(--nz-border)] px-3 py-2.5 text-left text-xs transition",
						focusedIndex === index
							? "bg-[var(--nz-bg-hover)] text-[var(--nz-text)]"
							: "text-[var(--nz-text-muted)] hover:bg-[var(--nz-bg-hover)] hover:text-[var(--nz-text)]",
					].join(" ")}
				>
					<KeyBadge n={index + 1} />
					<span className="flex-1">{option.label}</span>
					{focusedIndex === index ? (
						<span className="text-[10px] text-[var(--nz-text-subtle)]">↵</span>
					) : null}
				</button>
			))}
			{onCustomSubmit ? (
				<div className="flex items-center gap-2 border-b border-[var(--nz-border)] px-3 py-2.5">
					<span className="flex h-5 w-5 shrink-0 items-center justify-center text-[var(--nz-text-subtle)]">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3.5 w-3.5" aria-hidden="true">
							<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" strokeLinecap="round" strokeLinejoin="round" />
						</svg>
					</span>
					<input
						ref={customRef}
						type="text"
						value={customValue}
						onChange={(event) => setCustomValue(event.target.value)}
						onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
							if (event.key === "Enter" && customValue.trim()) {
								event.preventDefault();
								onCustomSubmit(customValue.trim());
								setCustomValue("");
							}
						}}
						placeholder={customPlaceholder}
						className="min-w-0 flex-1 bg-transparent text-xs text-[var(--nz-text)] outline-none placeholder:text-[var(--nz-text-subtle)]"
					/>
				</div>
			) : null}
			{onSkip ? (
				<div className="flex justify-end px-3 py-2">
					<button
						type="button"
						onClick={onSkip}
						className="text-[11px] text-[var(--nz-text-muted)] hover:text-[var(--nz-text)]"
					>
						Skip
					</button>
				</div>
			) : null}
		</div>
	);
}

type SlideProps = {
	open: boolean;
	children: ReactNode;
};

export function AgentComposerAccessorySlide({ open, children }: SlideProps) {
	return (
		<AnimatePresence initial={false}>
			{open ? (
				<motion.div
					key="composer-accessory"
					initial={{ height: 0, opacity: 0, y: 8 }}
					animate={{ height: "auto", opacity: 1, y: 0 }}
					exit={{ height: 0, opacity: 0, y: 8 }}
					transition={{ duration: 0.22, ease: [0.25, 0.1, 0.25, 1] }}
					className="overflow-hidden"
				>
					{children}
				</motion.div>
			) : null}
		</AnimatePresence>
	);
}

export type AgentMcqPrompt = {
	question: string;
	options: AgentComposerOption[];
};
