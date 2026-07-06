import { db } from "@nearzero/server/db";
import { webServerSettings } from "@nearzero/server/db/schema";
import { eq } from "drizzle-orm";

const isUndefinedTableError = (error: unknown) => {
	const cause = (error as { cause?: { code?: string } } | null)?.cause;
	const code = cause?.code ?? (error as { code?: string } | null)?.code;
	return code === "42P01";
};

/**
 * Get the web server settings (singleton - only one row should exist)
 */
export const getWebServerSettings = async () => {
	let settings: typeof webServerSettings.$inferSelect | undefined;
	try {
		settings = await db.query.webServerSettings.findFirst({
			orderBy: (settings, { asc }) => [asc(settings.createdAt)],
		});
	} catch (error) {
		if (isUndefinedTableError(error)) {
			return null;
		}
		throw error;
	}

	if (!settings) {
		// Create default settings if none exist
		const [newSettings] = await db
			.insert(webServerSettings)
			.values({})
			.returning();

		return newSettings;
	}

	return settings;
};

/**
 * Update web server settings
 */
export const updateWebServerSettings = async (
	updates: Partial<typeof webServerSettings.$inferInsert>,
) => {
	const current = await getWebServerSettings();

	const [updated] = await db
		.update(webServerSettings)
		.set({
			...updates,
			updatedAt: new Date(),
		})
		.where(eq(webServerSettings.id, current?.id ?? ""))
		.returning();

	return updated;
};
