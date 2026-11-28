import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { wakeScheduler as wakeBackupScheduler } from "../backups/scheduler-wake.ts";
import type { Db } from "../db/database.ts";
import type { ControlServices } from "../services.ts";
import { wakeTaskScheduler } from "../tasks/scheduler.ts";
import { bundleJson, bundleLines, type OpenedBundle } from "./bundle.ts";
import { importConsolePaths } from "./console-paths.ts";
import { importAccess, importIdentity } from "./import-access.ts";
import { checkInstallId, importVolumeArchives, importWebhookPaths } from "./import-extras.ts";
import { importInfrastructure } from "./import-infra.ts";
import {
  importAgentSessions,
  importProjects,
  planMoves,
  settleHostTaskOwners,
} from "./import-projects.ts";
import { importInstallSettings } from "./install.ts";
import { controlPlaneDetails, controlPlaneLine, controlPlaneWorkloads } from "./legacy-fields.ts";
import { type BundleRecord, installSchema, RECORD_FILES, type RecordKind } from "./records.ts";
import { emptyReport, type ImportReport, type ReportLine } from "./report.ts";
import "./tables.ts";

/**
 * Imports an export bundle into 1.0's data (spec 29.5). Everything happens in one transaction:
 * a dry run is the same import rolled back at the end, so its report is exactly what the real
 * import would do. Each record runs inside its own savepoint, so a record 1.0 refuses is listed
 * with its reason and the rest carry on.
 *
 * Refs become new ids; what each ref became is kept (migration_record), so importing the same
 * bundle again finds every record and changes nothing. Secrets are sealed with this install's key
 * as they are written and the bundle's plain copies never leave memory.
 */

export interface ImportOptions {
  dryRun: boolean;
  /** The 0.1.x install ran on this server: the move stops its workloads as services move. */
  inPlace: boolean;
  /** Deployments history (on by default, spec 29.4). */
  deployments?: boolean;
}

export interface ImportResult {
  report: ImportReport;
  /** The import's id; null for a dry run or when everything was already imported. */
  importId: string | null;
  /** Services waiting to move onto the 1.0 runner. */
  moves: number;
}

/** A record that can't be imported, with the reason for people. */
export class NotImported extends Error {
  constructor(
    readonly label: string,
    readonly reason: string,
  ) {
    super(`${label}: ${reason}`);
    this.name = "NotImported";
  }
}

class DryRunFinished extends Error {}

export interface MoveCandidate {
  serviceId: string;
  name: string;
  target: string;
  targetName: string;
  lastDeployedAt: number | null;
  legacy: { kind: string; name: string } | null;
  deployable: boolean;
  /** Why it can't be redeployed, when it can't. */
  why?: string;
}

function key(kind: string, ref: string): string {
  return `${kind}\u0000${ref}`;
}

export class ImportRun {
  readonly importId = randomUUID();
  /** Records an earlier import of this install made: kind and ref to id. */
  readonly #known = new Map<string, string>();
  /** Every ref resolved so far (earlier imports and this one). */
  readonly #ids = new Map<string, string>();
  readonly #seen = new Set<string>();
  /** Refs imported by this run (not earlier ones). */
  readonly #fresh = new Set<string>();
  readonly moves: MoveCandidate[] = [];
  /** The workspace whose owners and admins are instance administrators, when the bundle names one. */
  firstWorkspaceId: string | null = null;
  /** Workspaces that ran services on the 0.1.x host. */
  readonly hostWorkspaces = new Set<string>();
  /** Host tasks whose 0.1.x owner wasn't moved: they go to the install's owner (R3-29). */
  readonly unownedHostTasks: string[] = [];
  /** 0.1.x workloads to stop on each imported server before it is set up again. */
  readonly serverLegacy = new Map<string, { kind: string; name: string }[]>();
  /** When each service ref was last deployed, from the bundle's deployments (newest first wins). */
  readonly lastDeployed = new Map<string, number>();
  /** The container port each service ref's hostnames route to: its service port in 1.0. */
  readonly servicePorts = new Map<string, number>();
  /** Each service ref's 0.1.x volume names and the 1.0 volume each becomes. */
  readonly volumeNames = new Map<string, Map<string, string>>();

  constructor(
    readonly db: Db,
    readonly services: ControlServices,
    readonly bundle: OpenedBundle,
    readonly report: ImportReport,
    readonly options: ImportOptions,
  ) {}

