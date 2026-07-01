/** Rewrite API-origin auth redirects to the console origin for split deploys. */
export function rewriteAuthRedirectLocation(
	location: string,
	requestOrigin: string,
	backendOrigin: string,
) {
	try {
		const target = new URL(location, `${backendOrigin}/`);
		if (target.origin !== backendOrigin) return null;
		return new URL(
			`${target.pathname}${target.search}${target.hash}`,
			`${requestOrigin}/`,
		).toString();
	} catch {
		return null;
	}
}
