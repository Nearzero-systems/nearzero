import type { CliIo } from "../cli/commands.ts";
import type { ControlServices } from "../services.ts";
import { BundleError, bundleJson, bundleLines, type OpenedBundle, openBundle } from "./bundle.ts";
import { ImportRefused } from "./import-extras.ts";
import { importBundle } from "./importer.ts";
import { rollbackServerScript, runOnServer } from "./legacy.ts";
import { controlPlaneDetails, controlPlaneWorkloads } from "./legacy-fields.ts";
import { enqueueFinalize, enqueueMove } from "./move-job.ts";
import type { LegacyWorkload } from "./moves.ts";
import { retryFailed } from "./moves.ts";
import { installSchema, RECORD_FILES } from "./records.ts";
import { reportText } from "./report.ts";
import { markFinalized, migrationStatus, serviceLine, statusText } from "./status.ts";

/**
 * `nearzero import` and `nearzero migrate …` inside the control-plane container (spec 29.2, 03
 * 3.4). The `nearzero` server command adds what only the host can do: stopping and starting
 * control planes, deleting the old data, and the typed confirmation of finalize.
 *
 *   import [--dry-run] [--in-place] [--no-deployments] [--wait] [--json] <bundle>
 *   migrate status [--wait] [--json]
 *   migrate retry [service id…]
 *   migrate finalize --yes
 *   migrate rollback-plan            the host's 0.1.x workloads to start again, "kind name" lines
 *   migrate rollback-servers         remote servers back to their 0.1.x workloads, over SSH
 *   migrate control-plane <bundle>   the 0.1.x control plane's workloads, "kind name" lines
 *
 * The passphrase comes from NEARZERO_MIGRATION_PASSPHRASE, or is asked on the terminal.
 */

export const MIGRATION_USAGE = [
  "  import [--dry-run] <file>  Import a 0.1.x export (passphrase from NEARZERO_MIGRATION_PASSPHRASE or asked)",
  "  migrate status [--wait]    Show how the move to 1.0 stands",
  "  migrate retry              Try the services that failed to move again",
  "  migrate finalize --yes     Mark the move finished and remove the stopped 0.1.x workloads",
];

export const MIGRATION_EXIT = { ok: 0, failed: 1, someFailed: 3, finalized: 4 } as const;

export interface MigrationCliOptions {
  env: Record<string, string | undefined>;
  readFile(path: string): Promise<Uint8Array>;
  /** How long --wait checks between looks; tests make it short. */
  pollMs?: number;
}

async function passphrase(io: CliIo, env: MigrationCliOptions["env"]): Promise<string | null> {
  const given = env.NEARZERO_MIGRATION_PASSPHRASE;
  if (given) return given;
  if (!io.interactive) {
    io.err(
      "Set NEARZERO_MIGRATION_PASSPHRASE to the export's passphrase, or run this on a terminal.",
    );
    return null;
  }
  return io.readSecret("Passphrase: ");
}

