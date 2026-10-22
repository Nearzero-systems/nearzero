export type ProjectSummary = {
	projectId: string;
	name: string;
};

const DELETE_VERB = /\b(remove|delete|drop|destroy|get rid of|eliminate)\b/i;

const NEGATED_REQUEST =
	/\b(?:don'?t|do not|never|not|without|shouldn'?t|keep)\b/i;

const SERVICE_SCOPED_TARGETS =
	/\b(services?|deployments?|environments?|containers?|databases?|redis|postgres|mysql|mongo|applications?|apps?|compose|logs?|servers?|domains?|keys?|volumes?|backups?|branch(?:es)?|cache|env(?:ironment)? var(?:iable)?s?)\b/i;

const PROJECT_WORD = /\bprojects?\b/i;

const DELETE_PREFIX =
	/^(?:can you|could you|please|would you|can u|could u)?\s*(?:remove|delete|drop|destroy|get rid of|eliminate)\s+(?:the\s+)?(?:project\s+)?/i;

const MAX_SHORT_HINT_WORDS = 4;

export function hasDeleteVerb(text: string) {
	return DELETE_VERB.test(text.trim());
}

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function projectNamePattern(name: string) {
	// Whole-name match: "api" must not match inside "rapid" or "api-gateway".
	return new RegExp(
		`(?<![a-z0-9_-])${escapeRegExp(name.toLowerCase())}(?![a-z0-9_-])`,
		"g",
	);
}

/**
 * Projects whose full names appear in user text (longest name first). A
 * shorter name that only occurs inside a longer matched name is not counted.
 */
export function findProjectsMentionedInText(
	projects: ProjectSummary[],
	text: string,
): ProjectSummary[] {
	let remaining = text.toLowerCase();
	const mentioned: ProjectSummary[] = [];
	const byLength = [...projects]
		.filter((project) => project.name.trim())
		.sort((a, b) => b.name.length - a.name.length);
	for (const project of byLength) {
		const pattern = projectNamePattern(project.name);
		if (pattern.test(remaining)) {
			mentioned.push(project);
			remaining = remaining.replace(projectNamePattern(project.name), (match) =>
				" ".repeat(match.length),
			);
		}
	}
	return mentioned;
}

function textWithoutProjectNames(text: string, projects: ProjectSummary[]) {
	let remaining = text.toLowerCase();
	for (const project of projects) {
		remaining = remaining.replace(projectNamePattern(project.name), " ");
	}
	return remaining;
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
		.replace(
			/\s+(?:for me|from nearzero|from the dashboard|in nearzero)\s*$/i,
			"",
		)
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
		/(?:can you|could you|please|would you)?\s*(?:remove|delete|drop|destroy|get rid of|eliminate)\s+(?:the\s+)?(?:project\s+)?(.+?)(?:\s+project)?\s*[.?!]*$/i,
	);
	const raw = cleanShortHint(match?.[1] ?? trimmed.replace(DELETE_PREFIX, ""));
	if (!raw) return null;
	if (SERVICE_SCOPED_TARGETS.test(raw)) return null;
	if (raw.split(/\s+/).length > MAX_SHORT_HINT_WORDS) return null;
	return raw;
}

function isServiceOnlyDeleteIntent(text: string, mentioned: ProjectSummary[]) {
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
	// A partial name is never enough to delete: ask the user to confirm the
	// full name instead (an exact-name request then deletes it).
	if (partial.length >= 1) {
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
	// Leave negated or conditional phrasing ("don't delete web") to the model.
	if (NEGATED_REQUEST.test(text)) return { kind: "skip" };

	const mentioned = findProjectsMentionedInText(projects, text);
	if (mentioned.length === 1) {
		// "delete the redis service in shop" targets a service, not project
		// "shop": only delete when the project itself is the object.
		const rest = textWithoutProjectNames(text, mentioned);
		if (SERVICE_SCOPED_TARGETS.test(rest) && !PROJECT_WORD.test(rest)) {
			return { kind: "skip" };
		}
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
