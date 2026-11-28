/**
 * How a repository runs, decided from its file list and small manifest files read through the
 * provider's API (spec 19.7 step 6), and the variable names its example env files and env schema
 * files mention. Pure functions: the reads happen in the import flow.
 */

import { parseEnv } from "@nearzero/shared";

export interface InspectedFile {
  path: string;
  type: "file" | "folder";
}

export interface Manifest {
  path: string;
  content: string;
}

export type RunOption =
  | { kind: "compose"; path: string }
  | { kind: "dockerfile"; folder: string; dockerfile: string }
  | { kind: "automatic"; folder: string; manifest: string }
  | { kind: "static"; folder: string };

const DOCKERFILES = ["Dockerfile", "dockerfile", "Containerfile"];
const COMPOSE_FILES = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];
const LANGUAGE_MANIFESTS = [
  "package.json",
  "requirements.txt",
  "pyproject.toml",
  "Pipfile",
  "go.mod",
  "Cargo.toml",
  "Gemfile",
  "composer.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "mix.exs",
  "deno.json",
];
const SKIPPED =
  /(^|\/)(node_modules|vendor|\.git|dist|build|\.next|target|examples?|docs?|tests?|__tests__)(\/|$)/;

function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

function folderOf(path: string): string {
  const parts = path.split("/");
  parts.pop();
  return parts.join("/");
}

