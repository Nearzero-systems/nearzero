import { normalizeDashboardPath } from "./org-routes";

export type DashboardRouteContext = {
	section?: "projects" | "project" | "environment" | "service";
	projectId?: string;
	environmentId?: string;
	serviceType?: string;
	serviceId?: string;
};

const PROJECT_RE =
	/\/dashboard\/project\/([^/]+)(?:\/environment\/([^/]+)(?:\/services\/([^/]+)\/([^/]+))?)?/;
const PROJECTS_RE = /\/dashboard\/projects\/?$/;

export function parseDashboardPath(pathname: string): DashboardRouteContext {
	const { dashboardPath } = normalizeDashboardPath(pathname);
	const normalized = dashboardPath.replace(/\/$/, "") || "/";
	if (PROJECTS_RE.test(normalized)) {
		return { section: "projects" };
	}
	const match = normalized.match(PROJECT_RE);
	if (!match) return {};
	const [, projectId, environmentId, serviceType, serviceId] = match;
	if (serviceType && serviceId) {
		return {
			section: "service",
			projectId,
			environmentId,
			serviceType,
			serviceId,
		};
	}
	if (environmentId) {
		return { section: "environment", projectId, environmentId };
	}
	if (projectId) {
		return { section: "project", projectId };
	}
	return {};
}
