export const PROJECT_WORKSPACE_SECTIONS = [
	{ id: "overview", label: "Overview" },
	{ id: "services", label: "Services" },
] as const;

export type ProjectWorkspaceSection =
	(typeof PROJECT_WORKSPACE_SECTIONS)[number]["id"];

const SECTION_IDS = new Set<string>(
	PROJECT_WORKSPACE_SECTIONS.map((item) => item.id),
);

export function isProjectWorkspaceSection(
	value: string | undefined,
): value is ProjectWorkspaceSection {
	return Boolean(value && SECTION_IDS.has(value));
}

export function normalizeProjectWorkspaceSection(
	value: string | undefined,
): ProjectWorkspaceSection {
	return isProjectWorkspaceSection(value) ? value : "overview";
}

export function projectWorkspaceHref(
	projectId: string,
	environmentId: string,
	section: ProjectWorkspaceSection = "overview",
): string {
	return `/dashboard/project/${projectId}/environment/${environmentId}/${section}`;
}

export function environmentApplicationNewHref(
	projectId: string,
	environmentId: string,
): string {
	return `/dashboard/project/${projectId}/environment/${environmentId}/services/application/new`;
}

export function environmentApplicationHref(
	projectId: string,
	environmentId: string,
	applicationId: string,
	query?: string,
): string {
	const base = `/dashboard/project/${projectId}/environment/${environmentId}/services/application/${applicationId}`;
	return query ? `${base}?${query}` : base;
}
