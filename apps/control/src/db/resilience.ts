import type { Logger } from "../log.ts";
import { type Db, databaseIsReachable, probeDatabase } from "./database.ts";
import { type MigrateResult, MigrationError, migrate } from "./migrate.ts";

/**
 * Living through PostgreSQL restarting (spec 23.2): a lost connection is an outage to wait out,
 * not a reason to stop. Connections are reopened as they are needed (the pool does that), the
 * health endpoint says "degraded" meanwhile, and jobs pick up where they were (their leases run
 * out and recovery puts them back). A start waits, bounded, for the database to answer before it
 * updates it.
 */

/** PostgreSQL's codes for a server that is stopping, starting, recovering or gone. */
const CONNECTION_CODES = new Set([
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now (starting up, recovery)
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "53300", // too_many_connections
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

const CONNECTION_MESSAGES =
  /connection terminated|terminating connection|connection (was )?closed|timeout exceeded when trying to connect|client has encountered a connection error|database system is (starting up|in recovery mode|shutting down)|the database system is not yet accepting connections|server closed the connection unexpectedly|connect(ion)? refused|socket hang up/i;

/** Whether an error (or what it wraps) means the database is unreachable for now. */
export function isDatabaseConnectionError(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 4) return false;
  const { code, message, cause } = error as { code?: unknown; message?: unknown; cause?: unknown };
  if (typeof code === "string" && CONNECTION_CODES.has(code)) return true;
  if (typeof message === "string" && CONNECTION_MESSAGES.test(message)) return true;
  return isDatabaseConnectionError(cause, depth + 1);
}

export interface WaitOptions {
  /** How long to keep trying, from the first attempt. 0 tries once. */
  waitMs: number;
  log: Logger;
  /** The first pause; it doubles up to `maxDelayMs`. */
  firstDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class DatabaseWaitError extends Error {
  constructor(seconds: number, reason: string) {
    super(
      `its database didn't answer within ${seconds} seconds (${reason}). Check DATABASE_URL and that PostgreSQL is running; Nearzero waits for it at every start (NEARZERO_DATABASE_WAIT_SECONDS).`,
    );
    this.name = "DatabaseWaitError";
  }
}

/** Where a Nearzero server keeps the database settings (spec 03 3.1). */
const SETTINGS_FILE = "/opt/nearzero/.env";

export type DatabaseRefusal = "password" | "login" | "database";

/** PostgreSQL's answers that waiting won't change. */
const REFUSAL_CODES: Record<string, DatabaseRefusal> = {
  "28P01": "password", // invalid_password
  "28000": "login", // invalid_authorization_specification: no such role, or pg_hba refuses
  "3D000": "database", // invalid_catalog_name: no such database
};

const REFUSAL_MESSAGES: [RegExp, DatabaseRefusal][] = [
  [
    /password authentication failed|client password must be a string|no password was provided/i,
    "password",
  ],
  [/role "[^"]*" does not exist|no pg_hba\.conf entry/i, "login"],
  [/database "[^"]*" does not exist/i, "database"],
];

/**
 * Whether the database answered and refused (a wrong password, a missing role or database), with
 * what it said. Waiting doesn't help with these, so a start stops at once (punch list 40).
 */
export function databaseRefusal(
  error: unknown,
  depth = 0,
): { kind: DatabaseRefusal; detail: string } | null {
  if (!error || typeof error !== "object" || depth > 4) return null;
  const { code, message, cause } = error as { code?: unknown; message?: unknown; cause?: unknown };
  const text = typeof message === "string" ? message : "";
  if (typeof code === "string" && REFUSAL_CODES[code]) {
    return { kind: REFUSAL_CODES[code], detail: text };
  }
  for (const [pattern, kind] of REFUSAL_MESSAGES) {
    if (pattern.test(text)) return { kind, detail: text };
  }
  return databaseRefusal(cause, depth + 1);
}

export class DatabaseRefusedError extends Error {
  readonly kind: DatabaseRefusal;
  constructor(kind: DatabaseRefusal, detail: string) {
    const said = detail ? ` (PostgreSQL said: ${detail})` : "";
    super(
      kind === "password"
        ? `its database refused the password${said}. The password in DATABASE_URL must be the one the database was created with: on a Nearzero server, check NEARZERO_DATABASE_PASSWORD and DATABASE_URL in ${SETTINGS_FILE}.`
        : kind === "login"
          ? `its database refused to sign in the user in DATABASE_URL${said}. Check the user in DATABASE_URL (in ${SETTINGS_FILE} on a Nearzero server).`
          : `the database named in DATABASE_URL doesn't exist${said}. Check the database name in DATABASE_URL (in ${SETTINGS_FILE} on a Nearzero server).`,
    );
    this.name = "DatabaseRefusedError";
    this.kind = kind;
  }
}

/**
 * Updates the database at start, waiting for it to answer first: while it is unreachable (not
 * started yet, restarting, recovering) the start tries again with a growing pause, up to
 * `waitMs`, saying each time what it waits for. A database that answers and refuses (a wrong
 * password, a missing role or database) and a real migration problem (a changed file, a newer
 * database, a failing migration) stop the start at once.
 */
export async function migrateWhenReachable(
  db: Db,
  migrationOptions: Parameters<typeof migrate>[1],
  options: WaitOptions,
): Promise<MigrateResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const deadline = now() + options.waitMs;
  let delay = options.firstDelayMs ?? 1_000;
  const maxDelay = options.maxDelayMs ?? 10_000;
  for (let attempt = 1; ; attempt++) {
    let reason: string;
    const probe = await probeDatabase(db, 5_000);
    if (!probe.answered) {
      const refused = databaseRefusal(probe.error);
      if (refused) throw new DatabaseRefusedError(refused.kind, refused.detail);
      reason = probe.error instanceof Error ? probe.error.message || "no answer" : "no answer";
    } else {
      try {
        return await migrate(db, migrationOptions);
      } catch (error) {
        const refused = databaseRefusal(error);
        if (refused) throw new DatabaseRefusedError(refused.kind, refused.detail);
        const unreachable =
          isDatabaseConnectionError(error) || !(await databaseIsReachable(db, 2_000));
        if (!unreachable) throw error;
        reason =
          error instanceof MigrationError && error.cause instanceof Error
            ? error.cause.message
            : (error as Error).message;
      }
    }
    const left = deadline - now();
    if (left <= 0) throw new DatabaseWaitError(Math.round(options.waitMs / 1000), reason);
    const pause = Math.min(delay, left);
    options.log.warn("waiting for the database", {
      attempt,
      reason,
      retryInMs: pause,
    });
    await sleep(pause);
    delay = Math.min(delay * 2, maxDelay);
  }
}

/**
 * Keeps a database outage from stopping the process: a promise some background loop left
 * unhandled while the database was away is logged, not fatal; an uncaught connection error (a pg
 * client that lost its server between two queries) likewise. Anything else that escapes is a
 * programming error, and the process stops as before, so it is restarted in a known state.
 */
export function surviveDatabaseOutages(log: Logger): void {
  process.on("unhandledRejection", (reason) => {
    if (isDatabaseConnectionError(reason)) {
      log.warn("a background task lost the database; it continues when the database is back", {
        error: reason,
      });
      return;
    }
    log.error("stopping after an unhandled error", { error: reason });
    process.exit(1);
  });
  process.on("uncaughtException", (error) => {
    if (isDatabaseConnectionError(error)) {
      log.warn("lost a database connection; it reopens when needed", { error });
      return;
    }
    log.error("stopping after an unexpected error", { error });
    process.exit(1);
  });
}
