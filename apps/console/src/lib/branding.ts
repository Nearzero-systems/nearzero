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
