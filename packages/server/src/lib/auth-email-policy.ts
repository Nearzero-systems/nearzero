export function normalizeAuthEmail(value: string) {
	return String(value || "")
		.trim()
		.toLowerCase();
}

function getEmailDomain(value: string): string {
	const normalized = normalizeAuthEmail(value);
	const atIndex = normalized.lastIndexOf("@");
	if (atIndex <= 0) return "";
	return normalized.slice(atIndex + 1);
}

export function getAuthEmailPolicyError(value: string): string | null {
	const domain = getEmailDomain(value);
	if (!domain) return "Use a valid email address.";
	return null;
}

export function isValidAuthEmail(value: string) {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeAuthEmail(value));
}
