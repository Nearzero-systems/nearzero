import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  BACKUP_HELPER_LABEL,
  BACKUP_TOOLS_IMAGE,
  type BackupCommandKind,
  type BackupVolumesAnswer,
  formatBytes,
  isReservedVolume,
  NEARZERO_LABELS,
  type ParsedCommandParams,
  PRIVATE_NETWORK,
  type VolumeUserContainer,
} from "@nearzero/shared";
import type { CommandContext } from "../commands.ts";
import type { ContainerDetails, DockerClient } from "../docker/client.ts";
import {
  checkedFormat,
  checkStep,
  type DatabaseTarget,
  databaseSecrets,
  dumpStep,
  libsqlDumpStep,
  loadStep,
  rcloneCopyStep,
  unpackFromBucketStep,
  withScratch,
} from "./database-steps.ts";
import {
  createScratch,
  ensureImage,
  type HelperContext,
  type HelperStep,
  removeScratch,
  runHelper,
  SCRATCH_PATH,
} from "./helpers.ts";
import { loadLibsqlDump } from "./libsql.ts";
import {
  deleteStep,
  destinationSecrets,
  downloadStep,
  listedFiles,
  listStep,
  localStatStep,
  remoteStatStep,
  statSize,
  testStep,
  uploadStep,
} from "./rclone.ts";
import { runSteps } from "./steps.ts";
import {
  ARCHIVE_FILE,
  archiveFileFor,
  archiveStep,
  emptyVolumeStep,
  freeBytes,
  freeSpaceStep,
  isPlainArchive,
  unpackStep,
  verifyArchiveStep,
} from "./volume-steps.ts";

/**
 * The runner's handlers for backup and restore commands (spec 08 8.3, 17, 23.1). commands.ts
 * adds them to its table. Every step is a helper container with standard input closed, every
 * exit status is checked, and a backup whose file is empty, or whose upload doesn't match what
 * was written, fails: a run never reports success having uploaded nothing.
 *
 * Database dumps stream into the bucket and restores stream out of it (R3-50). Volume archives
 * are made on the server's disk first, so the service is stopped only while the archive is
 * written, and a restore unpacks nothing until the whole archive is here and checked; it says at
 * once when the disk is too full for that.
 *
 * Nearzero's own volumes, and volumes Nearzero's own containers use, are never archived or
 * overwritten, whatever the control plane asks (B1-03).
 */

type Handler<K extends BackupCommandKind> = (
  params: ParsedCommandParams<K>,
  context: CommandContext,
) => Promise<unknown>;

/** A refusal the runner's error mapping reports with its own words. */
export class BackupStepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupStepError";
  }
}

/** `gzip -n` of nothing: a compressed dump this size or smaller holds nothing. */
const EMPTY_GZIP_BYTES = 20;
/** Room kept free beside a downloaded backup, for the helpers and the rest of the server. */
const FREE_MARGIN_BYTES = 64 * 1024 * 1024;

const EMPTY_BACKUP = "The backup produced an empty file, so nothing was uploaded. The run failed.";

function toolsImage(requested: string): string {
  return process.env.NEARZERO_BACKUP_TOOLS_IMAGE || requested || BACKUP_TOOLS_IMAGE;
}

function helperContext(
  context: CommandContext,
  runId: string,
  secrets: readonly string[],
): HelperContext {
  const stream = context.stream;
  return {
    docker: context.docker,
    runId,
    signal: context.signal,
    secrets,
    out: (text) => stream?.text(text),
  };
}

async function steps(helpers: HelperContext, list: HelperStep[]) {
  const outcome = await runSteps(
    list,
    (step, index) => runHelper(helpers, step, index),
    helpers.out,
  );
  if (outcome.failure) throw new BackupStepError(outcome.failure.message);
  return outcome.results;
}

/** Checks the file in the scratch volume isn't empty, uploads it, and checks the upload. */
async function uploadChecked(
  helpers: HelperContext,
  image: string,
  params: { destination: ParsedCommandParams<"backup.database">["destination"]; key: string },
  scratch: string,
  file: string,
): Promise<{ key: string; bytes: number }> {
  const [local] = await steps(helpers, [localStatStep(image, scratch, file)]);
  const size = statSize(local?.stdout ?? "");
  if (size === null) throw new BackupStepError(`The backup file ${file} wasn't written.`);
  if (size === 0) throw new BackupStepError(EMPTY_BACKUP);
  helpers.out(`The backup file is ${size} bytes.\n`);
  const [, remoteStat] = await steps(helpers, [
    uploadStep(image, params.destination, scratch, file, params.key),
    remoteStatStep(image, params.destination, params.key),
  ]);
  const uploaded = statSize(remoteStat?.stdout ?? "");
  if (uploaded !== size) {
    throw new BackupStepError(
      `The upload didn't arrive whole: the bucket has ${uploaded ?? "no"} bytes of ${size}.`,
    );
  }
  return { key: params.key, bytes: size };
}