function parseJson(text: string | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function scripts(json: Record<string, unknown> | null): Record<string, unknown> {
  const value = json?.scripts;
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** A package.json that starts something: a start script (or serve, for static servers). */
function startsSomething(content: string | undefined): boolean {
  if (content === undefined) return true;
  const run = scripts(parseJson(content));
  return typeof run.start === "string" || typeof run.serve === "string";
}

/** "the description per option" of spec 19.7 step 6. */
export function describeOption(option: RunOption): string {
  switch (option.kind) {
    case "compose":
      return "Every service in the compose file";
    case "dockerfile":
      return "Build this Dockerfile as one app";
    case "static":
      return "Serve the files as a static site";
    default:
      return "Nearzero detects the language and builds it";
  }
}

export function optionLabel(option: RunOption): string {
  const at = (folder: string) => (folder === "" ? "" : `${folder}: `);
  switch (option.kind) {
    case "compose":
      return `Compose file (${option.path})`;
    case "dockerfile":
      return `${at(option.folder)}${option.dockerfile}`;
    case "static":
      return `${at(option.folder)}Static site`;
    default:
      return `${at(option.folder)}${option.manifest}`;
  }
}

export function optionValue(option: RunOption): string {
  return option.kind === "compose" ? `compose:${option.path}` : `${option.kind}:${option.folder}`;
}

/**
 * The ways a repository can run (spec 19.7 step 6): a root Dockerfile (with a Compose file too,
 * both, for the person to choose); a Compose file alone; a root language manifest; otherwise
 * each runnable folder of a monorepo (Dockerfile folders first; JavaScript packages only if they
 * start something); otherwise a JavaScript workspace root or a root index.html, used directly.
 * Empty when nothing fits.
 */
export function runOptions(
  files: readonly InspectedFile[],
  manifests: readonly Manifest[],
): RunOption[] {
  const content = new Map(manifests.map((manifest) => [manifest.path, manifest.content]));
  const rootFiles = new Set(
    files
      .filter((file) => file.type === "file" && !file.path.includes("/"))
      .map((file) => file.path),
  );
  const rootDockerfile = DOCKERFILES.find((name) => rootFiles.has(name));
  const rootCompose = COMPOSE_FILES.find((name) => rootFiles.has(name));
  const options: RunOption[] = [];
  if (rootCompose) options.push({ kind: "compose", path: rootCompose });
  if (rootDockerfile) options.push({ kind: "dockerfile", folder: "", dockerfile: rootDockerfile });
  if (options.length > 0) return options;

  const rootPackage = parseJson(content.get("package.json"));
  const workspaceRoot =
    rootFiles.has("pnpm-workspace.yaml") ||
    (rootPackage !== null && rootPackage.workspaces !== undefined);
  const rootManifest = LANGUAGE_MANIFESTS.find((name) => rootFiles.has(name));
  if (rootManifest && !workspaceRoot)
    return [{ kind: "automatic", folder: "", manifest: rootManifest }];

  // A monorepo: each folder that runs on its own.
  const folders = new Map<string, RunOption>();
  for (const file of files) {
    if (file.type !== "file" || !file.path.includes("/") || SKIPPED.test(file.path)) continue;
    const name = baseName(file.path);
    const folder = folderOf(file.path);
    if (DOCKERFILES.includes(name)) {
      folders.set(folder, { kind: "dockerfile", folder, dockerfile: name });
    } else if (LANGUAGE_MANIFESTS.includes(name) && !folders.has(folder)) {
      if (name === "package.json" && !startsSomething(content.get(file.path))) continue;
      folders.set(folder, { kind: "automatic", folder, manifest: name });
    }
  }
  const monorepo = [...folders.values()].sort(
    (a, b) =>
      Number(b.kind === "dockerfile") - Number(a.kind === "dockerfile") ||
      ("folder" in a ? a.folder : "").localeCompare("folder" in b ? b.folder : ""),
  );
  if (monorepo.length > 0) return monorepo;

  if (rootManifest) return [{ kind: "automatic", folder: "", manifest: rootManifest }];
  if (rootFiles.has("index.html")) return [{ kind: "static", folder: "" }];
  return [];
}

// ---- Variable names

const EXAMPLE_ENV =
  /^(?:\.env\.(?:[\w-]+\.)?(?:example|sample|template|dist|defaults)|(?:example|sample)\.env|env\.example)$/i;
const ENV_SCHEMA =
  /(?:^|\/)(?:env|environment|config|settings)\.(?:ts|mts|cts|js|mjs|cjs|py)$|(?:^|\/)env\/(?:index|server|client)\.(?:ts|js|mjs)$/i;
const IGNORED = new Set(["PORT", "NODE_ENV", "PATH", "HOME", "HOSTNAME", "PWD", "CI", "TZ"]);

export function isExampleEnvFile(path: string): boolean {
  return EXAMPLE_ENV.test(baseName(path));
}

export function isEnvSchemaFile(path: string): boolean {
  return ENV_SCHEMA.test(path) && !SKIPPED.test(path);
}

/**
 * Names assigned in an example env file, read with the variables editor's own parser in its
 * tolerant mode (`export` prefixes, comments after quoted values and values over several lines
 * are read; lines that still aren't NAME=value are skipped). Values are never kept.
 */
export function namesFromExample(text: string): string[] {
  return parseEnv(text, { tolerant: true }).variables.map((variable) => variable.name);
}

const SCHEMA_READS = [
  /process\.env\.([A-Z][A-Z0-9_]+)/g,
  /process\.env\[\s*["'`]([A-Z][A-Z0-9_]+)["'`]\s*\]/g,
  /import\.meta\.env\.([A-Z][A-Z0-9_]+)/g,
  /Deno\.env\.get\(\s*["'`]([A-Z][A-Z0-9_]+)["'`]/g,
  /os\.environ(?:\.get)?\(?\[?\s*["']([A-Z][A-Z0-9_]+)["']/g,
  /os\.getenv\(\s*["']([A-Z][A-Z0-9_]+)["']/g,
  /\benv(?:\.\w+)?\(\s*["']([A-Z][A-Z0-9_]+)["']/g,
  /^\s*([A-Z][A-Z0-9_]{2,})\s*:\s*z\./gm,
];

/** Names a schema or config file reads from the environment. */
export function namesFromSchema(text: string): string[] {
  const names: string[] = [];
  for (const pattern of SCHEMA_READS) {
    for (const match of text.matchAll(pattern)) if (match[1]) names.push(match[1]);
  }
  return names;
}

/** The names to ask for, in the order found, without ones Nearzero or the system sets. */
export function variableNames(sources: readonly string[][], limit = 50): string[] {
  const out: string[] = [];
  for (const list of sources) {
    for (const name of list) {
      if (IGNORED.has(name) || out.includes(name)) continue;
      out.push(name);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** Whether a file belongs to the chosen folder (or the root) of a monorepo. */
export function inScope(path: string, folder: string): boolean {
  const at = folderOf(path);
  return at === "" || folder === "" || at === folder || at.startsWith(`${folder}/`);
}
