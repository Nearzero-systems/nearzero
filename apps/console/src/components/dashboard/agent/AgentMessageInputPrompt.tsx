import { trpcMutate } from "@/lib/client-api";
import { gitProviderUiOption } from "@/lib/git-provider-ui";
import {
	useEffect,
	useRef,
	useState,
	type CSSProperties,
	type KeyboardEvent,
} from "react";

type Props = {
	field?: string;
	prompt?: string;
	placeholder?: string;
	submitLabel?: string;
	inputType?: "text" | "password";
	options?: Array<{
		label: string;
		value: string;
		description?: string;
		action?: "submit" | "connectGitProvider";
		providerType?: "github" | "gitlab" | "bitbucket" | "gitea";
		href?: string;
	}>;
	ariaLabel?: string;
	onSubmit: (value: string) => Promise<void>;
};

export async function saveOpenRouterKey(apiKey: string) {
	if (apiKey.trim().length < 8) {
		throw new Error("Enter a valid OpenRouter API key.");
	}
	await trpcMutate("organizationSettings.setOrgOpenRouterKey", {
		apiKey: apiKey.trim(),
	});
}

/** Inline input row — lives in the message thread below agent status text. */
export function AgentMessageInputPrompt({
	field,
	prompt,
	placeholder = "sk-or-...",
	submitLabel = "Continue",
	inputType = "password",
	options,
	ariaLabel = "Value",
	onSubmit,
}: Props) {
	const [value, setValue] = useState("");
	const [error, setError] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [waitingLabel, setWaitingLabel] = useState("");
	const inputRef = useRef<HTMLInputElement | null>(null);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	async function handleSubmit() {
		const trimmed = value.trim();
		if (!trimmed) {
			setError("Enter a value to continue.");
			return;
		}
		setSubmitting(true);
		setWaitingLabel("");
		setError("");
		try {
			await onSubmit(trimmed);
			setValue("");
		} catch (submitError) {
			setError(
				submitError instanceof Error ? submitError.message : "Something went wrong.",
			);
		} finally {
			setSubmitting(false);
		}
	}

	function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
		if (event.key === "Enter") {
			event.preventDefault();
			void handleSubmit();
		}
	}

	const canSubmit = !submitting && value.trim().length > 0;
	const optionMode = Boolean(options?.length);
	const selectMode = Boolean(options && options.length > 8);
	const gitProviderMode =
		field === "gitProviderId" &&
		Boolean(options?.some((option) => option.providerType));
	const gitProviderColumnCount = Math.max(
		1,
		Math.min(options?.length ?? 1, 4),
	);

	return (
		<div className="nz-agent-message-input mt-3 w-full">
			{prompt ? (
				<p className="mb-1.5 text-xs text-[var(--nz-text-muted)]">{prompt}</p>
			) : null}
			{gitProviderMode ? (
				<div
					className="grid gap-2"
					style={
						{
							gridTemplateColumns: `repeat(${gitProviderColumnCount}, minmax(0, 1fr))`,
						} as CSSProperties
					}
				>
					{options?.map((option) => {
						const provider = gitProviderUiOption(option.providerType);
						const label = provider?.label ?? option.label;
						const waitsForExternalConnection =
							option.action === "connectGitProvider" ||
							option.value.startsWith("connect:");
						return (
							<button
								key={option.value}
								type="button"
								disabled={submitting}
								onClick={async () => {
									setSubmitting(true);
									setWaitingLabel(waitsForExternalConnection ? label : "");
									setError("");
									try {
										await onSubmit(option.value);
										if (!waitsForExternalConnection) {
											setSubmitting(false);
											setWaitingLabel("");
										}
									} catch (submitError) {
										setError(
											submitError instanceof Error
												? submitError.message
												: "Something went wrong.",
										);
										setSubmitting(false);
										setWaitingLabel("");
									}
								}}
								className="group inline-flex min-h-[58px] min-w-0 items-center gap-2 rounded-md border border-[var(--nz-border)] bg-[var(--nz-bg-elevated)] px-3 py-2 text-left text-xs text-[var(--nz-text)] shadow-none transition hover:border-[var(--nz-border-strong)] hover:bg-[var(--nz-bg-hover)] disabled:opacity-60"
								style={
									provider
										? ({ "--nz-provider-accent": provider.accent } as CSSProperties)
										: undefined
								}
							>
								<span className="flex min-w-0 flex-1 items-center gap-2">
									<span className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[var(--nz-border)] bg-[var(--nz-bg)] text-[var(--nz-provider-accent,var(--nz-text))]">
										{provider ? (
											<svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
												<path fill="currentColor" d={provider.iconPath} />
											</svg>
										) : null}
									</span>
									<span className="min-w-0">
										<span className="block truncate font-medium">{label}</span>
										<span className="mt-0.5 block truncate text-[10px] leading-snug text-[var(--nz-text-muted)]">
											{submitting && waitingLabel === label
												? "Waiting..."
												: option.description}
										</span>
									</span>
								</span>
							</button>
						);
					})}
					{waitingLabel ? (
						<div
							style={{ gridColumn: `span ${gitProviderColumnCount} / span ${gitProviderColumnCount}` }}
						>
							<div className="mt-1 inline-flex items-center rounded-md border border-[var(--nz-border)] bg-[var(--nz-bg-elevated)] px-3 py-2 text-[11px] text-[var(--nz-text-muted)]">
								<span>{`Waiting for ${waitingLabel} connection...`}</span>
							</div>
						</div>
					) : null}
				</div>
			) : selectMode ? (
				<div className="nz-agent-message-input__row flex w-full items-center gap-1 py-1 pl-1 pr-1">
					<select
						value={value}
						onChange={(event) => setValue(event.target.value)}
						disabled={submitting}
						className="nz-agent-message-input__field min-w-0 flex-1 px-2 py-1"
						aria-label={ariaLabel}
					>
						<option value="">Select an option</option>
						{options?.map((option) => (
							<option key={option.value} value={option.value}>
								{option.label}
							</option>
						))}
					</select>
					<button
						type="button"
						disabled={!canSubmit}
						onClick={() => void handleSubmit()}
						className="nz-agent-message-input__submit shrink-0 rounded-md px-2 py-1 text-xs font-medium"
					>
						{submitting ? "Saving..." : submitLabel}
					</button>
				</div>
			) : optionMode ? (
				<div className="flex flex-wrap gap-2">
					{options?.map((option) => (
						<button
							key={option.value}
							type="button"
							disabled={submitting}
							onClick={async () => {
								setSubmitting(true);
								setError("");
								try {
									await onSubmit(option.value);
								} catch (submitError) {
									setError(
										submitError instanceof Error
											? submitError.message
											: "Something went wrong.",
									);
								} finally {
									setSubmitting(false);
								}
							}}
							className="inline-flex min-h-10 max-w-full flex-col justify-center rounded-md border border-[var(--nz-border)] bg-[var(--nz-bg-elevated)] px-3 py-2 text-left text-xs text-[var(--nz-text)] transition hover:bg-[var(--nz-bg-hover)] disabled:opacity-50"
						>
							<span className="font-medium">{option.label}</span>
							{option.description ? (
								<span className="mt-0.5 text-[11px] text-[var(--nz-text-muted)]">
									{option.description}
								</span>
							) : null}
						</button>
					))}
				</div>
			) : (
				<div className="nz-agent-message-input__row flex w-full items-center gap-1 py-1 pl-1 pr-1">
					<span className="nz-agent-message-input__icon flex shrink-0 items-center justify-center">
						<svg
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.8"
							className="h-3.5 w-3.5"
							aria-hidden="true"
						>
							<path
								d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						</svg>
					</span>
					<input
						ref={inputRef}
						type={inputType}
						value={value}
						onChange={(event) => setValue(event.target.value)}
						onKeyDown={handleKeyDown}
						placeholder={placeholder}
						autoComplete="off"
						disabled={submitting}
						className="nz-agent-message-input__field min-w-0 flex-1 px-2 py-1"
						aria-label={ariaLabel}
					/>
					<button
						type="button"
						disabled={!canSubmit}
						onClick={() => void handleSubmit()}
						className="nz-agent-message-input__submit shrink-0 rounded-md px-2 py-1 text-xs font-medium"
					>
						{submitting ? "Saving..." : submitLabel}
					</button>
				</div>
			)}
			{error ? (
				<p className="nz-agent-message-input__error mt-1.5 text-[11px]" role="alert">
					{error}
				</p>
			) : null}
		</div>
	);
}
