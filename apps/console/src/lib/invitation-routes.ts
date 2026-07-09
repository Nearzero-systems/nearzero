export const PENDING_INVITATION_STORAGE_KEY = "nz-pending-invitation-token";

export function invitationPath(token: string, email?: string) {
	const url = new URL("/invitation", "http://local");
	url.searchParams.set("token", token);
	if (email?.trim()) {
		url.searchParams.set("email", email.trim());
	}
	return `${url.pathname}${url.search}`;
}

export function extractInvitationToken(raw: string | null | undefined) {
	const value = String(raw || "").trim();
	return value.length > 0 ? value : null;
}

export function parseInvitationCallback(raw: string | null | undefined) {
	if (!raw) return null;
	try {
		const url = new URL(raw, "http://local");
		if (url.pathname !== "/invitation") return null;
		return extractInvitationToken(url.searchParams.get("token"));
	} catch {
		return null;
	}
}

export function loginPathForInvitation(token: string, email?: string) {
	const callbackUrl = invitationPath(token, email);
	const url = new URL("/login", "http://local");
	url.searchParams.set("callbackUrl", callbackUrl);
	if (email?.trim()) {
		url.searchParams.set("email", email.trim());
	}
	return `${url.pathname}${url.search}`;
}

export function registerPathForInvitation(token: string, email?: string) {
	const url = new URL("/register", "http://local");
	url.searchParams.set("token", token);
	if (email?.trim()) {
		url.searchParams.set("email", email.trim());
	}
	return `${url.pathname}${url.search}`;
}

export function persistPendingInvitationToken(token: string) {
	if (typeof sessionStorage === "undefined") return;
	const value = extractInvitationToken(token);
	if (value) {
		sessionStorage.setItem(PENDING_INVITATION_STORAGE_KEY, value);
	}
}

export function readPendingInvitationToken() {
	if (typeof sessionStorage === "undefined") return null;
	return extractInvitationToken(
		sessionStorage.getItem(PENDING_INVITATION_STORAGE_KEY),
	);
}

export function clearPendingInvitationToken() {
	if (typeof sessionStorage === "undefined") return;
	sessionStorage.removeItem(PENDING_INVITATION_STORAGE_KEY);
}

export function resolveInvitationTokenFromPage() {
	if (typeof window === "undefined") return null;
	const fromUrl = extractInvitationToken(
		new URL(window.location.href).searchParams.get("token"),
	);
	return fromUrl || readPendingInvitationToken();
}