async function loadBundle(io: CliIo, options: MigrationCliOptions, path: string | undefined) {
  if (!path) {
    io.err("Name the export file: sudo nearzero import <file>");
    return null;
  }
  let bytes: Uint8Array;
  try {
    bytes = await options.readFile(path);
  } catch {
    io.err(`Can't read ${path}. Check the path, and that the file is on this server.`);
    return null;
  }
  const secret = await passphrase(io, options.env);
  if (secret === null) return null;
  try {
    return await openBundle(bytes, secret);
  } catch (error) {
    if (error instanceof BundleError) {
      io.err(error.message);
      return null;
    }
    throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Prints one line per service as it finishes, until nothing waits; the exit code says how it went. */
async function follow(
  services: ControlServices,
  io: CliIo,
  pollMs: number,
  json: boolean,
): Promise<number> {
  const printed = new Set<string>();
  for (;;) {
    const status = await migrationStatus(services.db);
    for (const service of status.services) {
      if (service.state === "waiting" || service.state === "moving") continue;
      if (printed.has(service.serviceId)) continue;
      printed.add(service.serviceId);
      if (json)
        io.out(
          JSON.stringify({
            service: service.service,
            server: service.server,
            state: service.state,
            reason: service.reason,
          }),
        );
      else io.out(serviceLine(service));
    }
    if (status.counts.waiting + status.counts.moving === 0) {
      return status.counts.failed > 0 ? MIGRATION_EXIT.someFailed : MIGRATION_EXIT.ok;
    }
    await sleep(pollMs);
  }
}

async function importCommand(
  services: ControlServices,
  io: CliIo,
  options: MigrationCliOptions,
  rest: string[],
): Promise<number> {
  const flags = new Set(rest.filter((arg) => arg.startsWith("--")));
  const path = rest.find((arg) => !arg.startsWith("--"));
  const json = flags.has("--json");
  const bundle = await loadBundle(io, options, path);
  if (!bundle) return MIGRATION_EXIT.failed;
  const state = await migrationStatus(services.db);
  if (state.phase === "finalized" && flags.has("--in-place")) {
    io.err("This server's move to 1.0 is already finalized.");
    return MIGRATION_EXIT.finalized;
  }
  let result: Awaited<ReturnType<typeof importBundle>>;
  try {
    result = await importBundle(services, bundle, {
      dryRun: flags.has("--dry-run"),
      inPlace: flags.has("--in-place"),
      deployments: !flags.has("--no-deployments"),
    });
  } catch (error) {
    if (!(error instanceof ImportRefused)) throw error;
    io.err(error.message);
    return MIGRATION_EXIT.failed;
  }
  if (json) io.out(JSON.stringify(result.report));
  else for (const line of reportText(result.report)) io.out(line);
  if (flags.has("--dry-run")) return MIGRATION_EXIT.ok;
  if (result.moves === 0) {
    if (!json && !result.importId)
      io.out("Everything in this export was imported before, so nothing changed.");
    return MIGRATION_EXIT.ok;
  }
  await enqueueMove(services.db);
  if (!flags.has("--wait")) {
    if (!json)
      io.out(
        "Moving services onto the 1.0 runner now. Follow it with: sudo nearzero migrate status",
      );
    return MIGRATION_EXIT.ok;
  }
  return follow(services, io, options.pollMs ?? 2000, json);
}

const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;

/** Every volume a bundle names: the control plane's, each service's and each volume mount's. */
function bundleVolumes(bundle: OpenedBundle): string[] {
  const names = new Set<string>();
  const install = installSchema.safeParse(bundleJson(bundle, "install.json") ?? {});
  for (const volume of (install.success ? install.data.controlPlaneVolumes : null) ?? []) {
    names.add(volume);
  }
  for (const { value } of bundleLines(bundle, RECORD_FILES.services.file)) {
    const record = value as { volumes?: unknown; settings?: { mounts?: unknown } };
    for (const volume of Array.isArray(record?.volumes) ? record.volumes : []) {
      if (typeof volume === "string") names.add(volume);
    }
    const mounts = record?.settings?.mounts;
    for (const mount of Array.isArray(mounts) ? mounts : []) {
      const volume = (mount as { volume?: unknown })?.volume;
      if (typeof volume === "string") names.add(volume);
    }
  }
  return [...names].filter((name) => VOLUME_NAME.test(name)).sort();
}

async function rollbackServers(services: ControlServices, io: CliIo): Promise<number> {
  const servers = await services.db
    .selectFrom("migration_server_move")
    .select(["target", "legacy", "state"])
    .where("target", "<>", "host")
    .where("state", "in", ["setting_up", "ready", "failed"])
    .execute();
  let failed = 0;
  for (const server of servers) {
    const own = ((server.legacy ?? []) as LegacyWorkload[]).filter(Boolean);
    const moved = await services.db
      .selectFrom("migration_move")
      .select("legacy")
      .where("target", "=", server.target)
      .where("legacy", "is not", null)
      .execute();
    const workloads = [...own, ...moved.map((row) => row.legacy as LegacyWorkload)];
    const name =
      (
        await services.db
          .selectFrom("server")
          .select("name")
          .where("id", "=", server.target)
          .executeTakeFirst()
      )?.name ?? server.target;
    const result = await runOnServer(services, server.target, rollbackServerScript(workloads));
    if (result.ok) io.out(`${name}: back on 0.1.x`);
    else {
      failed++;
      io.err(
        `${name}: couldn't be switched back (${result.reason}). Sign in to it and start its 0.1.x services by hand.`,
      );
    }
  }
  return failed > 0 ? MIGRATION_EXIT.someFailed : MIGRATION_EXIT.ok;
}

async function migrateCommand(
  services: ControlServices,
  io: CliIo,
  options: MigrationCliOptions,
  rest: string[],
): Promise<number> {
  const [sub, ...args] = rest;
  const flags = new Set(args.filter((arg) => arg.startsWith("--")));
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const json = flags.has("--json");
  switch (sub) {
    case "status":
    case undefined: {
      if (flags.has("--wait")) return follow(services, io, options.pollMs ?? 2000, json);
      const status = await migrationStatus(services.db);
      if (json) io.out(JSON.stringify(status));
      else for (const line of statusText(status)) io.out(line);
      return MIGRATION_EXIT.ok;
    }
    case "retry": {
      const status = await migrationStatus(services.db);
      if (status.phase === "finalized") {
        io.err("The move is finalized, so there is nothing left to retry.");
        return MIGRATION_EXIT.finalized;
      }
      const count = await retryFailed(services.db, positional);
      if (count === 0) {
        io.out("No service failed to move, so there is nothing to retry.");
        return MIGRATION_EXIT.ok;
      }
      await enqueueMove(services.db);
      io.out(
        `Trying ${count} service${count === 1 ? "" : "s"} again. Follow it with: sudo nearzero migrate status`,
      );
      return MIGRATION_EXIT.ok;
    }
    case "finalize": {
      const status = await migrationStatus(services.db);
      if (status.phase === "none") {
        io.err("Nothing was moved to 1.0 on this server, so there is nothing to finalize.");
        return MIGRATION_EXIT.failed;
      }
      if (status.phase === "finalized") {
        io.out("The move is already finalized.");
        return MIGRATION_EXIT.ok;
      }
      if (status.counts.waiting + status.counts.moving > 0) {
        io.err(
          "Services are still moving. Wait for the move to end (sudo nearzero migrate status), then finalize.",
        );
        return MIGRATION_EXIT.failed;
      }
      if (!flags.has("--yes")) {
        io.err("Run it as: sudo nearzero migrate finalize (it asks you to confirm first).");
        return MIGRATION_EXIT.failed;
      }
      await markFinalized(services.db);
      await enqueueFinalize(services.db);
      io.out(
        "The move is finalized. The stopped 0.1.x workloads are being removed; their volumes stay with the 1.0 services.",
      );
      return MIGRATION_EXIT.ok;
    }
    case "rollback-plan": {
      const status = await migrationStatus(services.db);
      if (status.phase === "finalized") {
        io.err("The move is finalized: the 0.1.x data is deleted, so it can't be rolled back.");
        return MIGRATION_EXIT.finalized;
      }
      const rows = await services.db
        .selectFrom("migration_move")
        .select("legacy")
        .where("target", "=", "host")
        .where("legacy", "is not", null)
        .execute();
      for (const row of rows) {
        const workload = row.legacy as LegacyWorkload;
        io.out(`${workload.kind} ${workload.name}`);
        // A stack's own files (29a.9), so rollback brings its 0.1.x copy back from them.
        if (workload.kind === "compose-project" && workload.folder) {
          io.out(`stackfolder ${workload.name} ${workload.folder}`);
          for (const file of workload.composeFiles ?? []) {
            io.out(`stackfile ${workload.name} ${file}`);
          }
          if (workload.envFile) io.out(`stackenv ${workload.name} ${workload.envFile}`);
        }
      }
      return MIGRATION_EXIT.ok;
    }
    case "rollback-servers": {
      const status = await migrationStatus(services.db);
      if (status.phase === "finalized") {
        io.err("The move is finalized: the 0.1.x data is deleted, so it can't be rolled back.");
        return MIGRATION_EXIT.finalized;
      }
      return rollbackServers(services, io);
    }
    case "control-plane": {
      const bundle = await loadBundle(io, options, positional[0]);
      if (!bundle) return MIGRATION_EXIT.failed;
      const install = installSchema.safeParse(bundleJson(bundle, "install.json") ?? {});
      // One "kind name" line each: workloads, then volumes, then the details rollback uses
      // ("project", "folder", "port"); readers act only on the kinds they know.
      for (const workload of controlPlaneWorkloads(
        install.success ? install.data.controlPlane : null,
      )) {
        io.out(`${workload.kind} ${workload.name}`);
      }
      for (const volume of (install.success ? install.data.controlPlaneVolumes : null) ?? []) {
        if (/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/.test(volume)) io.out(`volume ${volume}`);
      }
      const details = controlPlaneDetails(
        install.success ? install.data.controlPlaneDetails : null,
      );
      if (details?.composeProject) io.out(`project ${details.composeProject}`);
      if (details?.folder) io.out(`folder ${details.folder}`);
      // Its own Compose files, in order, and env file: rollback passes them (29a.9).
      for (const file of details?.composeFiles ?? []) io.out(`composefile ${file}`);
      if (details?.envFile) io.out(`envfile ${details.envFile}`);
      for (const port of details?.ports ?? []) io.out(`port ${port}`);
      // Every volume the bundle names: rollback never removes one (spec 29.5 "Rollback").
      for (const volume of bundleVolumes(bundle)) io.out(`keep ${volume}`);
      return MIGRATION_EXIT.ok;
    }
    default:
      io.err(`Unknown migrate command: ${sub}`);
      for (const line of MIGRATION_USAGE) io.err(line);
      return MIGRATION_EXIT.failed;
  }
}

/** Runs `import` or `migrate …`; null when the command is neither. */
export async function runMigrationCommand(
  args: readonly string[],
  services: ControlServices,
  io: CliIo,
  options: MigrationCliOptions,
): Promise<number | null> {
  const [command, ...rest] = args;
  if (command === "import") return importCommand(services, io, options, rest);
  if (command === "migrate") return migrateCommand(services, io, options, rest);
  return null;
}
