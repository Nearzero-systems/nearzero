/** Human-readable labels for application/compose/database runtime status. */
export const SERVICE_STATUS_LABELS: Record<string, string> = {
	idle: "Not running",
	running: "Deploying",
	done: "Running",
	error: "Error",
};

export const SERVICE_STATUS_BADGE: Record<string, string> = {
	idle: "bg-secondary text-secondary-foreground",
	running:
		"bg-yellow-600/20 dark:bg-yellow-500/15 dark:text-yellow-500 text-yellow-600",
	done: "bg-emerald-600/20 dark:bg-emerald-500/15 dark:text-emerald-500 text-emerald-600",
	error: "bg-red-600/20 dark:bg-red-500/15 text-destructive",
};

export const SERVICE_STATUS_BADGE_BASE =
	"inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap";

export function normalizeServiceStatus(
	status: string | null | undefined,
): string {
	const raw = (status ?? "idle").trim().toLowerCase();
	return raw || "idle";
}

export function formatServiceStatusLabel(
	status: string | null | undefined,
): string {
	const key = normalizeServiceStatus(status);
	return SERVICE_STATUS_LABELS[key] ?? key.replace(/_/g, " ");
}

export function serviceStatusBadgeClass(
	status: string | null | undefined,
): string {
	const key = normalizeServiceStatus(status);
	return (
		SERVICE_STATUS_BADGE[key] ?? "bg-secondary text-secondary-foreground"
	);
}

export function formatServiceSource(source: string | null | undefined): string {
	const value = (source ?? "").trim();
	if (!value || value === "—") return "—";
	return value.replace(/_/g, " ");
}

export function isServiceDeleteDisabled(
	status: string | null | undefined,
): boolean {
	const key = normalizeServiceStatus(status);
	return key === "running" || key === "done";
}

export function serviceDeleteDisabledReason(
	status: string | null | undefined,
): string {
	const key = normalizeServiceStatus(status);
	if (key === "running") {
		return "Wait for deployment to finish before deleting this service.";
	}
	if (key === "done") {
		return "Stop the service before deleting it.";
	}
	return "";
}
