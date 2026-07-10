import { db } from "../db/index";
import { organization } from "../db/schema";
import { and, eq, ne } from "drizzle-orm";
import { nanoid } from "nanoid";

const RESERVED_SLUGS = new Set([
	"api",
	"register",
	"login",
	"invitation",
	"dashboard",
	"accept-invitation",
	"nearzero",
]);

export function slugifyOrganizationName(name: string) {
	const base = name
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);

	if (!base || RESERVED_SLUGS.has(base)) {
		return nanoid(10);
	}
	return base;
}

export async function ensureOrganizationSlug(
	name: string,
	organizationId: string,
	currentSlug?: string | null,
) {
	if (currentSlug?.trim()) {
		return currentSlug.trim();
	}

	let base = slugifyOrganizationName(name);
	let slug = base;
	let attempt = 0;

	while (true) {
		const existing = await db.query.organization.findFirst({
			where: and(eq(organization.slug, slug), ne(organization.id, organizationId)),
			columns: { id: true },
		});
		if (!existing) return slug;
		attempt += 1;
		slug = `${base}-${attempt}`;
	}
}
