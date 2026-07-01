import { scopeDashboardHref } from "@/lib/org-routes";

export const DASHBOARD_FRAGMENT_HEADER = "x-nearzero-dashboard-fragment";

export type DashboardAsyncRouteId =
	| "dashboard:about-nearzero"
	| "dashboard:agent"
	| "dashboard:analytics"
	| "dashboard:deployments"
	| "dashboard:domains"
	| "dashboard:home"
	| "dashboard:monitoring"
	| "dashboard:projects"
	| "dashboard:servers"
	| "dashboard:tasks"
	| "dashboard:traefik"
	| "dashboard:settings-agent"
	| "dashboard:settings-audit-logs"
	| "dashboard:settings-git-providers"
	| "dashboard:settings-notifications"
	| "dashboard:settings-profile"
	| "dashboard:settings-tags"
	| "dashboard:settings-users"
	| "dashboard:project-environment-section"
	| "dashboard:application-new"
	| "dashboard:application-detail"
	| "dashboard:compose-detail"
	| "dashboard:database-detail";

export type DashboardAsyncParams = Record<string, string | null | undefined>;

const SIMPLE_ROUTES: Record<
	Exclude<
		DashboardAsyncRouteId,
		| "dashboard:project-environment-section"
		| "dashboard:application-new"
		| "dashboard:application-detail"
		| "dashboard:compose-detail"
		| "dashboard:database-detail"
	>,
	string
> = {
	"dashboard:about-nearzero": "/dashboard/about-nearzero",
	"dashboard:agent": "/dashboard/agent",
	"dashboard:analytics": "/dashboard/analytics",
	"dashboard:deployments": "/dashboard/deployments",
	"dashboard:domains": "/dashboard/domains",
	"dashboard:home": "/dashboard/home",
	"dashboard:monitoring": "/dashboard/monitoring",
	"dashboard:projects": "/dashboard/projects",
	"dashboard:servers": "/dashboard/servers",
	"dashboard:tasks": "/dashboard/tasks",
	"dashboard:traefik": "/dashboard/traefik",
	"dashboard:settings-agent": "/dashboard/settings/agent",
	"dashboard:settings-audit-logs": "/dashboard/settings/audit-logs",
	"dashboard:settings-git-providers": "/dashboard/settings/git-providers",
	"dashboard:settings-notifications": "/dashboard/settings/notifications",
	"dashboard:settings-profile": "/dashboard/settings/profile",
	"dashboard:settings-tags": "/dashboard/settings/tags",
	"dashboard:settings-users": "/dashboard/settings/users",
};

const DATABASE_VARIANTS = new Set([
	"libsql",
	"mariadb",
	"mongo",
	"mysql",
	"postgres",
	"redis",
]);

const WORKSPACE_SECTIONS = new Set([
	"overview",
	"services",
	"domains",
	"analytics",
	"logs",
	"env",
]);

function requiredParam(params: DashboardAsyncParams, key: string) {
	const value = params[key]?.trim();
	if (!value) throw new Error(`Missing dashboard route param: ${key}`);
	return encodeURIComponent(value);
}

function optionalSearch(search: string | null | undefined) {
	const raw = typeof search === "string" ? search.trim() : "";
	if (!raw) return "";
	return raw.startsWith("?") ? raw : `?${raw}`;
}

function safeSection(params: DashboardAsyncParams) {
	const raw = params.section?.trim().toLowerCase() || "overview";
	if (!WORKSPACE_SECTIONS.has(raw)) return "overview";
	return encodeURIComponent(raw);
}

export function dashboardAsyncPath(
	routeId: DashboardAsyncRouteId,
	params: DashboardAsyncParams = {},
	search?: string | null,
) {
	if (routeId in SIMPLE_ROUTES) {
		return `${SIMPLE_ROUTES[routeId as keyof typeof SIMPLE_ROUTES]}${optionalSearch(search)}`;
	}

	const projectId = requiredParam(params, "projectId");
	const environmentId = requiredParam(params, "environmentId");
	const base = `/dashboard/project/${projectId}/environment/${environmentId}`;

	if (routeId === "dashboard:project-environment-section") {
		return `${base}/${safeSection(params)}${optionalSearch(search)}`;
	}

	if (routeId === "dashboard:application-new") {
		return `${base}/services/application/new${optionalSearch(search)}`;
	}

	if (routeId === "dashboard:application-detail") {
		return `${base}/services/application/${requiredParam(params, "applicationId")}${optionalSearch(search)}`;
	}

	if (routeId === "dashboard:compose-detail") {
		return `${base}/services/compose/${requiredParam(params, "composeId")}${optionalSearch(search)}`;
	}

	if (routeId === "dashboard:database-detail") {
		const variant = params.variant?.trim().toLowerCase() || "";
		if (!DATABASE_VARIANTS.has(variant)) {
			throw new Error("Invalid database service variant");
		}
		const dbId = requiredParam(params, "dbId");
		return `${base}/services/${encodeURIComponent(variant)}/${dbId}${optionalSearch(search)}`;
	}

	throw new Error(`Unknown dashboard route: ${routeId}`);
}

export function scopedDashboardAsyncPath(
	routeId: DashboardAsyncRouteId,
	params: DashboardAsyncParams = {},
	search?: string | null,
	orgSlug?: string | null,
) {
	return scopeDashboardHref(dashboardAsyncPath(routeId, params, search), orgSlug);
}

export function isDashboardFragmentRequest(request: Request) {
	return request.headers.get(DASHBOARD_FRAGMENT_HEADER) === "1";
}
