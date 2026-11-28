import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "kysely";
import { type Logger, silentLogger } from "../log.ts";
import type { Db } from "./database.ts";

/**
 * Applies the numbered, hand-written SQL files in a folder, in order, each inside its own
 * transaction, and records each one (spec 23.3). Changes are forward-only: an applied file must
 * never change, and a database migrated by a newer version is refused.
 *
 * Several control-plane processes may start at once; a transaction-scoped advisory lock makes
 * them take turns, and each re-checks what is applied once it holds the lock.
 */

/** Files are named like 0002_add_projects.sql: four digits, an underscore, then a name. */
const FILE_PATTERN = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;

/** Arbitrary constant that identifies "Nearzero is migrating" among advisory locks. */
const MIGRATION_LOCK_KEY = 7_204_315_118;

export interface MigrationFile {
  version: number;
  /** The file name without its extension, like 0001_job_queue. */
  name: string;
  sql: string;
  checksum: string;
}

export interface MigrateResult {
  /** Names of the migrations this run applied, in order. */
  applied: string[];
}

export class MigrationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MigrationError";
  }
}

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

export async function readMigrations(directory: string): Promise<MigrationFile[]> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    throw new MigrationError(
      `The migrations folder ${directory} can't be read. Reinstall this Nearzero version so its files are complete.`,
      { cause: error },
    );
  }

  const files: MigrationFile[] = [];
  const seen = new Map<number, string>();
  for (const entry of entries.filter((name) => name.endsWith(".sql")).sort()) {
    const match = FILE_PATTERN.exec(entry);
    if (!match?.[1]) {
      throw new MigrationError(
        `The migration file ${entry} is not named like 0002_add_projects.sql (four digits, an underscore, lowercase words). Rename it.`,
      );
    }
    const version = Number(match[1]);
    const clash = seen.get(version);
    if (clash) {
      throw new MigrationError(
        `The migration files ${clash} and ${entry} share the number ${match[1]}. Give the newer one the next free number.`,
      );
    }
    seen.set(version, entry);
    const text = await Bun.file(join(directory, entry)).text();
    files.push({ version, name: entry.slice(0, -4), sql: text, checksum: sha256(text) });
  }
  return files.sort((a, b) => a.version - b.version);
}

async function ensureRecordTable(db: Db): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`.execute(trx);
    await sql`
      create table if not exists applied_migration (
        version    integer     primary key,
        name       text        not null,
        checksum   text        not null,
        applied_at timestamptz not null default now()
      )
    `.execute(trx);
  });
}

function checkApplied(
  applied: { version: number; name: string; checksum: string }[],
  files: MigrationFile[],
): void {
  const byVersion = new Map(files.map((file) => [file.version, file]));
  for (const row of applied) {
    const file = byVersion.get(row.version);
    if (!file) {
      throw new MigrationError(
        `The database was updated by a newer version of Nearzero (it has migration ${row.name}, which this version doesn't know). Install that newer version again; going back to an older version is not supported.`,
      );
    }
    if (file.checksum !== row.checksum) {
      throw new MigrationError(
        `The migration file ${file.name}.sql changed after it was applied. Migrations are forward-only: restore the original file and put the change in a new numbered migration.`,
      );
    }
  }
}

export interface MigrateOptions {
  directory: string;
  log?: Logger;
}

export async function migrate(db: Db, options: MigrateOptions): Promise<MigrateResult> {
  const log = options.log ?? silentLogger;
  const files = await readMigrations(options.directory);

  try {
    await ensureRecordTable(db);
  } catch (error) {
    throw new MigrationError(
      `Nearzero can't prepare its database: ${(error as Error).message}. Check that DATABASE_URL points at a database this account may create tables in.`,
      { cause: error },
    );
  }

  const applied = await db
    .selectFrom("applied_migration")
    .select(["version", "name", "checksum"])
    .execute();
  checkApplied(applied, files);

  const done = new Set(applied.map((row) => row.version));
  const result: MigrateResult = { applied: [] };

  for (const file of files) {
    if (done.has(file.version)) continue;
    const ran = await applyOne(db, file);
    if (ran) {
      result.applied.push(file.name);
      log.info("applied database migration", { migration: file.name });
    }
  }
  return result;
}

/** Applies one migration unless another process got there first. Returns whether it ran. */
async function applyOne(db: Db, file: MigrationFile): Promise<boolean> {
  try {
    return await db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`.execute(trx);
      const existing = await trx
        .selectFrom("applied_migration")
        .select(["version", "name", "checksum"])
        .where("version", "=", file.version)
        .executeTakeFirst();
      if (existing) {
        checkApplied([existing], [file]);
        return false;
      }
      // Without parameters the statement goes over the simple protocol, so a file may hold
      // several statements. They all commit together or not at all.
      await sql.raw(file.sql).execute(trx);
      await trx
        .insertInto("applied_migration")
        .values({ version: file.version, name: file.name, checksum: file.checksum })
        .execute();
      return true;
    });
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    throw new MigrationError(
      `The database migration ${file.name}.sql failed, so it was rolled back and changed nothing: ${(error as Error).message}. Fix the cause, then start Nearzero again.`,
      { cause: error },
    );
  }
}