  /** Reads what services need from other files before services are imported. */
  prescan(): void {
    for (const { value } of bundleLines(this.bundle, RECORD_FILES.deployments.file)) {
      const record = value as {
        serviceRef?: unknown;
        status?: unknown;
        finishedAt?: unknown;
        createdAt?: unknown;
      };
      if (typeof record?.serviceRef !== "string") continue;
      if (record.status !== "Running" && record.status !== "Succeeded") continue;
      const at = Date.parse(String(record.finishedAt ?? record.createdAt ?? ""));
      if (Number.isNaN(at)) continue;
      this.lastDeployed.set(
        record.serviceRef,
        Math.max(at, this.lastDeployed.get(record.serviceRef) ?? 0),
      );
    }
    for (const { value } of bundleLines(this.bundle, RECORD_FILES.hostnames.file)) {
      const record = value as { serviceRef?: unknown; port?: unknown; innerService?: unknown };
      if (typeof record?.serviceRef !== "string" || typeof record.port !== "number") continue;
      if (record.innerService) continue;
      if (!this.servicePorts.has(record.serviceRef))
        this.servicePorts.set(record.serviceRef, record.port);
    }
  }

  async load(): Promise<void> {
    const rows = await this.db
      .selectFrom("migration_record")
      .select(["kind", "ref", "object_id"])
      .where("source_install", "=", this.bundle.sourceInstall)
      .execute();
    for (const row of rows) {
      this.#known.set(key(row.kind, row.ref), row.object_id);
      this.#ids.set(key(row.kind, row.ref), row.object_id);
    }
  }

  /** The id a ref became, or undefined when it wasn't imported. */
  id(kind: RecordKind, ref: string | null | undefined): string | undefined {
    return ref ? this.#ids.get(key(kind, ref)) : undefined;
  }

  /** True when the ref was imported by this run (not by an earlier import). */
  isFresh(kind: RecordKind, ref: string): boolean {
    return this.#fresh.has(key(kind, ref));
  }

  /** Records a ref that maps to an existing object without going through {@link each}. */
  remember(kind: RecordKind, ref: string, id: string): void {
    this.#ids.set(key(kind, ref), id);
  }

  line(
    list: "notImported" | "collisions" | "changed" | "dropped",
    kind: ReportLine["kind"],
    name: string,
    message: string,
  ): void {
    this.report[list].push({ kind, name, message });
  }

  collision(kind: RecordKind, name: string, message: string): void {
    this.line("collisions", kind, name, message);
  }

  changed(kind: RecordKind, name: string, message: string): void {
    this.line("changed", kind, name, message);
  }

  dropped(kind: RecordKind, name: string, message: string): void {
    this.line("dropped", kind, name, message);
  }

  /**
   * Imports every record of a kind. `handle` returns the new id, or throws {@link NotImported}.
   * A record found in an earlier import is not touched again.
   */
  async each<K extends RecordKind>(
    kind: K,
    handle: (record: BundleRecord<K>) => Promise<string>,
  ): Promise<void> {
    const { file, schema, label } = RECORD_FILES[kind];
    const count = this.report.counts[kind];
    for (const { line, value } of bundleLines(this.bundle, file)) {
      count.inBundle++;
      const parsed = schema.safeParse(value);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const field = issue?.path.join(".") || "record";
        count.notImported++;
        this.line(
          "notImported",
          kind,
          `line ${line}`,
          `Line ${line} of ${file} can't be read (${field}: ${issue?.message ?? "invalid"}).`,
        );
        continue;
      }
      const record = parsed.data as BundleRecord<K>;
      const k = key(kind, record.ref);
      if (this.#seen.has(k)) {
        count.notImported++;
        this.line(
          "notImported",
          kind,
          record.ref,
          `The ${label} record ${record.ref} appears twice in ${file}; the second was left out.`,
        );
        continue;
      }
      this.#seen.add(k);
      const earlier = this.#known.get(k);
      if (earlier) {
        count.alreadyImported++;
        continue;
      }
      await sql`savepoint nz_import_record`.execute(this.db);
      try {
        const id = await handle(record);
        await this.db
          .insertInto("migration_record")
          .values({
            source_install: this.bundle.sourceInstall,
            kind,
            ref: record.ref,
            object_id: id,
            import_id: this.importId,
          })
          .execute();
        await sql`release savepoint nz_import_record`.execute(this.db);
        this.#ids.set(k, id);
        this.#fresh.add(k);
        count.imported++;
      } catch (error) {
        await sql`rollback to savepoint nz_import_record`.execute(this.db);
        count.notImported++;
        if (error instanceof NotImported) {
          this.line("notImported", kind, error.label, `${error.label}: ${error.reason}`);
          continue;
        }
        const code = (error as { code?: unknown }).code;
        if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
          const constraint = (error as { constraint?: string }).constraint;
          this.line(
            "notImported",
            kind,
            record.ref,
            `The ${label} record ${record.ref} was refused by the database${constraint ? ` (${constraint})` : ""}.`,
          );
          continue;
        }
        throw error;
      }
    }
  }
}

