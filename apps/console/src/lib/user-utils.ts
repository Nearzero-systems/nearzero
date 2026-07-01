export async function generateSHA256Hash(text: string) {
	const encoder = new TextEncoder();
	const data = encoder.encode(text);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function getFallbackAvatarInitials(fullName: string | undefined): string {
	if (typeof fullName === "undefined" || fullName === "") return "CN";
	const [name = "", surname = ""] = fullName.split(" ");
	if (surname === "") {
		return name.substring(0, 2).toUpperCase();
	}
	return (name.charAt(0) + surname.charAt(0)).toUpperCase();
}
