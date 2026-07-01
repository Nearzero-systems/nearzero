const SESSION_PATHS = new Set([
	"/",
	"/register",
	"/login",
	"/invitation",
	"/dashboard",
	"/dashboard/home",
]);

export function consolePathUsesSession(pathname: string) {
	if (SESSION_PATHS.has(pathname)) return true;
	if (pathname.startsWith("/dashboard/")) return true;
	return false;
}

export const PUBLIC_ROUTES = [
	"/",
	"/register",
	"/login",
	"/reset-password",
	"/send-reset-password",
	"/invitation",
	"/api/",
];