/** Runs the whole import; see the module comment. */
export async function importBundle(
  services: ControlServices,
  bundle: OpenedBundle,
  options: ImportOptions,
): Promise<ImportResult> {
  const report = emptyReport(
    bundle.manifest.sourceVersion,
    bundle.manifest.exportedAt ?? null,
    options.dryRun,
  );
  let result: ImportResult = { report, importId: null, moves: 0 };
  // Records of two 0.1.x installs never mix (29a.9 installId).
  await checkInstallId(services.db, bundle);
  try {
    await services.db.transaction().execute(async (trx) => {
      // One import at a time on an install.
      await sql`select pg_advisory_xact_lock(7204315650)`.execute(trx);
      const run = new ImportRun(trx, services, bundle, report, options);
      await run.load();
      run.prescan();
      await trx
        .insertInto("migration_import")
        .values({
          id: run.importId,
          source_install: bundle.manifest.installId ?? "unknown",
          bundle_sha256: bundle.sha256,
          format_version: bundle.manifest.format,
          source_version: bundle.manifest.sourceVersion,
          exported_at: validDate(bundle.manifest.exportedAt),
          in_place: options.inPlace,
          report: "{}",
        })
        .execute();

      await importIdentity(run);
      await importInfrastructure(run);
      await importProjects(run);
      await importAccess(run);
      await settleHostTaskOwners(run);
      await importAgentSessions(run);
      // What the export says doesn't map (29a.4 notes), for the dry-run report.
      for (const note of bundle.manifest.notes ?? []) {
        report.dropped.push({
          kind: "install",
          name: note.name ?? note.kind,
          message: note.name ? `${note.name}: ${note.reason}` : note.reason,
        });
      }
      const install = installSchema.safeParse(bundleJson(bundle, "install.json") ?? {});
      if (install.success) {
        await importInstallSettings(trx, services, install.data, report);
        await importWebhookPaths(run, install.data.legacyWebhookPaths);
        const plane = controlPlaneLine(
          controlPlaneWorkloads(install.data.controlPlane),
          controlPlaneDetails(install.data.controlPlaneDetails),
        );
        if (plane) report.install.push({ kind: "install", name: "control plane", message: plane });
      } else {
        report.install.push({
          kind: "install",
          name: "install",
          message: "install.json can't be read, so the install's settings were left as they are.",
        });
      }
      await importVolumeArchives(run);
      await importConsolePaths(run);
      const moves = await planMoves(run);
      if (!options.inPlace && report.moves.length > 0) {
        report.install.push({
          kind: "install",
          name: "volumes",
          message:
            "This isn't the server the export came from, so services deploy here fresh, each with its data from the export's volume archives when it has them.",
        });
      }
      const imported = Object.values(report.counts).reduce((sum, count) => sum + count.imported, 0);
      if (imported === 0 && moves === 0) {
        // Nothing new: an earlier import of this bundle already did everything.
        await trx.deleteFrom("migration_import").where("id", "=", run.importId).execute();
      } else {
        await trx
          .updateTable("migration_import")
          .set({ report: JSON.stringify(report) })
          .where("id", "=", run.importId)
          .execute();
        result = { report, importId: run.importId, moves };
      }
      if (options.dryRun) throw new DryRunFinished();
    });
  } catch (error) {
    if (!(error instanceof DryRunFinished)) throw error;
    result = { report, importId: null, moves: report.moves.length };
    return result;
  }
  // Imported schedules run on time: each scheduler wakes for the earliest one (spec 29.6).
  if (result.importId) {
    const task = await services.db
      .selectFrom("task")
      .select((eb) => eb.fn.min("next_run_at").as("at"))
      .where("enabled", "=", true)
      .executeTakeFirst();
    if (task?.at) await wakeTaskScheduler(services.db, new Date(task.at));
    const backup = await services.db
      .selectFrom("backup_schedule")
      .select((eb) => eb.fn.min("next_run_at").as("at"))
      .where("enabled", "=", true)
      .executeTakeFirst();
    if (backup?.at) await wakeBackupScheduler(services.db, new Date(backup.at));
  }
  return result;
}

export function validDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : new Date(at);
}

export type { BundleRecord };
