export function validateRegistryUrl(val: string): string | null {
	if (!val || val.trim().length === 0) return null;
	const trimmed = val.trim();
	if (/^https?:\/\//i.test(trimmed) || trimmed.includes("/")) {
		return "Invalid registry URL. Please enter only the hostname (e.g., example.com or registry.example.com). Do not include protocol (https://) or paths.";
	}
	const hostnameRegex =
		/^(?:\[[^\]]+\]|[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,253}[a-zA-Z0-9])?)(?::\d+)?$/;
	if (!hostnameRegex.test(trimmed)) {
		return "Invalid registry URL. Please enter only the hostname (e.g., example.com or registry.example.com). Do not include protocol (https://) or paths.";
	}
	return null;
}
