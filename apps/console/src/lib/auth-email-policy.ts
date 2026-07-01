export function getAuthEmailValidationError(value: string): string | null {
	const normalized = String(value || "").trim().toLowerCase();
	if (!normalized) return "Enter your email address.";
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
		return "Use a valid email address.";
	}
	return null;
}
