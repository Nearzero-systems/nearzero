const SESSION_PATHS = new Set([
	"/register",
	"/login",
	"/invitation",
	"/setup",
	"/dashboard",
	"/dashboard/home",
]);

export function consolePathUsesSession(pathname: string) {
	if (SESSION_PATHS.has(pathname)) return true;
	if (pathname.startsWith("/dashboard/")) return true;
	if (pathname.startsWith("/setup")) return true;
	return false;
}

export const PUBLIC_ROUTES = [
	"/",
	"/register",
	"/login",
	"/invitation",
	"/setup",
	"/api/",
];
