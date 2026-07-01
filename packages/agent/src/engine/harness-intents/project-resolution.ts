export type ProjectSummary = {
	projectId: string;
	name: string;
};

const DELETE_VERB =
	/\b(remove|delete|drop|destroy|get rid of|eliminate|clear)\b/i;

const SERVICE_SCOPED_TARGETS =
	/\b(services?|deployment|environment|container|database|redis|postgres|mysql|mongo|application|compose|log|server|domain|key)\b/i;

const DELETE_PREFIX =
	/^(?:can you|could you|please|would you|can u|could u)?\s*(?:remove|delete|drop|destroy|get rid of|eliminate|clear)\s+(?:the\s+)?(?:project\s+)?/i;

const MAX_SHORT_HINT_WORDS = 4;

export function hasDeleteVerb(text: string) {
	return DELETE_VERB.test(text.trim());
}

/** Projects whose names appear in user text (longest name first). */
export function findProjectsMentionedInText(
	projects: ProjectSummary[],
	text: string,
): ProjectSummary[] {
	const normalized = text.toLowerCase();
	return projects
		.filter((project) => normalized.includes(project.name.toLowerCase()))
		.sort((a, b) => b.name.length - a.name.length);
}

function cleanShortHint(value: string | undefined) {
	const hint = String(value ?? "")
		.trim()
		.replace(/\s*[.?!]+\s*$/g, "")
		.replace(
			/\s+(?:and(?:\s+then)?|then)\s+(?:make|create|add|start|set up|setup)\b[\s\S]*$/i,
			"",
		)
		.replace(/\s+and\s+(?:the\s+)?project(?:\s+as well|\s+too)?\s*$/i, "")
		.replace(/\s+(?:for me|from nearzero|from the dashboard|in nearzero)\s*$/i, "")
		.replace(/^(?:the\s+)?project\s+/i, "")
		.replace(/\s+project$/i, "")
		.trim();
	if (!hint || /^(this|that|it|the project)$/i.test(hint)) return null;
	return hint;
}

function extractShortDeleteHint(text: string): string | null {
	const trimmed = text.trim();
	if (!hasDeleteVerb(trimmed)) return null;

	const match = trimmed.match(
		/(?:can you|could you|please|would you)?\s*(?:remove|delete|drop|destroy|get rid of|eliminate|clear)\s+(?:the\s+)?(?:project\s+)?(.+?)(?:\s+project)?\s*[.?!]*$/i,
	);
	const raw = cleanShortHint(match?.[1] ?? trimmed.replace(DELETE_PREFIX, ""));
	if (!raw) return null;
	if (SERVICE_SCOPED_TARGETS.test(raw)) return null;
	if (raw.split(/\s+/).length > MAX_SHORT_HINT_WORDS) return null;
	return raw;
}

function isServiceOnlyDeleteIntent(
	text: string,
	mentioned: ProjectSummary[],
) {
	if (mentioned.length > 0) return false;
	return SERVICE_SCOPED_TARGETS.test(text);
}

function matchProjectByShortHint(projects: ProjectSummary[], hint: string) {
	const needle = hint.trim().toLowerCase();
	if (!needle) return { kind: "skip" as const };

	const exact = projects.find(
		(project) => project.name.toLowerCase() === needle,
	);
	if (exact) return { kind: "match" as const, project: exact };

	const partial = projects.filter((project) =>
		project.name.toLowerCase().includes(needle),
	);
	if (partial.length === 1) {
		return { kind: "match" as const, project: partial[0]! };
	}
	if (partial.length > 1) {
		return {
			kind: "ambiguous" as const,
			names: partial.map((project) => project.name),
		};
	}
	return { kind: "explicitMiss" as const, hint };
}

export type ResolveProjectForDeleteResult =
	| { kind: "skip" }
	| { kind: "match"; project: ProjectSummary }
	| { kind: "ambiguous"; names: string[] }
	| { kind: "explicitMiss"; hint: string };

export function resolveProjectForDelete(
	text: string,
	projects: ProjectSummary[],
): ResolveProjectForDeleteResult {
	if (!hasDeleteVerb(text)) return { kind: "skip" };

	const mentioned = findProjectsMentionedInText(projects, text);
	if (mentioned.length === 1) {
		return { kind: "match", project: mentioned[0]! };
	}
	if (mentioned.length > 1) {
		return {
			kind: "ambiguous",
			names: mentioned.map((project) => project.name),
		};
	}

	if (isServiceOnlyDeleteIntent(text, mentioned)) {
		return { kind: "skip" };
	}

	const shortHint = extractShortDeleteHint(text);
	if (!shortHint) return { kind: "skip" };

	return matchProjectByShortHint(projects, shortHint);
}
