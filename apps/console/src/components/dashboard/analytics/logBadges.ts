const badgeBase =
	"inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap transition-colors";

/** Shared HTTP status styling for SSR table rows + client detail pane. */
export function badgeClassForHttpStatus(status: number) {
	if (status === 0) {
		return `${badgeBase} border-transparent bg-secondary text-secondary-foreground`;
	}
	if (status >= 100 && status < 200) {
		return `${badgeBase} text-foreground`;
	}
	if (status >= 200 && status < 300) {
		return `${badgeBase} border-transparent bg-primary text-primary-foreground hover:bg-primary/80`;
	}
	if (status >= 300 && status < 400) {
		return `${badgeBase} text-foreground`;
	}
	if (status >= 400 && status < 500) {
		return `${badgeBase} border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/80`;
	}
	return `${badgeBase} border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/80`;
}
