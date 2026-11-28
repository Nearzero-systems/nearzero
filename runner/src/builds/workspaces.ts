import { readdir, readFile, stat } from "node:fs/promises";
import { join, posix } from "node:path";

/**
 * Monorepo apps (spec 6.1, 6.4, 30b R2-04). When the picked app folder depends on other packages
 * of the same repository (npm, pnpm, Yarn or Bun workspaces, `workspace:` links), building the
 * folder alone fails: its siblings aren't in the build. The automatic builder then builds from
 * the repository root with Nixpacks, installs once there, builds the packages the app depends on
 * first (through Turborepo when the repository uses it), and starts the app from its own folder.
 */

export type PackageManager = "pnpm" | "yarn" | "bun" | "npm";

export interface WorkspacePlan {
  packageManager: PackageManager;
  /** The app's package name and folder (the build path). */
  name: string;
  folder: string;
  /** Folders of the workspace packages it depends on, directly or not, dependencies first. */
  dependencies: string[];
  turbo: boolean;
  commands: { install: string; build: string; start: string };
}

interface PackageInfo {
  name: string;
  folder: string;
  dependencies: Record<string, string>;
  scripts: Record<string, string>;
  main: string | null;
}

/** Folder names a generated command may contain (they go into a shell command). */
const SAFE_FOLDER = /^[A-Za-z0-9._@/-]+$/;
const MAX_DEPTH = 5;

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  const text = await readFile(path, "utf8").catch(() => null);
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path)
    .then(() => true)
    .catch(() => false);
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringMap(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

/** The `packages:` list of a pnpm-workspace.yaml (the only part read). */
export function pnpmWorkspacePatterns(text: string): string[] {
  const patterns: string[] = [];
  let inPackages = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "");
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      const inline = /\[(.*)\]/.exec(line)?.[1];
      if (inline !== undefined) {
        for (const item of inline.split(",")) {
          const value = item.trim().replace(/^["']|["']$/g, "");
          if (value) patterns.push(value);
        }
        inPackages = false;
      }
      continue;
    }
    if (!inPackages) continue;
    const item = /^\s+-\s*(.+)$/.exec(line);
    if (item) {
      patterns.push((item[1] as string).trim().replace(/^["']|["']$/g, ""));
    } else if (/^\S/.test(line)) {
      inPackages = false;
    }
  }
  return patterns;
}

/** Folders under `root` (relative) that a workspace pattern like "apps/*" or "packages/**" names. */
async function expand(root: string, pattern: string): Promise<string[]> {
  const parts = posix
    .normalize(pattern.replace(/^\.\//, "").replace(/\/+$/, ""))
    .split("/")
    .filter(Boolean);
  if (parts.includes("..")) return [];
  const found: string[] = [];
  const walk = async (folder: string, index: number, depth: number) => {
    if (depth > MAX_DEPTH) return;
    if (index === parts.length) {
      found.push(folder);
      return;
    }
    const part = parts[index] as string;
    if (!part.includes("*")) {
      const next = folder ? `${folder}/${part}` : part;
      if (await exists(join(root, next))) await walk(next, index + 1, depth + 1);
      return;
    }
    const entries = await readdir(join(root, folder), { withFileTypes: true }).catch(() => []);
    const matcher = new RegExp(
      `^${part
        .split("*")
        .map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*")}$`,
    );
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) {
        continue;
      }
      const next = folder ? `${folder}/${entry.name}` : entry.name;
      if (part === "**") {
        await walk(next, index + 1, depth + 1);
        await walk(next, index, depth + 1);
      } else if (matcher.test(entry.name)) {
        await walk(next, index + 1, depth + 1);
      }
    }
    if (part === "**") await walk(folder, index + 1, depth);
  };
  await walk("", 0, 0);
  return found;
}

async function packageAt(root: string, folder: string): Promise<PackageInfo | null> {
  const json = await readJson(join(root, folder, "package.json"));
  if (!json || typeof json.name !== "string") return null;
  return {
    name: json.name,
    folder,
    dependencies: {
      ...stringMap(json.devDependencies),
      ...stringMap(json.dependencies),
      ...stringMap(json.optionalDependencies),
    },
    scripts: stringMap(json.scripts),
    main: typeof json.main === "string" ? json.main : null,
  };
}

async function packageManagerOf(
  root: string,
  rootJson: Record<string, unknown>,
): Promise<{ manager: PackageManager; locked: boolean }> {
  const declared =
    typeof rootJson.packageManager === "string" ? rootJson.packageManager.split("@")[0] : "";
  if (declared === "pnpm" || (await exists(join(root, "pnpm-lock.yaml")))) {
    return { manager: "pnpm", locked: await exists(join(root, "pnpm-lock.yaml")) };
  }
  if (
    declared === "bun" ||
    (await exists(join(root, "bun.lock"))) ||
    (await exists(join(root, "bun.lockb")))
  ) {
    return { manager: "bun", locked: true };
  }
  if (declared === "yarn" || (await exists(join(root, "yarn.lock")))) {
    return { manager: "yarn", locked: await exists(join(root, "yarn.lock")) };
  }
  if (await exists(join(root, "pnpm-workspace.yaml"))) return { manager: "pnpm", locked: false };
  return { manager: "npm", locked: await exists(join(root, "package-lock.json")) };
}

const RUN: Record<PackageManager, string> = {
  pnpm: "pnpm run",
  yarn: "yarn run",
  bun: "bun run",
  npm: "npm run",
};

const EXEC: Record<PackageManager, string> = {
  pnpm: "pnpm exec",
  yarn: "yarn",
  bun: "bunx",
  npm: "npx",
};

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The plan for building `buildPath` from the repository root, or null when it doesn't depend on
 * other packages of the repository (or isn't a package at all).
 */
export async function workspacePlan(
  sourceRoot: string,
  buildPath: string,
): Promise<WorkspacePlan | null> {
  const folder = posix.normalize(buildPath).replace(/^\.\/?|\/$/g, "");
  if (folder === "" || folder === "." || !SAFE_FOLDER.test(folder)) return null;
  const app = await packageAt(sourceRoot, folder);
  if (!app) return null;
  const rootJson = (await readJson(join(sourceRoot, "package.json"))) ?? {};
  const workspaces = rootJson.workspaces;
  const patterns = [
    ...strings(workspaces),
    ...(typeof workspaces === "object" && workspaces !== null && !Array.isArray(workspaces)
      ? strings((workspaces as Record<string, unknown>).packages)
      : []),
    ...pnpmWorkspacePatterns(
      (await readFile(join(sourceRoot, "pnpm-workspace.yaml"), "utf8").catch(() => "")) ?? "",
    ),
  ].filter((pattern) => !pattern.startsWith("!"));
  if (patterns.length === 0) return null;
  const byName = new Map<string, PackageInfo>();
  for (const pattern of patterns) {
    for (const found of await expand(sourceRoot, pattern)) {
      if (!SAFE_FOLDER.test(found)) continue;
      const info = found === folder ? app : await packageAt(sourceRoot, found);
      if (info && !byName.has(info.name)) byName.set(info.name, info);
    }
  }
  const workspaceDependencies = (info: PackageInfo) =>
    Object.entries(info.dependencies)
      .filter(([name, version]) => version.startsWith("workspace:") || byName.has(name))
      .map(([name]) => byName.get(name))
      .filter((item): item is PackageInfo => item !== undefined && item.name !== info.name);
  const direct = workspaceDependencies(app);
  if (direct.length === 0) return null;
  // Every package the app needs, dependencies first.
  const ordered: PackageInfo[] = [];
  const done = new Set<string>([app.name]);
  const visit = (info: PackageInfo, trail: Set<string>) => {
    if (done.has(info.name) || trail.has(info.name)) return;
    trail.add(info.name);
    for (const dependency of workspaceDependencies(info)) visit(dependency, trail);
    trail.delete(info.name);
    done.add(info.name);
    ordered.push(info);
  };
  for (const dependency of direct) visit(dependency, new Set());
  const { manager, locked } = await packageManagerOf(sourceRoot, rootJson);
  const turbo = await exists(join(sourceRoot, "turbo.json"));
  const install =
    manager === "pnpm"
      ? locked
        ? "pnpm install --frozen-lockfile"
        : "pnpm install"
      : manager === "yarn"
        ? "yarn install"
        : manager === "bun"
          ? "bun install"
          : locked
            ? "npm ci"
            : "npm install";
  const steps = [...ordered, app].filter((info) => info.scripts.build !== undefined);
  const build = turbo
    ? `${EXEC[manager]} turbo run build --filter=${quote(`${app.name}...`)}`
    : steps.length > 0
      ? steps.map((info) => `(cd ${quote(info.folder)} && ${RUN[manager]} build)`).join(" && ")
      : "true";
  const start =
    app.scripts.start !== undefined
      ? `cd ${quote(folder)} && ${RUN[manager]} start`
      : app.main
        ? `cd ${quote(folder)} && node ${quote(app.main)}`
        : "";
  return {
    packageManager: manager,
    name: app.name,
    folder,
    dependencies: ordered.map((info) => info.folder),
    turbo,
    commands: { install, build, start },
  };
}
