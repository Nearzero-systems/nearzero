export { hasDeleteVerb, resolveProjectForDelete } from "./project-resolution";
export type { ProjectSummary, ResolveProjectForDeleteResult } from "./project-resolution";

export function formatHarnessFailureReply(
	projectName: string,
	failure: { message: string; guidance?: string },
) {
	const lines = [`Could not delete **${projectName}**: ${failure.message}`];
	if (failure.guidance) lines.push(failure.guidance);
	return lines.join("\n\n");
}
