import { createHash } from "node:crypto";
import { access, chmod, constants, mkdir, mkdtemp, rename, rm, statfs } from "node:fs/promises";
import { join } from "node:path";
import { formatBytes } from "@nearzero/shared";
import {
  type Architecture,
  DEFAULT_BUILDERS_DIR,
  defaultRelease,
  TOOL_RELEASES,
  type ToolRelease,
} from "../../tools/pins.ts";
import { runCommand } from "../exec/command.ts";

/**
 * Finding the builder tools on the build machine and checking them before a build starts
 * (spec 6.4, 23.1 "Tools are checked before use"): a missing tool stops the build at once with
 * "<tool> is not installed on the build machine" and the fix.
 */

export class MissingToolError extends Error {
  constructor(tool: string, containerized: boolean) {
    super(
      `${tool} is not installed on the build machine. ${
        containerized
          ? "Run the Nearzero install command again on the host to update its image, which carries the builders."
          : "Run setup again on this server's page to install it."
      }`,
    );
    this.name = "MissingToolError";
  }
}

export interface ToolContext {
  buildersDir: string;
  containerized: boolean;
  env: Record<string, string>;
  signal: AbortSignal;
  /** For repairs (G3-04): how archives are downloaded, and the pins; tests replace them. */
  downloads?: { fetch?: typeof fetch; releases?: readonly ToolRelease[] };
}

/** The free space a build needs where it works (31c G3-04). */
export const BUILD_MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Why a build can't start on this disk, or null (G3-04): under 2 GB free where it works, it
 * would otherwise fail partway with the tool's own error. `free` replaces the measurement.
 */
export async function freeSpaceProblem(folder: string, free?: number): Promise<string | null> {
  let available = free;
  if (available === undefined) {
    const stats = await statfs(folder).catch(() => null);
    if (!stats) return null;
    available = Number(stats.bavail) * Number(stats.bsize);
  }
  if (available >= BUILD_MIN_FREE_BYTES) return null;
  return `This server has only ${formatBytes(available, { trimZeros: true })} of free disk space where builds work, and a build needs at least 2 GB. Free some space (unused images and build cache go with docker system prune), then deploy again.`;
}

function architecture(): Architecture {
  return process.arch === "arm64" ? "arm64" : "amd64";
}

/**
 * Installs a pinned builder the server lacks (G3-04), as setup would: the release's archive for
 * this processor, checked against its pinned SHA-256, unpacked into its own version's folder.
 * Nothing is installed when the checksum differs.
 */
export async function repairTool(
  release: ToolRelease,
  context: ToolContext,
  out: (text: string) => void,
): Promise<string> {
  const asset = release.assets[architecture()];
  out(
    `Server capability repair started: ${release.tool} ${release.version} is missing, so it is installed now.\n`,
  );
  const get = context.downloads?.fetch ?? fetch;
  const response = await get(asset.url, { signal: context.signal });
  if (!response.ok) {
    throw new Error(
      `Downloading ${release.tool} ${release.version} failed (HTTP ${response.status}).`,
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const sum = createHash("sha256").update(bytes).digest("hex");
  if (sum !== asset.sha256) {
    throw new Error(
      `The download of ${release.tool} ${release.version} doesn't match its pinned checksum, so it wasn't installed.`,
    );
  }
  const folder = join(context.buildersDir, release.tool, release.version);
  await mkdir(join(context.buildersDir, release.tool), { recursive: true, mode: 0o755 });
  const work = await mkdtemp(join(context.buildersDir, release.tool, ".repair-"));
  try {
    const archive = join(work, "archive.tar.gz");
    await Bun.write(archive, bytes);
    const unpacked = join(work, "unpacked");
    await mkdir(unpacked);
    const untar = await runCommand({
      argv: ["tar", "-xzf", archive, "-C", unpacked],
      env: context.env,
      timeoutMs: 120_000,
      signal: context.signal,
    });
    if (untar.exitCode !== 0) {
      throw new Error(`Unpacking ${release.tool} ${release.version} failed.`);
    }
    if (!(await executable(join(unpacked, release.binary)).catch(() => false))) {
      await chmod(join(unpacked, release.binary), 0o755).catch(() => {});
    }
    if (!(await executable(join(unpacked, release.binary)))) {
      throw new Error(`${release.binary} isn't in the ${release.tool} ${release.version} archive.`);
    }
    await rm(folder, { recursive: true, force: true });
    await rename(unpacked, folder);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  out(`Installed ${release.tool} ${release.version}.\n`);
  return join(folder, release.binary);
}

/**
 * A pinned tool, installed first when a server lacks it (G3-04): servers pick up a new pinned
 * version after an upgrade without setup being run again. The Nearzero host's image carries its
 * builders, so there a missing one still says to run the installer again.
 */
export async function ensureTool(
  tool: ToolRelease["tool"],
  version: string | null,
  context: ToolContext,
  out: (text: string) => void,
): Promise<string> {
  try {
    return await locateTool(tool, version, context);
  } catch (error) {
    if (!(error instanceof MissingToolError) || context.containerized) throw error;
    const releases = context.downloads?.releases ?? TOOL_RELEASES;
    const wanted = version ?? defaultRelease(tool).version;
    const release = releases.find((item) => item.tool === tool && item.version === wanted);
    if (!release) throw error;
    return repairTool(release, context, out);
  }
}

export function buildersDirectory(env: Record<string, string | undefined>): string {
  return env.NEARZERO_BUILDERS_DIR?.trim() || DEFAULT_BUILDERS_DIR;
}

async function executable(path: string): Promise<boolean> {
  return access(path, constants.X_OK)
    .then(() => true)
    .catch(() => false);
}

/** The path of a pinned tool: its own version's folder, or PATH for the default version. */
export async function locateTool(
  tool: ToolRelease["tool"],
  version: string | null,
  context: ToolContext,
): Promise<string> {
  const release = defaultRelease(tool);
  const wanted = version ?? release.version;
  const pinned = join(context.buildersDir, tool, wanted, release.binary);
  if (await executable(pinned)) return pinned;
  if (wanted === release.version) {
    const onPath = Bun.which(release.binary, { PATH: context.env.PATH ?? process.env.PATH ?? "" });
    if (onPath) return onPath;
  }
  throw new MissingToolError(version ? `${tool} ${wanted}` : tool, context.containerized);
}

/** Docker's build front end, which every builder but the buildpacks drives. */
export async function requireBuildx(context: ToolContext): Promise<void> {
  if (!Bun.which("docker", { PATH: context.env.PATH ?? process.env.PATH ?? "" })) {
    throw new MissingToolError("docker", context.containerized);
  }
  const result = await runCommand({
    argv: ["docker", "buildx", "version"],
    env: context.env,
    timeoutMs: 20_000,
    signal: context.signal,
  });
  if (result.exitCode !== 0) throw new MissingToolError("docker buildx", context.containerized);
}

export async function requireGit(context: ToolContext): Promise<void> {
  if (!Bun.which("git", { PATH: context.env.PATH ?? process.env.PATH ?? "" })) {
    throw new MissingToolError("git", context.containerized);
  }
}
