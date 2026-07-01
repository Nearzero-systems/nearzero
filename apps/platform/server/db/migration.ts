import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dbUrl } from "@nearzero/server/db";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const resolveMigrationsFolder = () => {
	const moduleDir = path.dirname(fileURLToPath(import.meta.url));
	const candidates = [
		path.join(process.cwd(), "drizzle"),
		path.join(moduleDir, "../drizzle"),
		path.join(moduleDir, "../../drizzle"),
	];

	for (const candidate of candidates) {
		if (fs.existsSync(path.join(candidate, "meta", "_journal.json"))) {
			return candidate;
		}
	}

	throw new Error(
		`Cannot find Drizzle migrations. Checked: ${candidates.join(", ")}`,
	);
};

const migrationsFolder = resolveMigrationsFolder();

export const migration = async () => {
	const sql = postgres(dbUrl, { max: 1, onnotice: () => {} });
	const db = drizzle(sql);
	try {
		await migrate(db, { migrationsFolder });
		console.log("Database migrations applied");
	} finally {
		await sql.end({ timeout: 5 });
	}
};
