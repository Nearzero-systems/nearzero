import { lstat, readdir, readlink, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, posix, relative, sep } from "node:path";

/**
 * Symbolic links in a service's source (spec 6.3, 22.2, 24 G3). A repository or an upload may
 * hold links, and the runner runs as root, so a link that leads out of the source folder must
 * never be followed: not by the runner when it reads or writes build files, and not by builders.
 *
 * Where a link leads is worked out the way the kernel does it, one part at a time, following
 * every link on the way (also links to links, and `..` after a link), so a chain like
 * `l1 -> .`, `l2 -> l1/..` is seen for what it is. A link whose end can't be told for sure (a
 * missing part followed by `..`, or too many links) counts as leading outside.
 */

const MAX_LINKS = 40;

export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/**
 * The absolute path `path` really names, following links, or null when it can't be told.
 * Parts that don't exist are kept as written; a `..` after a missing part can't be resolved.
 */
export async function resolvePath(path: string): Promise<string | null> {
  // Not normalized first: `a/..` after a link `a` leads to the link's target's parent.
  let pending = path.split("/").filter(Boolean);
  let current = "/";
  let followed = 0;
  let missing = false;
  while (pending.length > 0) {
    const part = pending.shift() as string;
    if (part === ".") continue;
    if (part === "..") {
      if (missing) return null;
      current = posix.dirname(current);
      continue;
    }
    const next = posix.join(current, part);
    if (missing) {
      current = next;
      continue;
    }
    const info = await lstat(next).catch(() => null);
    if (!info) {
      missing = true;
      current = next;
      continue;
    }
    if (info.isSymbolicLink()) {
      followed++;
      if (followed > MAX_LINKS) return null;
      const target = await readlink(next).catch(() => null);
      if (target === null) return null;
      const rest = pending;
      pending = [...target.split("/").filter(Boolean), ...rest];
      if (target.startsWith("/")) current = "/";
      continue;
    }
    current = next;
  }
  return current;
}

/** Whether the link at `path` leads somewhere inside `root` (both absolute; root real). */
export async function linkStaysInside(root: string, path: string): Promise<boolean> {
  const destination = await resolvePath(path);
  return destination !== null && isInside(root, destination);
}

/**
 * Removes every link under `root` that leads outside it (or whose end can't be told), and
 * answers their paths relative to `root`. Repeats until nothing changes, since removing one
 * link can change where another leads.
 */
export async function dropOutsideLinks(folder: string): Promise<string[]> {
  const root = await realpath(folder);
  const removed: string[] = [];
  for (;;) {
    let changed = false;
    const links: string[] = [];
    const walk = async (dir: string) => {
      const entries = await readdir(join(root, dir), { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) links.push(rel);
        else if (entry.isDirectory()) await walk(rel);
      }
    };
    await walk("");
    for (const rel of links) {
      if (await linkStaysInside(root, join(root, rel))) continue;
      await unlink(join(root, rel)).catch(() => {});
      removed.push(rel);
      changed = true;
    }
    if (!changed) return removed;
  }
}
