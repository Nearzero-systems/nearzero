import slug from "slugify";

export function slugify(text: string | undefined): string {
	if (!text) return "";

	const cleanedText = text.trim().replace(/[^a-zA-Z0-9\s]/g, "") || "service";

	return slug(cleanedText, {
		lower: true,
		trim: true,
		strict: true,
	});
}
