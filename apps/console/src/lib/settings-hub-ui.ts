/** Shared layout tokens for settings hub — text-xs throughout. */
export const ST = {
	pageTitle: "text-base font-semibold tracking-tight text-[var(--nz-text)]",
	panel: "nz-settings-panel space-y-4 text-xs",
	toolbar: "flex flex-wrap items-center justify-between gap-2",
	toolbarEnd: "flex flex-wrap items-center gap-2",
	filters: "flex flex-wrap gap-2",
	filterBar:
		"nz-settings-filter-bar flex w-full flex-wrap items-center justify-between gap-2",
	filterSearch:
		"flex h-8 min-w-[10rem] flex-1 basis-[14rem] rounded-md border border-[var(--nz-border)] bg-transparent px-3 text-xs text-[var(--nz-text)] shadow-none outline-none placeholder:text-[var(--nz-text-subtle)] focus-visible:ring-1 focus-visible:ring-[var(--nz-border-strong)]",
	filterInput:
		"flex h-8 w-full md:max-w-[200px] rounded-md border border-[var(--nz-border)] bg-transparent px-3 text-xs text-[var(--nz-text)] shadow-none outline-none focus-visible:ring-1 focus-visible:ring-[var(--nz-border-strong)]",
	filterSelect:
		"inline-flex h-8 shrink-0 cursor-pointer items-center rounded-md border border-[var(--nz-border)] bg-transparent px-3 text-xs text-[var(--nz-text)] shadow-none outline-none focus-visible:ring-1 focus-visible:ring-[var(--nz-border-strong)]",
	filterBtn:
		"inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1 rounded-md border border-[var(--nz-border)] bg-transparent px-3 text-xs font-medium text-[var(--nz-text)] shadow-none transition-colors hover:bg-[var(--nz-bg-hover)]",
	tableWrap:
		"nz-settings-table-wrap rounded-md border border-[var(--nz-border)] bg-[var(--nz-surface)] !shadow-none",
	table:
		"nz-settings-table w-full border-collapse bg-[var(--nz-surface)] text-xs !shadow-none",
	thead: "border-b border-[var(--nz-border)] bg-[var(--nz-bg-muted)]",
	th: "h-8 px-3 text-left text-xs font-medium",
	thRight: "h-8 px-3 text-right text-xs font-medium",
	tr: "border-b",
	td: "p-3 align-middle text-xs",
	tdMuted: "p-3 text-xs text-muted-foreground align-middle whitespace-nowrap",
	tdRight: "p-3 text-right align-middle text-xs",
	footer: "flex items-center justify-between gap-2 flex-wrap",
	total: "text-xs text-muted-foreground",
	empty:
		"nz-settings-empty flex min-h-[min(50vh,28rem)] flex-col items-center justify-center gap-3 px-6 text-center text-xs",
	emptyText: "text-xs text-muted-foreground max-w-md",
	actionBtn:
		"nz-table-action-btn inline-flex h-7 items-center justify-center rounded-md px-2 text-xs text-muted-foreground hover:bg-[var(--nz-bg-hover)] hover:text-[var(--nz-text)]",
	stateMessage: "text-xs text-muted-foreground",
} as const;
