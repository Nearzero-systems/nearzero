import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { isAbsolute, join, posix, relative, sep } from "node:path";
import { NEARZERO_LABELS } from "@nearzero/shared";
import type { DockerClient } from "../docker/client.ts";
import { linkStaysInside } from "../sources/links.ts";

/**
 * A Compose stack's folder on the server, `<work>/compose/<project>` (spec 07): the service's own
 * folder, where a pasted file runs and a repository is copied to. Containers may write inside it
 * through bind mounts, so every write the runner makes there first makes sure no part of the
 * path is a symbolic link (a container could plant one pointing anywhere on the server).
 */

export function stackFolder(workDirectory: string, project: string): string {
  return join(workDirectory, "compose", project);
}

/**
 * Makes each folder from `base` down to `base/relativePath` a real folder: a symbolic link or a
 * file in the way is removed first. `base` itself must exist.
 */
export async function realFolders(
  base: string,
  relativePath: string,
  mode = 0o755,
): Promise<string> {
  let current = base;
  for (const part of relativePath.split("/").filter((item) => item !== "" && item !== ".")) {
    if (part === "..") throw new Error("A path left the stack's folder.");
    current = join(current, part);
    const info = await lstat(current).catch(() => null);
    if (info?.isDirectory() && !info.isSymbolicLink()) continue;
    if (info) await rm(current, { force: true, recursive: false });
    await mkdir(current, { mode });
  }
  return current;
}

/** Writes a file inside the stack's folder, never through a link. */
export async function writeInside(
  base: string,
  relativePath: string,
  content: string,
  mode: number,
): Promise<string> {
  const folder = await realFolders(
    base,
    posix.dirname(relativePath) === "." ? "" : posix.dirname(relativePath),
  );
  const path = join(folder, posix.basename(relativePath));
  const info = await lstat(path).catch(() => null);
  if (info)
    await rm(path, { force: true, recursive: info.isDirectory() && !info.isSymbolicLink() });
  await writeFile(path, content, { mode, flag: "wx" });
  await chmod(path, mode);
  return path;
}

/**
 * Checks a bind-mount source inside the folder: no part of its path may be a symbolic link.
 * A missing path is made as a folder (as Docker would). Answers a problem, or null.
 */
export async function checkBindPath(base: string, relativePath: string): Promise<string | null> {
  let current = base;
  const parts = relativePath.split("/").filter((item) => item !== "" && item !== ".");
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index] as string;
    if (part === "..") return `./${relativePath} leaves the service's folder.`;
    current = join(current, part);
    const info = await lstat(current).catch(() => null);
    if (!info) {
      await mkdir(current, { mode: 0o755 });
      continue;
    }
    if (info.isSymbolicLink()) {
      return `The bind mount ./${relativePath} goes through a link (./${parts.slice(0, index + 1).join("/")}), which could point anywhere on the server. Remove the link, then deploy again.`;
    }
    if (!info.isDirectory() && index < parts.length - 1) {
      return `The bind mount ./${relativePath} goes through a file (./${parts.slice(0, index + 1).join("/")}).`;
    }
  }
  return null;
}

let ownMounts: { Source: string; Destination: string }[] | null = null;

/**
 * A folder of the runner as the Docker Engine sees it. On a server it is the same path; the
 * Nearzero host's runner runs in a container, where the work folder is a mounted volume.
 */
export async function engineView(
  docker: DockerClient,
  containerized: boolean,
  path: string,
): Promise<string> {
  if (!containerized) return path;
  if (!ownMounts) {
    const self = await docker.findContainer(process.env.HOSTNAME ?? hostname());
    // Not a container of this Docker Engine (a server that is itself a container, with the
    // engine beside the runner): the engine sees the runner's own paths.
    ownMounts = self
      ? self.Mounts.map(({ Source, Destination }) => ({ Source, Destination }))
      : [{ Source: "/", Destination: "/" }];
  }
  const mount = ownMounts
    .filter(
      (item) =>
        item.Destination === "/" ||
        path === item.Destination ||
        path.startsWith(`${item.Destination}/`),
    )
    .sort((a, b) => b.Destination.length - a.Destination.length)[0];
  if (!mount) {
    throw new Error(
      `The runner's work folder (${path}) isn't mounted from the server, so bind mounts in a Compose file can't be used. Mount it, or set NEARZERO_RUNNER_WORK_DIR to a mounted folder.`,
    );
  }
  if (mount.Destination === "/") return path;
  return mount.Source + path.slice(mount.Destination.length);
}

// ---- Removing a folder that containers wrote into

function denied(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "EPERM" || code === "ENOTEMPTY";
}

/**
 * Removes a folder of the runner's, even after a container took parts of it over (B2-06): a
 * Postgres bind mount makes its folder 999:999 0700, and the Nearzero host's runner is root
 * with every capability dropped, so it can't read that folder to remove it. Then a short-lived
 * container of the runner's own image, with Docker's default rights and no network, empties the
 * folder through a bind mount, and the runner removes what is left. Elsewhere the runner is root
 * with its normal rights and removes it directly.
 */
