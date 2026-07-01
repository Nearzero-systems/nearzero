/** Strip internal resource IDs from text shown to users in the chat UI. */
export function redactInternalIds(text: string) {
	if (!text) return text;
	let out = text;
	out = out.replace(/\(ID:\s*`?[A-Za-z0-9_-]{12,}`?\)/gi, "");
	out = out.replace(
		/\b(?:project|environment|application|compose|deployment|service)Id\s*[:=]\s*`?[A-Za-z0-9_-]{12,}`?/gi,
		"",
	);
	out = out.replace(/\s{2,}/g, " ");
	out = out.replace(/\(\s*\)/g, "");
	return out.trim();
}
