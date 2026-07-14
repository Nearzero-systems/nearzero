import { sanitizeOperationalLogLine } from "./operational-log";

/**
 * A safe, structured explanation derived from a bounded build-log excerpt.
 * Values in this type are intentionally constrained before they can be
 * persisted or appended to a deployment log.
 */
export type BuildFailureDiagnostic = {
	code: "npm_eresolve_peer_dependency_conflict";
	packageManager: "npm";
	resolving: string | null;
	found: string | null;
	peerRequirement: string;
	requiredBy: string;
	message: string;
	guidance: string;
};

const MAX_LOG_CHARS = 128 * 1024;
const MAX_DIAGNOSTIC_VALUE_CHARS = 240;
const ANSI_COLOR_SEQUENCE = new RegExp(
	`${String.fromCharCode(27)}\\[[0-9;]*m`,
	"g",
);

function safeDiagnosticValue(value: string | undefined) {
	if (!value) return null;
	const sanitized = sanitizeOperationalLogLine(value)
		.replace(/[\r\n\t]+/g, " ")
		.replace(/[^\w@./^~|=*+\-: ]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_DIAGNOSTIC_VALUE_CHARS);
	return sanitized || null;
}

function valueAfterLabel(lines: string[], label: string) {
	const expression = new RegExp(`\\b${label}:\\s*(.+)$`, "i");
	for (const line of lines) {
		const value = line.match(expression)?.[1];
		if (value) return safeDiagnosticValue(value);
	}
	return null;
}

function peerConflictEvidence(lines: string[]) {
	for (const line of lines) {
		const match = line.match(/\bpeer\s+(.+?)\s+from\s+(.+?)\s*$/i);
		if (!match) continue;
		const peerRequirement = safeDiagnosticValue(match[1]);
		const requiredBy = safeDiagnosticValue(match[2]);
		if (peerRequirement && requiredBy) {
			return { peerRequirement, requiredBy };
		}
	}
	return null;
}

/**
 * Recognize npm's peer-dependency resolver failure without retaining a raw
 * build-log excerpt. The parser is intentionally narrow: generic ERESOLVE
 * failures are left untouched unless npm reports a concrete peer requirement.
 */
export function diagnoseBuildFailureLog(
	logExcerpt: string,
): BuildFailureDiagnostic | null {
	const log = logExcerpt
		.slice(-MAX_LOG_CHARS)
		.replace(ANSI_COLOR_SEQUENCE, "")
		.replace(/\r\n?/g, "\n");
	const isNpmEresolve = /\bnpm\s+(?:ERR!|error)\s+(?:code\s+)?ERESOLVE\b/i.test(
		log,
	);
	const hasResolutionFailure =
		/\bCould not resolve dependency\b/i.test(log) ||
		/\bERESOLVE unable to resolve dependency tree\b/i.test(log);
	if (!isNpmEresolve || !hasResolutionFailure) return null;

	const lines = log.split("\n");
	const peerConflict = peerConflictEvidence(lines);
	if (!peerConflict) return null;

	const resolving = valueAfterLabel(lines, "While resolving");
	const found = valueAfterLabel(lines, "Found");
	const details = [
		resolving ? `While resolving ${resolving}.` : null,
		found ? `Found ${found}.` : null,
		`${peerConflict.peerRequirement} is required by ${peerConflict.requiredBy}.`,
	]
		.filter(Boolean)
		.join(" ");
	const guidance =
		"Align the affected package versions and regenerate the canonical lockfile. Do not use --force or --legacy-peer-deps unless you intentionally accept an unsupported dependency graph.";

	return {
		code: "npm_eresolve_peer_dependency_conflict",
		packageManager: "npm",
		resolving,
		found,
		peerRequirement: peerConflict.peerRequirement,
		requiredBy: peerConflict.requiredBy,
		message: `npm could not resolve incompatible peer dependencies. ${details} ${guidance}`,
		guidance,
	};
}

export function formatBuildFailureDiagnostic(
	diagnostic: BuildFailureDiagnostic,
) {
	return [
		"Nearzero dependency diagnosis",
		diagnostic.message,
		`Code: ${diagnostic.code}`,
		"",
	].join("\n");
}
