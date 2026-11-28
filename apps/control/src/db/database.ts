import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import type { Database } from "./schema.ts";

export type Db = Kysely<Database>;

function parseInt8(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`A 64-bit number from PostgreSQL (${value}) is too large to read exactly.`);
  }
  return parsed;
}

/**
 * Reads PostgreSQL's 64-bit integers (ids, counts) as numbers, scoped to this pool so the
 * process-wide parsers of the pg package stay untouched.
 */
const typeParsers: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: "text" | "binary") => {
    if (oid === pg.types.builtins.INT8 && format !== "binary") return parseInt8;
    return pg.types.getTypeParser(oid, format);
  }) as pg.CustomTypesConfig["getTypeParser"],
};

export interface DatabaseOptions {
  maxConnections?: number;
  /** Shown in pg_stat_activity, so an operator can tell connections apart. */
  applicationName?: string;
  /** Told when a connection breaks (the server restarted or went away); the pool replaces it. */
  onConnectionError?: (error: Error) => void;
}

export function createDatabase(url: string, options: DatabaseOptions = {}): Db {
  const pool = new pg.Pool({
    connectionString: url,
    max: options.maxConnections ?? 10,
    application_name: options.applicationName ?? "nearzero-control",
    connectionTimeoutMillis: 5_000,
    types: typeParsers,
  });
  // A connection whose server restarts emits "error". The pool only listens while a connection
  // is idle, and an "error" nobody listens to stops the process, so every connection (idle or
  // in use between two queries) and the pool get a listener (spec 23.2). A broken connection is
  // dropped when it is released, and new ones are opened on demand.
  const reported = new WeakSet<Error>();
  const report = (error: Error) => {
    if (reported.has(error)) return;
    reported.add(error);
    options.onConnectionError?.(error);
  };
  pool.on("error", report);
  pool.on("connect", (client) => client.on("error", report));
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

/** True when the database answers within the time limit. */
/**
 * One `select 1`, with what went wrong: `error` is PostgreSQL's (or the driver's) refusal, or
 * null when nothing answered within `timeoutMs`.
 */
export async function probeDatabase(
  db: Db,
  timeoutMs = 2_000,
): Promise<{ answered: true } | { answered: false; error: unknown }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ answered: false; error: null }>((resolve) => {
    timer = setTimeout(() => resolve({ answered: false, error: null }), timeoutMs);
  });
  const probe = sql`select 1`
    .execute(db)
    .then(() => ({ answered: true as const }))
    .catch((error: unknown) => ({ answered: false as const, error }));
  try {
    return await Promise.race([probe, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function databaseIsReachable(db: Db, timeoutMs = 2_000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const probe = sql`select 1`
    .execute(db)
    .then(() => true)
    .catch(() => false);
  try {
    return await Promise.race([probe, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
