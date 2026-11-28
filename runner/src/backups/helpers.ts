import { BACKUP_HELPER_LABEL, NEARZERO_LABELS } from "@nearzero/shared";
import { type DockerClient, DockerError } from "../docker/client.ts";
import { demuxDockerStream } from "../docker/demux.ts";
import { createTar, type TarEntry } from "../docker/tar.ts";
import { Redactor } from "../exec/command.ts";
import type { Step, StepResult } from "./steps.ts";

/**
 * Short-lived helper containers for backup steps (spec 17, 23.1). Each step runs in a container
 * of its own, created with standard input closed (nothing can be attached to it), its program
 * and arguments as an array (no shell), the files it needs written in before it starts (keys
 * and passwords never go on its command line), and the run's scratch volume mounted at /backup.
 * Its output is streamed to the run's log with secrets cut out; it is removed when it ends.
 */

export const BACKUP_RUN_LABEL = BACKUP_HELPER_LABEL;
export const SCRATCH_PATH = "/backup";
/** Where a helper's own files (rclone.conf, a password file) are written before it starts. */
export const HELPER_FILES_DIR = "/nearzero";

export interface HelperMount {
  /** A named volume. */
  source: string;
  target: string;
  readOnly?: boolean;
}

export interface HelperStep extends Step {
  image: string;
  mounts?: HelperMount[];
  /** A network to join (the database's), to reach it by name. */
  network?: string;
  /** `name:address` lines for the helper's /etc/hosts (a name pinned to a checked address). */
  extraHosts?: string[];
  env?: Record<string, string>;
  /** Files written under /nearzero before the program starts; their content is secret. */
  files?: { name: string; content: string }[];
  user?: string;
  /** Keep standard output apart from the log (rclone's JSON answers). */
  captureStdout?: boolean;
  timeoutMs?: number;
}

export interface HelperContext {
  docker: DockerClient;
  runId: string;
  signal: AbortSignal;
  secrets: readonly string[];
  out: (text: string) => void;
}

/** The container a step runs in, as the Engine API takes it. Pure, so the rules are tested. */
export function helperConfig(step: HelperStep, runId: string): Record<string, unknown> {
  const [program, ...args] = step.argv;
  if (!program) throw new Error("A helper step needs a program.");
  return {
    Image: step.image,
    Entrypoint: [program],
    Cmd: args,
    Env: Object.entries(step.env ?? {}).map(([key, value]) => `${key}=${value}`),
    Labels: { [NEARZERO_LABELS.managed]: "true", [BACKUP_RUN_LABEL]: runId },
    // Standard input is closed for good: never attached, never kept open (spec 23.1).
    AttachStdin: false,
    OpenStdin: false,
    StdinOnce: false,
    Tty: false,
    ...(step.user ? { User: step.user } : {}),
    HostConfig: {
      AutoRemove: false,
      Mounts: (step.mounts ?? []).map((mount) => ({
        Type: "volume",
        Source: mount.source,
        Target: mount.target,
        ReadOnly: mount.readOnly ?? false,
      })),
      LogConfig: { Type: "json-file", Config: { "max-size": "20m", "max-file": "2" } },
      ...(step.network ? { NetworkMode: step.network } : {}),
      ...(step.extraHosts?.length ? { ExtraHosts: step.extraHosts } : {}),
    },
  };
}

function helperName(runId: string, index: number): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `nearzero-backup-${runId.slice(0, 8)}-${index}-${random}`;
}

export async function ensureImage(
  docker: DockerClient,
  image: string,
  out: (text: string) => void,
  signal: AbortSignal,
): Promise<void> {
  if (await docker.imageExists(image)) return;
  out(`Pulling ${image}\n`);
  await docker.pullImage(image, { signal, onProgress: () => {} });
  out(`Pulled ${image}\n`);
}

async function pipeLogs(
  docker: DockerClient,
  id: string,
  redactor: Redactor,
  out: (text: string) => void,
  signal: AbortSignal,
  stdout: boolean,
): Promise<void> {
  const response = await docker.request("GET", `/containers/${encodeURIComponent(id)}/logs`, {
    query: { follow: true, stdout, stderr: true },
    signal,
  });
  if (!response.body) return;
  const decoder = new TextDecoder();
  try {
    for await (const chunk of demuxDockerStream(
      response.body as unknown as AsyncIterable<Uint8Array>,
    )) {
      const text = redactor.push(decoder.decode(chunk, { stream: true }));
      if (text) out(text);
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  }
  const rest = redactor.flush();
  if (rest) out(rest);
}

async function readStdout(docker: DockerClient, id: string): Promise<string> {
  const response = await docker.request("GET", `/containers/${encodeURIComponent(id)}/logs`, {
    query: { follow: false, stdout: true, stderr: false },
  });
  if (!response.body) return "";
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of demuxDockerStream(
    response.body as unknown as AsyncIterable<Uint8Array>,
  )) {
    text += decoder.decode(chunk, { stream: true });
    if (text.length > 16 * 1024 * 1024) throw new Error("The helper printed too much.");
  }
  return text + decoder.decode();
}

