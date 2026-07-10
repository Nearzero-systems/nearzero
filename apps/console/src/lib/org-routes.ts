const RESERVED_SEGMENTS = new Set([
	"api",
	"register",
	"login",
	"invitation",
	"dashboard",
	"accept-invitation",
	"_astro",
]);

export function normalizeDashboardPath(pathname: string) {
	const match = pathname.match(/^\/([^/]+)\/dashboard(\/.*)?$/);
	if (!match) {
		return {
			orgSlug: null as string | null,
			dashboardPath: pathname,
		};
	}

	const orgSlug = match[1] ?? null;
	const suffix = match[2] ?? "";
	return {
		orgSlug,
		dashboardPath: `/dashboard${suffix || ""}`,
	};
}

export function isOrgScopedDashboardPath(pathname: string) {
	const { orgSlug, dashboardPath } = normalizeDashboardPath(pathname);
	return Boolean(orgSlug && dashboardPath.startsWith("/dashboard"));
}

export function orgDashboardPath(orgSlug: string, dashboardPath = "/dashboard/agent") {
	const normalized = dashboardPath.startsWith("/dashboard")
		? dashboardPath
		: `/dashboard${dashboardPath.startsWith("/") ? dashboardPath : `/${dashboardPath}`}`;
	const suffix = normalized === "/dashboard" ? "/agent" : normalized.slice("/dashboard".length);
	return `/${orgSlug}/dashboard${suffix || ""}`;
}

export function isReservedOrgSegment(segment: string) {
	return RESERVED_SEGMENTS.has(segment.toLowerCase());
}

export function isDashboardRootPath(pathname: string) {
	const bare = pathname.replace(/\/$/, "") || "/";
	if (bare === "/dashboard") return true;

	const { orgSlug, dashboardPath } = normalizeDashboardPath(pathname);
	return Boolean(
		orgSlug && dashboardPath.replace(/\/$/, "") === "/dashboard",
	);
}

export function dashboardAgentPath(orgSlug?: string | null) {
	if (orgSlug?.trim()) {
		return orgDashboardPath(orgSlug.trim(), "/dashboard/agent");
	}
	return "/dashboard/agent";
}

/** Prefix internal dashboard paths with the active organization slug when present. */
export function scopeDashboardHref(path: string, orgSlug?: string | null) {
	if (!orgSlug?.trim() || !path.startsWith("/dashboard")) {
		return path;
	}
	return orgDashboardPath(orgSlug.trim(), path);
}
