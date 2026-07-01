import { dbUrl } from "@nearzero/server/db/constants";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const globalForAgentDb = globalThis as unknown as {
	nearzeroAgentDb?: ReturnType<typeof drizzle<typeof schema>>;
};

export const agentDb =
	globalForAgentDb.nearzeroAgentDb ??
	drizzle(postgres(dbUrl), {
		schema,
	});

if (process.env.NODE_ENV !== "production") {
	globalForAgentDb.nearzeroAgentDb = agentDb;
}