/** Writes files under /nearzero in a created container (before it starts). */
async function putHelperFiles(
  docker: DockerClient,
  id: string,
  files: { name: string; content: string }[],
): Promise<void> {
  const entries: TarEntry[] = [
    { path: HELPER_FILES_DIR.slice(1), type: "directory", mode: 0o700, uid: 0, gid: 0 },
    ...files.map((file) => ({
      path: `${HELPER_FILES_DIR.slice(1)}/${file.name}`,
      type: "file" as const,
      content: new TextEncoder().encode(file.content),
      mode: 0o600,
      uid: 0,
      gid: 0,
    })),
  ];
  await docker.putArchive(id, "/", createTar(entries));
}

/** Runs one step in a helper container and waits for it; never leaves the container behind. */
export async function runHelper(
  context: HelperContext,
  step: HelperStep,
  index: number,
): Promise<StepResult> {
  const { docker } = context;
  await ensureImage(docker, step.image, context.out, context.signal);
  const id = await docker.createContainer(
    helperName(context.runId, index),
    helperConfig(step, context.runId),
  );
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), step.timeoutMs ?? 12 * 3_600_000);
  const onAbort = () => stop.abort();
  context.signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (step.files?.length) await putHelperFiles(docker, id, step.files);
    await docker.startContainer(id);
    const redactor = new Redactor(context.secrets);
    const logs = pipeLogs(docker, id, redactor, context.out, stop.signal, !step.captureStdout);
    const killOnStop = () => {
      void docker.call("POST", `/containers/${encodeURIComponent(id)}/kill`).catch(() => {});
    };
    stop.signal.addEventListener("abort", killOnStop, { once: true });
    const waited = await docker.waitContainer(id, "not-running");
    await logs.catch(() => {});
    stop.signal.removeEventListener("abort", killOnStop);
    if (stop.signal.aborted) {
      return { exitCode: null, stdout: "" };
    }
    const stdout = step.captureStdout ? await readStdout(docker, id) : "";
    return { exitCode: waited.StatusCode, stdout };
  } finally {
    clearTimeout(timer);
    context.signal.removeEventListener("abort", onAbort);
    await docker.removeContainer(id, { force: true }).catch(() => {});
  }
}

// ---- The run's scratch volume

export function scratchVolumeName(runId: string): string {
  return `nearzero-backup-${runId}`;
}

export async function createScratch(docker: DockerClient, runId: string): Promise<string> {
  const name = scratchVolumeName(runId);
  if (!(await docker.findVolume(name))) {
    await docker.createVolume(name, {
      [NEARZERO_LABELS.managed]: "true",
      [BACKUP_RUN_LABEL]: runId,
    });
  }
  return name;
}

export async function removeScratch(docker: DockerClient, runId: string): Promise<void> {
  await docker.removeVolume(scratchVolumeName(runId), true).catch((error) => {
    if (error instanceof DockerError && error.status === 404) return;
  });
}

// ---- Reading and writing one file of the scratch volume through Docker's archive endpoint

/** A created (never started) container with the scratch volume, to copy files in and out. */
async function holder(
  docker: DockerClient,
  image: string,
  runId: string,
  scratch: string,
): Promise<string> {
  return docker.createContainer(
    `nearzero-backup-${runId.slice(0, 8)}-files-${Math.random().toString(36).slice(2, 8)}`,
    helperConfig(
      {
        title: "files",
        argv: ["true"],
        image,
        mounts: [{ source: scratch, target: SCRATCH_PATH }],
      },
      runId,
    ),
  );
}

function octalField(block: Uint8Array, at: number, length: number): number {
  const text = new TextDecoder()
    .decode(block.subarray(at, at + length))
    .replace(/\0.*$/, "")
    .trim();
  return text === "" ? 0 : Number.parseInt(text, 8);
}

/** The content of the first regular file in a tar archive. */
export function firstFileOfTar(tar: Uint8Array): Uint8Array | null {
  let at = 0;
  while (at + 512 <= tar.length) {
    const block = tar.subarray(at, at + 512);
    if (block.every((byte) => byte === 0)) return null;
    const size = octalField(block, 124, 12);
    const type = String.fromCharCode(block[156] ?? 0);
    const start = at + 512;
    if (type === "0" || type === "\0") return tar.slice(start, start + size);
    at = start + Math.ceil(size / 512) * 512;
  }
  return null;
}

export async function readScratchFile(
  docker: DockerClient,
  image: string,
  runId: string,
  scratch: string,
  name: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const id = await holder(docker, image, runId, scratch);
  try {
    const response = await docker.request("GET", `/containers/${encodeURIComponent(id)}/archive`, {
      query: { path: `${SCRATCH_PATH}/${name}` },
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > maxBytes + 1024) {
      throw new Error(`${name} is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`);
    }
    const content = firstFileOfTar(bytes);
    if (!content) throw new Error(`${name} isn't in the scratch folder.`);
    return content;
  } finally {
    await docker.removeContainer(id, { force: true }).catch(() => {});
  }
}

export async function writeScratchFile(
  docker: DockerClient,
  image: string,
  runId: string,
  scratch: string,
  name: string,
  content: Uint8Array,
): Promise<void> {
  const id = await holder(docker, image, runId, scratch);
  try {
    await docker.putArchive(
      id,
      SCRATCH_PATH,
      createTar([{ path: name, type: "file", content, mode: 0o600, uid: 0, gid: 0 }]),
    );
  } finally {
    await docker.removeContainer(id, { force: true }).catch(() => {});
  }
}
