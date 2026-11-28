import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { type Architecture, DEFAULT_BUILDERS_DIR, TOOL_RELEASES } from "./pins.ts";

/**
 * Installs the pinned builder tools for one architecture:
 *
 *   bun runner/tools/install.ts --arch arm64 [--dest /usr/local/lib/nearzero/builders]
 *
 * Each archive is downloaded, checked against its pinned SHA-256 (a mismatch stops everything),
 * and unpacked to <dest>/<tool>/<version>/. The first listed version of each tool is linked from
 * <dest>/bin (relative links, so the folder can be copied whole); put that folder on PATH. Used by
 * the production image's build, the end-to-end suites, and (later) server setup.
 */

function argument(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value) return value;
  if (fallback !== undefined) return fallback;
  console.error(`Missing --${name}.`);
  process.exit(2);
}

const arch = argument("arch") as Architecture;
if (arch !== "amd64" && arch !== "arm64") {
  console.error(`--arch must be amd64 or arm64, not ${arch}.`);
  process.exit(2);
}
const dest = argument("dest", DEFAULT_BUILDERS_DIR);

const work = await mkdtemp(join(tmpdir(), "nearzero-tools-"));
const linked = new Set<string>();
try {
  for (const release of TOOL_RELEASES) {
    const asset = release.assets[arch];
    const response = await fetch(asset.url);
    if (!response.ok) throw new Error(`Downloading ${asset.url} failed: ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const sum = createHash("sha256").update(bytes).digest("hex");
    if (sum !== asset.sha256) {
      throw new Error(`${asset.url} has checksum ${sum}, expected ${asset.sha256}. Not installed.`);
    }
    const archive = join(work, `${release.tool}-${release.version}.tar.gz`);
    await Bun.write(archive, bytes);
    const folder = join(dest, release.tool, release.version);
    await mkdir(folder, { recursive: true });
    const untar = Bun.spawnSync(["tar", "-xzf", archive, "-C", folder], { stderr: "pipe" });
    if (untar.exitCode !== 0) {
      throw new Error(`Unpacking ${archive} failed: ${untar.stderr.toString()}`);
    }
    const binary = join(folder, release.binary);
    if (!(await Bun.file(binary).exists())) {
      throw new Error(`${release.binary} isn't in ${asset.url}.`);
    }
    await chmod(binary, 0o755);
    if (!linked.has(release.tool)) {
      linked.add(release.tool);
      const bin = join(dest, "bin");
      await mkdir(bin, { recursive: true });
      await rm(join(bin, release.binary), { force: true });
      await symlink(relative(bin, binary), join(bin, release.binary));
    }
    console.error(`installed ${release.tool} ${release.version} (${arch})`);
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
