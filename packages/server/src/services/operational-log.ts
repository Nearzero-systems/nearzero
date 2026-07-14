const SECRET_VALUE_PATTERN =
	/((?:api[_-]?key|token|secret|password|passwd|pwd|private[_-]?key|credential|authorization)\s*[=:]\s*)(["']?)[^\s"',;]+/gi;
const PRIVATE_KEY_BLOCK_PATTERN =
	/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi;
const BEARER_PATTERN = /(bearer\s+)[a-z0-9._~+/=-]+/gi;
const BASIC_PATTERN = /(basic\s+)[a-z0-9._~+/=-]+/gi;
const CREDENTIAL_URL_PATTERN = /((?:https?|ssh):\/\/)([^/\s:@]+):([^@\s/]+)@/gi;
const COMMON_SECRET_TOKEN_PATTERN =
	/\b(?:sk-(?:proj-)?[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9_]{16,}|github_pat_[a-z0-9_]{16,}|glpat-[a-z0-9_-]{16,}|xox[baprs]-[a-z0-9-]{16,}|polar_oat_[a-z0-9_-]{16,}|phc_[a-z0-9_-]{16,}|GOCSPX-[a-z0-9_-]{16,}|AKIA[A-Z0-9]{16})\b/gi;
const JWT_PATTERN = /\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/gi;
const ANSI_COLOR_PATTERN = new RegExp("\\u001b\\[[0-9;]*m", "g");
const LOCAL_WORKSPACE_PATTERN =
	/\/Users\/[^/\s]+\/(?:Desktop|Documents|Downloads|Projects)\/[^\s'"]+/g;
const USER_HOME_PATTERN = /\/Users\/[^/\s]+/g;
const UNSAFE_ERROR_METADATA_PATTERN =
	/(?:failed\s+query:|\bparams?\s*:|command\s+(?:execution\s+)?failed|\bstd(?:out|err)\s*:|docker\s+login)/i;

export function sanitizeOperationalLogLine(value: unknown): string {
	const input = String(value ?? "");
	const home = process.env.HOME;
	return input
		.replace(PRIVATE_KEY_BLOCK_PATTERN, "[redacted private key]")
		.replace(SECRET_VALUE_PATTERN, "$1$2[redacted]")
		.replace(BEARER_PATTERN, "$1[redacted]")
		.replace(BASIC_PATTERN, "$1[redacted]")
		.replace(CREDENTIAL_URL_PATTERN, "$1[credentials-redacted]@")
		.replace(COMMON_SECRET_TOKEN_PATTERN, "[redacted token]")
		.replace(JWT_PATTERN, "[redacted token]")
		.replace(LOCAL_WORKSPACE_PATTERN, "[workspace]")
		.replace(
			home
				? new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")
				: /$^/,
			"<home>",
		)
		.replace(USER_HOME_PATTERN, "<home>")
		.replace(ANSI_COLOR_PATTERN, "")
		.replace(/\r/g, "\n")
		.replace(/\n{4,}/g, "\n\n\n");
}

/**
 * Sanitize an error before it crosses an API, queue, notification, or console
 * boundary. Database and process errors often embed complete SQL parameters or
 * commands, where individual secret values cannot be identified reliably, so
 * those messages are replaced rather than partially redacted.
 */
export function sanitizePublicErrorMessage(
	value: unknown,
	fallback = "Operation failed. Check the server logs for details.",
): string {
	const sanitized = sanitizeOperationalLog(value).trim();
	if (!sanitized || UNSAFE_ERROR_METADATA_PATTERN.test(sanitized)) {
		return fallback;
	}
	return sanitized.slice(0, 1_000);
}

export function sanitizeOperationalLog(value: unknown): string {
	return String(value ?? "")
		.split("\n")
		.map((line) => sanitizeOperationalLogLine(line))
		.join("\n");
}
