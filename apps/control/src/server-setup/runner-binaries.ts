import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Architecture } from "./parse.ts";

/**
 * The compiled runner setup installs on a server (spec 25 D1, D5): one binary per architecture
 * and C library, as runner/scripts/build.ts writes them, with SHA256SUMS beside them. The image
 * keeps them gzip-compressed (`<file>.gz`), a checkout as plain files; either way SHA256SUMS
 * lists the binary itself. The binary is checked against its sum here before it is sent, and
 * again on the server before it is installed.
 */

export interface RunnerBinary {
  file: string;
  path: string;
  sha256: string;
  bytes: Uint8Array;
}

export function runnerFileName(architecture: Architecture, libc: "glibc" | "musl"): string {
  const arch = architecture === "amd64" ? "x64" : "arm64";
  return `nearzero-runner-linux-${arch}${libc === "musl" ? "-musl" : ""}`;
}

/** Reads `<sum>  <file>` lines. */
export function parseSums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim());
    if (match) out.set(match[2] as string, match[1] as string);
  }
  return out;
}

export class MissingRunnerError extends Error {}

const cache = new Map<string, { mtimeMs: number; binary: RunnerBinary }>();

export async function loadRunnerBinary(
  directory: string,
  architecture: Architecture,
  libc: "glibc" | "musl",
): Promise<RunnerBinary> {
  const file = runnerFileName(architecture, libc);
  const plain = Bun.file(join(directory, file));
  const compressed = Bun.file(join(directory, `${file}.gz`));
  const sumsText = await readFile(join(directory, "SHA256SUMS"), "utf8").catch(() => null);
  const handle = (await plain.exists()) ? plain : compressed;
  const path = handle === plain ? join(directory, file) : join(directory, `${file}.gz`);
  if (sumsText === null || !(await handle.exists())) {
    throw new MissingRunnerError(
      `This Nearzero doesn't have the runner for this server (${file}) in ${directory}. Build it with "bun run --cwd runner build", or set NEARZERO_RUNNER_BINARIES_DIR to a folder with the runners and their SHA256SUMS.`,
    );
  }
  const expected = parseSums(sumsText).get(file);
  if (!expected) {
    throw new MissingRunnerError(`${file} isn't listed in ${join(directory, "SHA256SUMS")}.`);
  }
  const stat = await handle.stat();
  const known = cache.get(path);
  if (known && known.mtimeMs === stat.mtimeMs && known.binary.sha256 === expected) {
    return known.binary;
  }
  let bytes = new Uint8Array(await handle.arrayBuffer());
  if (handle === compressed) {
    try {
      bytes = Bun.gunzipSync(bytes);
    } catch {
      throw new MissingRunnerError(
        `${path} isn't a readable gzip file, so the runner wasn't sent. Build the runners again.`,
      );
    }
  }
  const actual = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw new MissingRunnerError(
      `${path} doesn't match its SHA256SUMS entry (it is ${actual}), so it wasn't sent. Build the runners again.`,
    );
  }
  const binary = { file, path, sha256: expected, bytes };
  // One runner is kept in memory (about 100 MB); servers of one kind are usually set up together.
  cache.clear();
  cache.set(path, { mtimeMs: stat.mtimeMs, binary });
  return binary;
}
