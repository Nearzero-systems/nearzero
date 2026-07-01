export const APP_NAME = "Nearzero";
export const LOCAL_SERVER_LABEL = "Nearzero Server";

/** Browser tab title: `{page} - Nearzero` */
export function pageTitle(page: string) {
	return `${page} - ${APP_NAME}`;
}

export function normalizeExternalUrl(
	value: string | null | undefined,
	fallback: string,
): string {
	const trimmed = value?.trim();
	if (!trimmed || trimmed === "#") return fallback;
	return trimmed;
}

export const NEARZERO_DOCS_URL = normalizeExternalUrl(
	import.meta.env.PUBLIC_NEARZERO_DOCS_URL,
	"https://docs.nearzero.dev",
);
export const NEARZERO_GITHUB_URL = normalizeExternalUrl(
	import.meta.env.PUBLIC_NEARZERO_GITHUB_URL,
	"#",
);
export const NEARZERO_SUPPORT_URL = normalizeExternalUrl(
	import.meta.env.PUBLIC_NEARZERO_SUPPORT_URL,
	"mailto:support@nearzero.dev",
);
export const NEARZERO_ISSUES_URL = normalizeExternalUrl(
	import.meta.env.PUBLIC_NEARZERO_ISSUES_URL,
	"#",
);

export const BACKEND_URL =
	import.meta.env.BACKEND_URL ??
	import.meta.env.PUBLIC_BACKEND_URL ??
	"http://127.0.0.1:3000";

/**
 * Runtime mode flag. `COMMUNITY` defaults to community (self-hosted) mode;
 * setting `COMMUNITY=false` switches to the hosted variant.
 *
 * Astro/Vite loads `.env` values into `import.meta.env` (not `process.env`) for the
 * console SSR process, so we read from there first and fall back to `process.env`.
 */
function readCommunityFlag(): string | undefined {
	if (import.meta.env.COMMUNITY != null && import.meta.env.COMMUNITY !== "") {
		return String(import.meta.env.COMMUNITY);
	}
	if (typeof process !== "undefined" && process.env.COMMUNITY != null) {
		return process.env.COMMUNITY;
	}
	return undefined;
}

export const IS_COMMUNITY = readCommunityFlag() !== "false";
