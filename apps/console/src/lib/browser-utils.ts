/**
 * A self-hosted install serves plain HTTP on an IP address until it has a
 * domain, and browsers hide crypto.randomUUID, crypto.subtle and
 * navigator.clipboard from insecure pages. Browser code uses these helpers so
 * it works on both.
 */
export function randomId() {
	if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Must be called from a click handler: browsers only allow copying there. */
export async function copyText(text: string) {
	if (navigator.clipboard) {
		await navigator.clipboard.writeText(text);
		return;
	}
	const previousFocus =
		document.activeElement instanceof HTMLElement
			? document.activeElement
			: null;
	const field = document.createElement("textarea");
	field.value = text;
	field.readOnly = true;
	field.style.position = "fixed";
	field.style.opacity = "0";
	// An open modal dialog makes the rest of the page inert, so the field has to
	// live inside it to be selectable.
	(document.querySelector("dialog[open]") ?? document.body).append(field);
	field.select();
	const copied = document.execCommand("copy");
	field.remove();
	previousFocus?.focus();
	if (!copied) throw new Error("The browser refused to copy.");
}
