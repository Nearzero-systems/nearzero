import type { AnyColumn } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { normalizeAuthEmail } from "./auth-email-policy";

export function emailEquals(column: AnyColumn, value: string) {
	return sql`lower(${column}) = ${normalizeAuthEmail(value)}`;
}
