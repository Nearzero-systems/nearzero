const GENERIC_PROJECT_NAMES = new Set([
	"new project",
	"my project",
	"untitled",
	"untitled project",
	"project",
	"a project",
	"a new project",
	"new",
	"default project",
	"another project",
]);

/** True when the agent must ask the user for a real project name. */
export function needsProjectNameFromUser(name: string | undefined | null) {
	const trimmed = String(name ?? "").trim();
	if (!trimmed) return true;
	const lower = trimmed.toLowerCase();
	if (GENERIC_PROJECT_NAMES.has(lower)) return true;
	if (/^new\s+project(\s*\d*)?$/i.test(trimmed)) return true;
	if (/^my\s+project(\s*\d*)?$/i.test(trimmed)) return true;
	if (/^project\s*\d+$/i.test(trimmed)) return true;
	if (/^untitled(\s+project)?(\s*\d*)?$/i.test(trimmed)) return true;
	return false;
}
