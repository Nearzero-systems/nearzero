const SECRET_VALUE_PATTERN =
	/((?:api[_-]?key|token|secret|password|passwd|pwd|private[_-]?key|credential|authorization)\s*[=:]\s*)(["']?)[^\s"',;]+/gi;
const PRIVATE_KEY_BLOCK_PATTERN =
	/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi;
const BEARER_PATTERN = /(bearer\s+)[a-z0-9._~+/=-]+/gi;
const BASIC_PATTERN = /(basic\s+)[a-z0-9._~+/=-]+/gi;
const CREDENTIAL_URL_PATTERN =
	/((?:https?|ssh):\/\/)([^/\s:@]+):([^@\s/]+)@/gi;
const LOCAL_WORKSPACE_PATTERN =
	/\/Users\/[^/\s]+\/(?:Desktop|Documents|Downloads|Projects)\/[^\s'"]+/g;
const USER_HOME_PATTERN = /\/Users\/[^/\s]+/g;

export function sanitizeOperationalLogLine(value: unknown): string {
	const input = String(value ?? "");
	const home = process.env.HOME;
	return input
		.replace(PRIVATE_KEY_BLOCK_PATTERN, "[redacted private key]")
		.replace(SECRET_VALUE_PATTERN, "$1$2[redacted]")
		.replace(BEARER_PATTERN, "$1[redacted]")
		.replace(BASIC_PATTERN, "$1[redacted]")
		.replace(CREDENTIAL_URL_PATTERN, "$1[credentials-redacted]@")
		.replace(LOCAL_WORKSPACE_PATTERN, "[workspace]")
		.replace(
			home
				? new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")
				: /$^/,
			"<home>",
		)
		.replace(USER_HOME_PATTERN, "<home>")
		.replace(/\u001b\[[0-9;]*m/g, "")
		.replace(/\r/g, "\n")
		.replace(/\n{4,}/g, "\n\n\n");
}

export function sanitizeOperationalLog(value: unknown): string {
	return String(value ?? "")
		.split("\n")
		.map((line) => sanitizeOperationalLogLine(line))
		.join("\n");
}
