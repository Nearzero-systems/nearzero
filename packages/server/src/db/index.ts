import { and, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { dbUrl } from "./constants";
import * as schema from "./schema";

export { and, eq };
export * from "./schema";

type Database = PostgresJsDatabase<typeof schema>;

/**
 * Avoids global redeclaration conflicts in the monorepo.
 * Does not use `declare global`.
 */
const globalForDb = globalThis as unknown as {
	db?: Database;
};

let dbConnection: Database;

if (process.env.NODE_ENV === "production") {
	// Production does not use the global cache
	dbConnection = drizzle(postgres(dbUrl), {
		schema,
	});
} else {
	// Development reuses one connection across hot reloads
	if (!globalForDb.db) {
		globalForDb.db = drizzle(postgres(dbUrl), {
			schema,
		});
	}

	dbConnection = globalForDb.db;
}

export const db: Database = dbConnection;

export { dbUrl };
