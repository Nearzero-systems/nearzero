import {
  AppError,
  BRANCH_LIST_CAP,
  FILE_LIST_CAP,
  FILE_READ_MAX_BYTES,
  GIT_PROVIDER_LABELS,
  type GitProviderKind,
  INSPECT_DEPTH,
  INSPECT_MANIFEST_CAP,
  REPOSITORY_LIST_CAP,
  repositoryNameProblem,
} from "@nearzero/shared";
import type { WorkspaceActor } from "../http/actor.ts";
import type { ControlServices } from "../services.ts";
import {
  type BranchSummary,
  REPOSITORY_SCOPE_MAX,
  type RepositoryScope,
  type RepositorySummary,
  searchScope,
  type TreeEntry,
} from "./client.ts";
import { withProvider } from "./clients.ts";
import { ownerNames, type ProviderRow, providerView, usableProvider } from "./records.ts";

/**
 * What the console and the Agent read through a provider without cloning (spec 16, 19.7 steps
 * 1–3 and 6): the providers a person may use, a provider's repositories (searchable, at most 200),
 * a repository's branches (the default first, at most 200), a branch's file list and the content
 * of small text files, and an inspection bundle (the list three folders deep plus up to twelve
 * manifest files). Every read checks the person may use the provider first.
 */

export interface UsableProvider {
  id: string;
  kind: GitProviderKind;
  kindLabel: string;
  name: string;
  account: string | null;
  ready: boolean;
  mine: boolean;
  shared: boolean;
}

/** The providers this person may use, ready ones first (spec 19.7 step 1, 6.1 Provider step). */
export async function usableProviders(
  services: ControlServices,
  actor: WorkspaceActor,
  kind?: GitProviderKind,
): Promise<UsableProvider[]> {
  let query = services.db
    .selectFrom("git_provider")
    .selectAll()
    .where("workspace_id", "=", actor.workspace.id);
  if (kind) query = query.where("kind", "=", kind);
  const rows = await query.orderBy("created_at").execute();
  const targets = rows.map((row) => ({
    row,
    kind: "git_account" as const,
    id: row.id,
    ...(row.owner_person_id ? { ownerPersonId: row.owner_person_id } : {}),
    sharedWithWorkspace: row.shared,
  }));
  return actor.access
    .visible(targets)
    .map(({ row }) => ({
      id: row.id,
      kind: row.kind as GitProviderKind,
      kindLabel: GIT_PROVIDER_LABELS[row.kind as GitProviderKind],
      name: row.name,
      account: row.account_login,
      ready: row.status === "ready",
      mine: row.owner_person_id === actor.personId,
      shared: row.shared,
    }))
    .sort((a, b) => Number(b.ready) - Number(a.ready));
}

/** Every provider the person sees, as the settings page lists them. */
export async function listProviderViews(services: ControlServices, actor: WorkspaceActor) {
  const rows = await services.db
    .selectFrom("git_provider")
    .selectAll()
    .where("workspace_id", "=", actor.workspace.id)
    .orderBy("created_at")
    .execute();
  const visible = actor.access
    .visible(
      rows.map((row) => ({
        row,
        kind: "git_account" as const,
        id: row.id,
        ...(row.owner_person_id ? { ownerPersonId: row.owner_person_id } : {}),
        sharedWithWorkspace: row.shared,
      })),
    )
    .map((item) => item.row);
  const names = await ownerNames(services.db, visible);
  return visible.map((row) =>
    providerView(
      services,
      actor,
      row,
      row.owner_person_id
        ? { id: row.owner_person_id, name: names.get(row.owner_person_id) ?? "Someone" }
        : null,
    ),
  );
}

export const NOT_READY =
  "This Git provider isn't connected yet. Finish connecting it in Settings → Git providers.";

async function readyProvider(
  services: ControlServices,
  actor: WorkspaceActor,
  providerId: string,
): Promise<ProviderRow> {
  const row = await usableProvider(services, actor, providerId);
  if (row.status !== "ready") throw new AppError("conflict", NOT_READY);
  return row;
}

function checkRepositoryName(value: string): string {
  const problem = repositoryNameProblem(value);
  if (problem) throw new AppError("invalid_request", problem, { fields: { repository: problem } });
  return value.trim();
}

/**
 * What a connection sees, kept for a minute between searches (R3-43): hosts that can't search
 * (GitHub installations, Gitea) are read in full, so a person typing a search doesn't page
 * through the host on every key. Kept per saved connection and its settings, so a reconnect, a
 * new installation or an edited organization reads again.
 */
const SCOPE_FOR_MS = 60_000;
const SCOPES_KEPT = 200;
const scopes = new WeakMap<
  ControlServices,
  Map<string, { at: number; scope: Promise<RepositoryScope> }>
>();