export async function removeTree(
  docker: DockerClient,
  containerized: boolean,
  path: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
    return;
  } catch (error) {
    if (!containerized || !denied(error)) throw error;
  }
  const self = await docker.findContainer(process.env.HOSTNAME ?? hostname());
  if (!self) {
    throw new Error(`${path} holds files a container made, and the runner can't remove them.`);
  }
  const source = await engineView(docker, containerized, path);
  const name = `nearzero-cleanup-${crypto.randomUUID().slice(0, 12)}`;
  const id = await docker.createContainer(name, {
    Image: self.Image,
    Entrypoint: ["rm"],
    // The mount point itself can't go from inside; its contents can, then the runner removes it.
    Cmd: ["-rf", "/target"],
    User: "0:0",
    Labels: { [NEARZERO_LABELS.managed]: "true" },
    AttachStdin: false,
    OpenStdin: false,
    Tty: false,
    NetworkDisabled: true,
    HostConfig: {
      NetworkMode: "none",
      Mounts: [{ Type: "bind", Source: source, Target: "/target" }],
    },
  });
  try {
    await docker.startContainer(id);
    await docker.waitContainer(id, "not-running", signal);
  } finally {
    await docker.removeContainer(id, { force: true }).catch(() => {});
  }
  await rm(path, { recursive: true, force: true });
}

// ---- Copying a fetched repository into the stack's folder

const MANIFEST = ".nearzero/repository-files.json";

function inside(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  return !isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`);
}

/**
 * Copies the service's fetched repository (`source`) into `<stack>/repo`, overwriting what the
 * repository has and removing files it had at the last copy but no longer has. Files the stack
 * made itself (data in bind mounts) stay. Symbolic links that point outside the repository are
 * left out and named.
 */
export async function syncRepository(
  source: string,
  stack: string,
): Promise<{ files: number; skippedLinks: string[]; skippedFiles: string[] }> {
  const target = await realFolders(stack, "repo");
  const sourceRoot = await realpath(source);
  const copied: string[] = [];
  const skippedLinks: string[] = [];
  // Files in folders a container has taken over (B2-06): the runner can't write there, and
  // what the container keeps in them is its own data.
  const skippedFiles: string[] = [];
  const walk = async (relativeDir: string) => {
    const entries = await readdir(join(sourceRoot, relativeDir), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const rel = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const from = join(sourceRoot, rel);
      if (entry.isSymbolicLink()) {
        const link = await readlink(from);
        // Followed through every other link (a chain like l1 -> ., l2 -> l1/.. leads out).
        if (link.startsWith("/") || !(await linkStaysInside(sourceRoot, from))) {
          skippedLinks.push(rel);
          continue;
        }
        await realFolders(target, relativeDir);
        const to = join(target, rel);
        const existing = await lstat(to).catch(() => null);
        if (existing)
          await rm(to, {
            force: true,
            recursive: existing.isDirectory() && !existing.isSymbolicLink(),
          });
        await symlink(link, to);
        copied.push(rel);
      } else if (entry.isDirectory()) {
        try {
          await realFolders(target, rel);
        } catch (error) {
          if (!denied(error)) throw error;
          skippedFiles.push(`${rel}/`);
          continue;
        }
        await walk(rel);
      } else if (entry.isFile()) {
        const to = join(target, rel);
        try {
          await realFolders(target, relativeDir);
          const existing = await lstat(to).catch((error) => {
            if (denied(error)) throw error;
            return null;
          });
          if (existing && (existing.isSymbolicLink() || existing.isDirectory())) {
            await rm(to, {
              force: true,
              recursive: existing.isDirectory() && !existing.isSymbolicLink(),
            });
          }
          await copyFile(from, to);
          const mode = (await lstat(from)).mode & 0o777;
          await chmod(to, mode);
        } catch (error) {
          if (!denied(error)) throw error;
          skippedFiles.push(rel);
          continue;
        }
        copied.push(rel);
      }
    }
  };
  await walk("");
  const manifestPath = join(stack, MANIFEST);
  const previous: string[] = await readFile(manifestPath, "utf8")
    .then((text) => JSON.parse(text) as string[])
    .catch(() => []);
  const now = new Set(copied);
  for (const rel of previous) {
    if (now.has(rel) || rel.split("/").includes("..")) continue;
    const path = join(target, rel);
    // Only through real folders: a link planted in a parent could point anywhere.
    let safe = true;
    let parent = target;
    for (const part of rel.split("/").slice(0, -1)) {
      parent = join(parent, part);
      const info = await lstat(parent).catch(() => null);
      if (!info?.isDirectory() || info.isSymbolicLink()) {
        safe = false;
        break;
      }
    }
    if (safe) await unlink(path).catch(() => {});
  }
  await writeInside(stack, MANIFEST, JSON.stringify(copied), 0o600);
  return { files: copied.length, skippedLinks, skippedFiles };
}

/** Reads a text file inside the stack's folder that stays inside `root` after links. */
export async function readInside(
  root: string,
  path: string,
  maxBytes: number,
): Promise<string | null> {
  const full = join(root, path);
  const real = await realpath(full).catch(() => null);
  if (!real) return null;
  const realRoot = await realpath(root);
  if (!inside(realRoot, real)) return null;
  const info = await lstat(real);
  if (!info.isFile()) return null;
  if (info.size > maxBytes) {
    throw new Error(`./${path} is larger than ${Math.round(maxBytes / 1024)} KB.`);
  }
  return readFile(real, "utf8");
}
