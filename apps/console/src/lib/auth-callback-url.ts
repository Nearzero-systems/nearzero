export const DEFAULT_AUTH_CALLBACK_PATH = "/dashboard/agent";

const RESERVED_ORGANIZATION_SEGMENTS = new Set([
	"api",
	"register",
	"login",
	"invitation",
	"dashboard",
	"accept-invitation",
	"nearzero",
	"_astro",
]);

function isDashboardCallbackPath(pathname: string) {
	if (pathname === "/dashboard" || pathname.startsWith("/dashboard/")) {
		return true;
	}

	const match = pathname.match(/^\/([a-zA-Z0-9_-]+)\/dashboard(?:\/|$)/);
	return Boolean(
		match?.[1] && !RESERVED_ORGANIZATION_SEGMENTS.has(match[1].toLowerCase()),
	);
}

function isAllowedAuthCallback(target: URL) {
	if (isDashboardCallbackPath(target.pathname)) return true;
	if (target.pathname === "/register") return true;
	return (
		target.pathname === "/invitation" &&
		Boolean(target.searchParams.get("token")?.trim())
	);
}

/**
 * Keep post-auth navigation on a known console route.
 *
 * Callbacks must be root-relative paths. This deliberately rejects absolute,
 * protocol-relative and scheme URLs even when they happen to name this origin.
 */
export function sanitizeAuthCallbackPath(
	raw: string | null | undefined,
	site: URL | string,
	fallback = DEFAULT_AUTH_CALLBACK_PATH,
) {
	const value = String(raw ?? "").trim();
	if (!value.startsWith("/") || value.startsWith("//")) return fallback;

	try {
		const base = site instanceof URL ? site : new URL(site);
		if (base.protocol !== "http:" && base.protocol !== "https:") {
			return fallback;
		}
		const target = new URL(value, base.origin);
		if (target.origin !== base.origin || !isAllowedAuthCallback(target)) {
			return fallback;
		}
		return `${target.pathname}${target.search}${target.hash}`;
	} catch {
		return fallback;
	}
}

/** Resolve a permitted post-auth path to an absolute console callback URL. */
export function toConsoleCallbackUrl(path: string, siteOrigin: string) {
	const site = new URL(siteOrigin);
	const safePath = sanitizeAuthCallbackPath(path, site);
	return new URL(safePath, site.origin).toString();
}
