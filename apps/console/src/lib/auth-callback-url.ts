/** Resolve a post-auth path to an absolute same-origin callback URL. */
export function toConsoleCallbackUrl(path: string, siteOrigin: string) {
	const fallback = `${siteOrigin.replace(/\/$/, "")}/dashboard/agent`;
	if (!path.trim()) return fallback;
	try {
		const target = new URL(path, `${siteOrigin}/`);
		if (target.origin !== siteOrigin) return fallback;
		return target.toString();
	} catch {
		return fallback;
	}
}