function scopeKey(row: ProviderRow): string {
  return [
    row.id,
    row.installation_id ?? "",
    new Date(row.updated_at).toISOString(),
    JSON.stringify(row.settings ?? null),
  ].join("|");
}

async function repositoryScope(
  services: ControlServices,
  row: ProviderRow,
  read: () => Promise<RepositoryScope>,
): Promise<RepositoryScope> {
  let kept = scopes.get(services);
  if (!kept) {
    kept = new Map();
    scopes.set(services, kept);
  }
  const key = scopeKey(row);
  const now = services.now();
  const hit = kept.get(key);
  if (hit && now - hit.at < SCOPE_FOR_MS) return hit.scope;
  const scope = read();
  kept.delete(key);
  kept.set(key, { at: now, scope });
  // A failed read isn't kept: the next search asks the host again.
  scope.catch(() => {
    if (kept.get(key)?.scope === scope) kept.delete(key);
  });
  for (const old of kept.keys()) {
    if (kept.size <= SCOPES_KEPT) break;
    kept.delete(old);
  }
  return scope;
}

export async function listRepositories(
  services: ControlServices,
  actor: WorkspaceActor,
  providerId: string,
  search: string,
): Promise<{ repositories: RepositorySummary[]; truncated: boolean; cap: number }> {
  const row = await readyProvider(services, actor, providerId);
  const term = search.slice(0, 100);
  const result = await withProvider(services, row, async (client) => {
    const readAll = client.allRepositories?.bind(client);
    if (!readAll) return client.listRepositories(term, REPOSITORY_LIST_CAP);
    const scope = await repositoryScope(services, row, () => readAll(REPOSITORY_SCOPE_MAX));
    return searchScope(scope, term, REPOSITORY_LIST_CAP);
  });
  return { ...result, cap: REPOSITORY_LIST_CAP };
}

export async function getRepository(
  services: ControlServices,
  actor: WorkspaceActor,
  providerId: string,
  repository: string,
): Promise<RepositorySummary> {
  const row = await readyProvider(services, actor, providerId);
  const name = checkRepositoryName(repository);
  return withProvider(services, row, (client) => client.getRepository(name));
}

export async function listBranches(
  services: ControlServices,
  actor: WorkspaceActor,
  providerId: string,
  repository: string,
): Promise<{
  repository: RepositorySummary;
  defaultBranch: string | null;
  branches: BranchSummary[];
  truncated: boolean;
}> {
  const row = await readyProvider(services, actor, providerId);
  const name = checkRepositoryName(repository);
  return withProvider(services, row, async (client) => {
    const repo = await client.getRepository(name);
    const result = await client.listBranches(repo, BRANCH_LIST_CAP);
    return { repository: repo, defaultBranch: repo.defaultBranch, ...result };
  });
}

function refOrDefault(repo: RepositorySummary, ref: string | undefined): string {
  const value = (ref ?? "").trim();
  if (value) return value;
  if (repo.defaultBranch) return repo.defaultBranch;
  throw new AppError("conflict", "This repository is empty: it has no branch to read yet.");
}

export async function listFiles(
  services: ControlServices,
  actor: WorkspaceActor,
  providerId: string,
  input: { repository: string; ref?: string; depth?: number | null },
): Promise<{ ref: string; files: TreeEntry[]; truncated: boolean }> {
  const row = await readyProvider(services, actor, providerId);
  const name = checkRepositoryName(input.repository);
  const depth =
    input.depth === null || input.depth === undefined
      ? null
      : Math.max(0, Math.min(20, Math.floor(input.depth)));
  return withProvider(services, row, async (client) => {
    const repo = await client.getRepository(name);
    const ref = refOrDefault(repo, input.ref);
    const tree = await client.listTree(repo, ref, depth, FILE_LIST_CAP);
    return { ref, files: tree.entries, truncated: tree.truncated };
  });
}

function cleanPath(path: string): string {
  const value = path.trim().replace(/^\.?\/+/, "");
  if (
    value === "" ||
    value.length > 500 ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new AppError(
      "invalid_request",
      "Enter a file inside the repository, like package.json.",
      {
        fields: { path: "Enter a file inside the repository, like package.json." },
      },
    );
  }
  return value;
}

/** Text only: a file with NUL bytes, or not valid UTF-8, isn't read. */
function asText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export const FILE_TOO_LARGE = `This file is larger than ${FILE_READ_MAX_BYTES / 1024} KB, so it isn't read without cloning.`;