/** Removes what a failed streaming upload may have left, so it never looks like a backup. */
async function removePartial(
  helpers: HelperContext,
  image: string,
  destination: ParsedCommandParams<"backup.database">["destination"],
  key: string,
): Promise<void> {
  await runHelper(helpers, deleteStep(image, destination, key), 90).catch(() => null);
}

/** The free bytes where the scratch volume lives, or null when `df` can't tell. */
async function freeSpace(helpers: HelperContext, image: string, scratch: string) {
  const result = await runHelper(helpers, freeSpaceStep(image, scratch), 80).catch(() => null);
  return result?.exitCode === 0 ? freeBytes(result.stdout) : null;
}

/** Fails at once, with how much space is needed, when the disk can't hold the file (R3-50). */
async function requireSpace(
  helpers: HelperContext,
  image: string,
  scratch: string,
  needed: number,
  what: string,
): Promise<void> {
  const free = await freeSpace(helpers, image, scratch);
  if (free === null || free >= needed + FREE_MARGIN_BYTES) return;
  throw new BackupStepError(
    `${what} needs about ${formatBytes(needed + FREE_MARGIN_BYTES)} of free disk on the server, and only ${formatBytes(free)} is free. Free up space on the server, then try again.`,
  );
}

/** The database container's image and how a helper reaches it. */
async function databaseTarget(
  docker: DockerClient,
  params: ParsedCommandParams<"backup.database"> | ParsedCommandParams<"restore.database">,
): Promise<DatabaseTarget & { details: ContainerDetails }> {
  let details: ContainerDetails;
  try {
    details = await docker.inspectContainer(params.container);
  } catch {
    throw new BackupStepError("The database container isn't on this server. Deploy it first.");
  }
  if (!details.State.Running) {
    throw new BackupStepError("The database isn't running. Deploy or start it, then try again.");
  }
  if (details.Config.Labels?.[NEARZERO_LABELS.component]) {
    throw new BackupStepError(
      "That container is part of Nearzero itself, so the runner won't back it up or restore into it.",
    );
  }
  const networks = Object.keys(details.NetworkSettings.Networks ?? {});
  const network = networks.includes(PRIVATE_NETWORK) ? PRIVATE_NETWORK : networks[0];
  if (!network) throw new BackupStepError("The database container isn't on any network.");
  return {
    kind: params.kind,
    image: details.Image,
    network,
    host: details.Name.replace(/^\//, ""),
    port: params.port,
    database: params.database,
    user: params.user,
    password: params.password,
    rootPassword: params.rootPassword,
    details,
  };
}

async function inspectUsers(
  docker: DockerClient,
  filters: Record<string, string[]>,
): Promise<VolumeUserContainer[]> {
  const list = (await docker.json("GET", "/containers/json", {
    query: { all: true, filters: JSON.stringify(filters) },
  })) as {
    Id: string;
    Names: string[];
    State: string;
    Labels: Record<string, string> | null;
    Mounts?: { Type: string; Name?: string; Destination: string }[];
  }[];
  return list.map((item) => ({
    id: item.Id,
    name: (item.Names[0] ?? "").replace(/^\//, ""),
    state: item.State,
    labels: Object.fromEntries(
      Object.entries(item.Labels ?? {}).filter(
        ([key]) => key.startsWith("dev.nearzero.") || key.startsWith("com.docker.compose."),
      ),
    ),
    mounts: (item.Mounts ?? [])
      .filter((mount) => mount.Type === "volume" && mount.Name)
      .map((mount) => ({ name: mount.Name as string, destination: mount.Destination })),
  }));
}

/**
 * Refuses Nearzero's own volumes (spec 22.4 rule 4, B1-03): its reserved names, a volume
 * labelled as one of its components, or one a component container (the control plane, its
 * database, the runner, DNS) uses. Answers whether the volume exists.
 */
export async function guardVolume(docker: DockerClient, volume: string): Promise<boolean> {
  const refusal = new BackupStepError(
    `The volume ${volume} is Nearzero's own, so the runner won't back it up or restore over it.`,
  );
  if (isReservedVolume(volume)) throw refusal;
  const found = (await docker.findVolume(volume)) as { Labels?: Record<string, string> } | null;
  if (!found) return false;
  if (found.Labels?.[NEARZERO_LABELS.component]) throw refusal;
  const users = await inspectUsers(docker, { volume: [volume] });
  if (users.some((user) => user.labels[NEARZERO_LABELS.component])) throw refusal;
  return true;
}

/**
 * Stops the running ones of these containers, adding each to `stopped` as soon as it is down,
 * so a failure part-way still leaves the caller the list to start again (B2-17).
 */
async function stopContainers(
  docker: DockerClient,
  ids: string[],
  out: (text: string) => void,
  stopped: string[],
  note: (stopped: readonly string[]) => Promise<void>,
): Promise<void> {
  for (const id of ids) {
    const details = await docker.findContainer(id);
    if (!details?.State.Running) continue;
    const component = details.Config.Labels?.[NEARZERO_LABELS.component];
    if (component)
      throw new BackupStepError(
        "That container is part of Nearzero itself, so the runner won't stop it.",
      );
    // Noted before it stops, so a runner killed during the stop still starts it again.
    await note([...stopped, id]);
    out(`Stopping ${details.Name.replace(/^\//, "")}\n`);
    await docker.stopContainer(id, 30);
    stopped.push(id);
  }
}

/** Starts the containers again; every one is tried, and failures are reported together. */
async function startContainers(
  docker: DockerClient,
  ids: string[],
  out: (text: string) => void,
): Promise<string | null> {
  const problems: string[] = [];
  for (const id of ids) {
    try {
      await docker.startContainer(id);
      const details = await docker.findContainer(id);
      out(`Started ${details?.Name.replace(/^\//, "") ?? id} again\n`);
    } catch (error) {
      problems.push(`${id.slice(0, 12)}: ${(error as Error).message}`);
    }
  }
  return problems.length ? `Couldn't start the service again (${problems.join("; ")}).` : null;
}

/**
 * Where a runner notes the containers a backup or restore stopped until it has started them
 * again (C2-02): a runner that is stopped or killed in between starts them at its next start.
 */
export function stoppedLedgerDirectory(workDirectory: string): string {
  return join(workDirectory, "stopped-by-backups");
}

function ledgerFile(workDirectory: string, runId: string): string {
  return join(stoppedLedgerDirectory(workDirectory), `${runId.replace(/[^A-Za-z0-9-]/g, "")}.json`);
}

async function writeLedger(path: string, ids: readonly string[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const partial = `${path}.partial`;
  await writeFile(partial, JSON.stringify({ containers: ids }), { mode: 0o600 });
  await rename(partial, path);
}

/**
 * At the runner's start: containers that an earlier runner process stopped for a backup or a
 * restore and never started again (it was stopped mid-way, C2-02) are started now, whatever the
 * work's outcome, as a finished restore would (spec 17.3). Returns the ones started.
 */
export async function startLeftStopped(
  docker: DockerClient,
  workDirectory: string,
  log: { warn(message: string, fields?: Record<string, unknown>): void },
): Promise<string[]> {
  const directory = stoppedLedgerDirectory(workDirectory);
  const names = await readdir(directory).catch(() => [] as string[]);
  const started: string[] = [];
  for (const name of names.filter((item) => item.endsWith(".json"))) {
    const path = join(directory, name);
    let ids: string[] = [];
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as { containers?: unknown };
      ids = Array.isArray(parsed.containers)
        ? parsed.containers.filter((id): id is string => typeof id === "string")
        : [];
    } catch {}
    for (const id of ids) {
      try {
        const details = await docker.findContainer(id);
        if (!details || details.State.Running) continue;
        await docker.startContainer(id);
        started.push(id);
      } catch (error) {
        log.warn("couldn't start a container a backup had stopped", {
          container: id.slice(0, 12),
          reason: (error as Error).message,
        });
      }
    }
    await rm(path, { force: true }).catch(() => {});
  }
  return started;
}

/**
 * Runs `work` with these containers stopped, and starts every one it stopped again whatever
 * happens, a failure while stopping included (spec 17.3, B2-17). The first failure is the
 * result; a failure to start again is reported too. While they are down, the list is kept in the
 * work folder, so a runner stopped in between starts them at its next start (C2-02).
 */
async function whileStopped<T>(
  docker: DockerClient,
  ids: string[],
  out: (text: string) => void,
  work: (stopped: string[]) => Promise<T>,
  ledger: string,
): Promise<T> {
  const stopped: string[] = [];
  let failure: unknown = null;
  let result: T | undefined;
  try {
    await stopContainers(docker, ids, out, stopped, (now) => writeLedger(ledger, now));
    result = await work(stopped);
  } catch (error) {
    failure = error;
  }
  const problem = await startContainers(docker, stopped, out);
  await rm(ledger, { force: true }).catch(() => {});
  if (failure) {
    if (problem) out(`${problem}\n`);
    throw failure;
  }
  if (problem) throw new BackupStepError(problem);
  return result as T;
}

function gunzipStep(image: string, file: string): HelperStep {
  return {
    title: "Decompressing the backup",
    image,
    argv: ["gzip", "-d", "-f", `${SCRATCH_PATH}/${file}`],
    mounts: [{ source: "", target: SCRATCH_PATH }],
  };
}

export const backupHandlers: { [K in BackupCommandKind]: Handler<K> } = {
  "backup.test": async (params, context) => {
    const image = toolsImage(params.toolsImage);
    const helpers = helperContext(
      context,
      crypto.randomUUID(),
      destinationSecrets(params.destination),
    );
    // Fetching the helper image is not part of the 10 seconds (spec 17.1).
    await ensureImage(context.docker, image, () => {}, context.signal);
    const result = await runHelper(
      helpers,
      testStep(image, params.destination, params.timeoutSeconds, params.pinnedHosts),
      0,
    );
    if (result.exitCode !== 0) {
      throw new BackupStepError(
        result.exitCode === null
          ? `The bucket didn't answer within ${params.timeoutSeconds} seconds.`
          : `The store refused the listing (rclone exit code ${result.exitCode}).`,
      );
    }
    return { entries: result.stdout.split("\n").filter(Boolean).length };
  },

  "backup.files": async (params, context) => {
    const image = toolsImage(params.toolsImage);
    const helpers = helperContext(
      context,
      crypto.randomUUID(),
      destinationSecrets(params.destination),
    );
    const result = await runHelper(helpers, listStep(image, params.destination, params.prefix), 0);
    if (result.exitCode === 3) return { files: [] };
    if (result.exitCode !== 0) {
      throw new BackupStepError(
        `Listing the backups failed (rclone exit code ${result.exitCode ?? "none"}).`,
      );
    }
    return { files: listedFiles(result.stdout, params.prefix) };
  },

  "backup.prune": async (params, context) => {
    const image = toolsImage(params.toolsImage);
    const helpers = helperContext(
      context,
      crypto.randomUUID(),
      destinationSecrets(params.destination),
    );
    const deleted: string[] = [];
    for (const [index, key] of params.keys.entries()) {
      const result = await runHelper(helpers, deleteStep(image, params.destination, key), index);
      if (result.exitCode !== 0) {
        throw new BackupStepError(
          `Deleting ${key} failed (rclone exit code ${result.exitCode ?? "none"}).`,
        );
      }
      deleted.push(key);
    }
    return { deleted };
  },

  "backup.database": async (params, context) => {
    const image = toolsImage(params.toolsImage);
    const docker = context.docker;
    const target = await databaseTarget(docker, params);
    const helpers = helperContext(context, params.runId, [
      ...databaseSecrets(target),
      ...destinationSecrets(params.destination),
    ]);
    const scratch = await createScratch(docker, params.runId);
    try {
      if (params.archive) {
        // libSQL with namespaces: its data folder holds every namespace (R3-51). It is copied
        // with the database stopped, so the copy is consistent, and started again at once.
        const volume = params.dataVolume;
        if (!volume) throw new BackupStepError("The database's data volume isn't known.");
        await guardVolume(docker, volume);
        helpers.out("Stopping the database while its data folder is copied.\n");
        await whileStopped(
          docker,
          [target.details.Id],
          helpers.out,
          () => steps(helpers, [archiveStep(image, volume, scratch)]),
          ledgerFile(context.workDirectory, params.runId),
        );
        return await uploadChecked(helpers, image, params, scratch, ARCHIVE_FILE);
      }
      try {
        await steps(
          helpers,
          target.kind === "libsql"
            ? [libsqlDumpStep(image, target, params.destination, params.key)]
            : withScratch(
                [rcloneCopyStep(image), dumpStep(target, params.destination, params.key)],
                scratch,
              ),
        );
      } catch (error) {
        await removePartial(helpers, image, params.destination, params.key);
        throw error;
      }
      const [stat] = await steps(helpers, [remoteStatStep(image, params.destination, params.key)]);
      const size = statSize(stat?.stdout ?? "");
      if (size === null)
        throw new BackupStepError("The backup isn't in the bucket after the upload.");
      if (size <= EMPTY_GZIP_BYTES) {
        await removePartial(helpers, image, params.destination, params.key);
        throw new BackupStepError(EMPTY_BACKUP);
      }
      helpers.out(`The backup file is ${size} bytes.\n`);
      return { key: params.key, bytes: size };
    } finally {
      await removeScratch(docker, params.runId);
    }
  },

  "restore.database": async (params, context) => {
    const image = toolsImage(params.toolsImage);
    const docker = context.docker;
    const target = await databaseTarget(docker, params);
    const helpers = helperContext(context, params.runId, [
      ...databaseSecrets(target),
      ...destinationSecrets(params.destination),
    ]);
    const scratch = await createScratch(docker, params.runId);
    try {
      const [stat] = await steps(helpers, [remoteStatStep(image, params.destination, params.key)]);
      const size = statSize(stat?.stdout ?? "");
      if (!size) throw new BackupStepError("The backup file is empty, so nothing was restored.");
      // Nothing is touched until the whole file has been read once and found whole.
      const [checked] = await steps(helpers, [
        checkStep(image, params.kind, params.destination, params.key),
      ]);
      const format = checkedFormat(checked?.stdout ?? "");
      if (!format) throw new BackupStepError("The backup file's format couldn't be told.");
      helpers.out(
        `The backup is ${
          format === "pgdump"
            ? "a Postgres archive"
            : format === "tar"
              ? "an archive of a data folder"
              : format === "mongodb"
                ? "a MongoDB archive"
                : "an SQL dump"
        }.\n`,
      );
      if (format === "tar") {
        if (params.kind !== "libsql" || !params.dataVolume) {
          throw new BackupStepError(
            "This backup is an archive of a data folder, not a dump this database can load.",
          );
        }
        const volume = params.dataVolume;
        await guardVolume(docker, volume);
        helpers.out("Stopping the database while its data folder is replaced.\n");
        await whileStopped(
          docker,
          [target.details.Id],
          helpers.out,
          () =>
            steps(helpers, [
              emptyVolumeStep(image, volume),
              unpackFromBucketStep(image, volume, params.destination, params.key),
            ]),
          ledgerFile(context.workDirectory, params.runId),
        );
        return { bytes: size, format };
      }
      if (format === "pgdump" && params.kind !== "postgres") {
        throw new BackupStepError(
          "This backup is a Postgres archive, not a dump of this database.",
        );
      }
      if (params.kind === "libsql") {
        // An SQL dump goes in over libSQL's HTTP interface, built in memory (up to 512 MB).
        await requireSpace(helpers, image, scratch, size * 2, "Restoring this backup");
        await steps(
          helpers,
          withScratch(
            [
              downloadStep(image, params.destination, scratch, params.key, "dump.sql.gz"),
              gunzipStep(image, "dump.sql.gz"),
            ],
            scratch,
          ),
        );
        await loadLibsqlDump(helpers, image, target, scratch);
        return { bytes: size, format };
      }
      await steps(
        helpers,
        withScratch(
          [
            rcloneCopyStep(image),
            loadStep(
              target,
              params.destination,
              params.key,
              format as "sql" | "pgdump" | "mongodb",
              params.sourceDatabase,
            ),
          ],
          scratch,
        ),
      );
      return { bytes: size, format };
    } finally {
      await removeScratch(docker, params.runId);
    }
  },

  "backup.volume": async (params, context) => {
    const image = toolsImage(params.toolsImage);
    const docker = context.docker;
    if (!(await guardVolume(docker, params.volume))) {
      throw new BackupStepError(`The volume ${params.volume} isn't on this server.`);
    }
    const helpers = helperContext(context, params.runId, destinationSecrets(params.destination));
    const scratch = await createScratch(docker, params.runId);
    try {
      // The service starts again whether the copy worked or not (spec 17.3).
      const stopped = await whileStopped(
        docker,
        params.stop,
        helpers.out,
        async (ids) => {
          await steps(helpers, [archiveStep(image, params.volume, scratch)]);
          return [...ids];
        },
        ledgerFile(context.workDirectory, params.runId),
      );
      return { ...(await uploadChecked(helpers, image, params, scratch, ARCHIVE_FILE)), stopped };
    } finally {
      await removeScratch(docker, params.runId);
    }
  },

  "restore.volume": async (params, context) => {
    const image = toolsImage(params.toolsImage);
    const docker = context.docker;
    const exists = await guardVolume(docker, params.volume);
    if (!exists && !params.create) {
      throw new BackupStepError(`The volume ${params.volume} isn't on this server.`);
    }
    // Refused when anything else uses the volume (spec 17.3), checked here as well.
    const users = exists ? await inspectUsers(docker, { volume: [params.volume] }) : [];
    const allowed = new Set(params.allowedContainers);
    const others = users.filter((user) => !allowed.has(user.id) && !allowed.has(user.name));
    if (others.length > 0 && others.every((user) => user.labels[BACKUP_HELPER_LABEL])) {
      // Another backup or restore's helper still has it (C1-11): not another service.
      throw new BackupStepError(
        "Another backup or restore of this volume is still running on the server, so nothing was overwritten. Restore again once it has finished.",
      );
    }
    if (others.length > 0) {
      throw new BackupStepError(
        "Another service also uses this volume, so Nearzero won't overwrite it.",
      );
    }
    const helpers = helperContext(context, params.runId, destinationSecrets(params.destination));
    const scratch = await createScratch(docker, params.runId);
    const plain = isPlainArchive(params.key);
    const file = archiveFileFor(params.key);
    try {
      const [remote] = await steps(helpers, [
        remoteStatStep(image, params.destination, params.key),
      ]);
      const remoteSize = statSize(remote?.stdout ?? "");
      if (!remoteSize)
        throw new BackupStepError("The backup file is empty, so nothing was restored.");
      await requireSpace(helpers, image, scratch, remoteSize, "Restoring this backup");
      // Nothing is touched until the archive is here and whole.
      const [, stat] = await steps(helpers, [
        downloadStep(image, params.destination, scratch, params.key, file),
        localStatStep(image, scratch, file),
        verifyArchiveStep(image, scratch, plain),
      ]);
      const size = statSize(stat?.stdout ?? "");
      if (!size) throw new BackupStepError("The backup file is empty, so nothing was restored.");
      if (!exists) {
        // A volume the service mounts that isn't on this server yet (R3-52).
        await docker.createVolume(params.volume, {
          ...(params.create?.labels ?? {}),
          [NEARZERO_LABELS.managed]: "true",
        });
        helpers.out(`Created the volume ${params.volume}.\n`);
      }
      const restarted = await whileStopped(
        docker,
        users.map((user) => user.id),
        helpers.out,
        async (stopped) => {
          // Its containers start again even when the restore failed, and the real result is kept.
          const outcome = await runSteps(
            [
              emptyVolumeStep(image, params.volume),
              unpackStep(image, params.volume, scratch, plain),
            ],
            (step, index) => runHelper(helpers, step, index + 10),
            helpers.out,
          );
          if (outcome.failure) throw new BackupStepError(outcome.failure.message);
          return [...stopped];
        },
        ledgerFile(context.workDirectory, params.runId),
      );
      return { bytes: size, restarted, created: !exists };
    } finally {
      await removeScratch(docker, params.runId);
    }
  },

  "backup.volumes": async (params, context) => {
    const docker = context.docker;
    const containers = new Map<string, VolumeUserContainer>();
    for (const labels of params.containerLabels) {
      for (const container of await inspectUsers(docker, { label: labels })) {
        containers.set(container.id, container);
      }
    }
    const volumes = new Map<string, { name: string; labels: Record<string, string> }>();
    for (const labels of params.volumeLabels) {
      const list = await docker.listVolumes(labels);
      for (const volume of list)
        volumes.set(volume.Name, { name: volume.Name, labels: volume.Labels ?? {} });
    }
    const users: Record<string, VolumeUserContainer[]> = {};
    const missing: string[] = [];
    for (const name of params.volumes) {
      if (!(await docker.findVolume(name))) {
        missing.push(name);
        users[name] = [];
        continue;
      }
      users[name] = await inspectUsers(docker, { volume: [name] });
    }
    const answer: BackupVolumesAnswer = {
      containers: [...containers.values()],
      volumes: [...volumes.values()],
      users,
      missing,
    };
    return answer;
  },
};