export async function readFile(
  services: ControlServices,
  actor: WorkspaceActor,
  providerId: string,
  input: { repository: string; ref?: string; path: string },
): Promise<{ ref: string; path: string; size: number; content: string }> {
  const row = await readyProvider(services, actor, providerId);
  const name = checkRepositoryName(input.repository);
  const path = cleanPath(input.path);
  return withProvider(services, row, async (client) => {
    const repo = await client.getRepository(name);
    const ref = refOrDefault(repo, input.ref);
    const file = await client.readFile(repo, ref, path, FILE_READ_MAX_BYTES);
    if (!file) throw new AppError("not_found", `There is no file ${path} on ${ref}.`);
    if (file.tooLarge) throw new AppError("payload_too_large", FILE_TOO_LARGE);
    const content = asText(file.bytes);
    if (content === null) throw new AppError("conflict", `${path} isn't a text file.`);
    return { ref, path, size: file.bytes.length, content };
  });
}

/** Files worth reading to tell how a repository runs (spec 19.7 step 6). */
const MANIFEST_NAMES = [
  "Dockerfile",
  "dockerfile",
  "Containerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
  "package.json",
  "pnpm-workspace.yaml",
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
  "bun.lockb",
  "index.html",
  ".env.example",
  ".env.sample",
  ".env.template",
  "Procfile",
];
const RUNNABLE = new Set([
  "Dockerfile",
  "dockerfile",
  "Containerfile",
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
  "index.html",
]);
const NOT_READ = new Set(["bun.lockb"]);
const SKIPPED_FOLDERS = /(^|\/)(node_modules|vendor|\.git|dist|build|\.next|target)(\/|$)/;

function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

function folderOf(path: string): string {
  const parts = path.split("/");
  parts.pop();
  return parts.join("/");
}

/** The order manifests are read in: shallow first, Dockerfiles and Compose files early. */
export function pickManifests(files: readonly TreeEntry[], cap: number): string[] {
  const rank = (path: string) => {
    const index = MANIFEST_NAMES.indexOf(baseName(path));
    return path.split("/").length * 100 + (index === -1 ? 99 : index);
  };
  return files
    .filter(
      (entry) =>
        entry.type === "file" &&
        MANIFEST_NAMES.includes(baseName(entry.path)) &&
        !NOT_READ.has(baseName(entry.path)) &&
        !SKIPPED_FOLDERS.test(entry.path) &&
        (entry.size === null || entry.size <= FILE_READ_MAX_BYTES),
    )
    .map((entry) => entry.path)
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .slice(0, cap);
}

/**
 * Folders that look runnable on their own (the Configure step's build path picker, spec 6.1):
 * folders with a Dockerfile first, then those with a language manifest; the root is "".
 */
export function appFolders(files: readonly TreeEntry[]): { path: string; dockerfile: boolean }[] {
  const byFolder = new Map<string, { dockerfile: boolean }>();
  for (const entry of files) {
    if (entry.type !== "file" || SKIPPED_FOLDERS.test(entry.path)) continue;
    const name = baseName(entry.path);
    if (!RUNNABLE.has(name)) continue;
    const folder = folderOf(entry.path);
    const found = byFolder.get(folder) ?? { dockerfile: false };
    if (name === "Dockerfile" || name === "dockerfile" || name === "Containerfile") {
      found.dockerfile = true;
    }
    byFolder.set(folder, found);
  }
  return [...byFolder.entries()]
    .map(([path, info]) => ({ path, dockerfile: info.dockerfile }))
    .sort(
      (a, b) =>
        Number(a.path !== "") - Number(b.path !== "") ||
        Number(b.dockerfile) - Number(a.dockerfile) ||
        a.path.localeCompare(b.path),
    );
}

export async function inspectRepository(
  services: ControlServices,
  actor: WorkspaceActor,
  providerId: string,
  input: { repository: string; ref?: string },
): Promise<{
  repository: RepositorySummary;
  ref: string;
  files: TreeEntry[];
  truncated: boolean;
  manifests: { path: string; content: string }[];
  skipped: { path: string; reason: string }[];
  appFolders: { path: string; dockerfile: boolean }[];
}> {
  const row = await readyProvider(services, actor, providerId);
  const name = checkRepositoryName(input.repository);
  return withProvider(services, row, async (client) => {
    const repo = await client.getRepository(name);
    const ref = refOrDefault(repo, input.ref);
    const tree = await client.listTree(repo, ref, INSPECT_DEPTH, FILE_LIST_CAP);
    const manifests: { path: string; content: string }[] = [];
    const skipped: { path: string; reason: string }[] = [];
    for (const path of pickManifests(tree.entries, INSPECT_MANIFEST_CAP)) {
      const file = await client.readFile(repo, ref, path, FILE_READ_MAX_BYTES);
      if (!file) continue;
      if (file.tooLarge) {
        skipped.push({ path, reason: FILE_TOO_LARGE });
        continue;
      }
      const content = asText(file.bytes);
      if (content === null) skipped.push({ path, reason: "Not a text file." });
      else manifests.push({ path, content });
    }
    return {
      repository: repo,
      ref,
      files: tree.entries,
      truncated: tree.truncated,
      manifests,
      skipped,
      appFolders: appFolders(tree.entries),
    };
  });
}
