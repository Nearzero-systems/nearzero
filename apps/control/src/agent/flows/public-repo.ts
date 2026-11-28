import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FILE_LIST_CAP,
  FILE_READ_MAX_BYTES,
  INSPECT_DEPTH,
  INSPECT_MANIFEST_CAP,
} from "@nearzero/shared";
import type { TreeEntry } from "../../git-providers/client.ts";
import { pickManifests } from "../../git-providers/reads.ts";
import type { HttpFetch } from "../../services.ts";
import { isEnvSchemaFile, isExampleEnvFile } from "./inspect.ts";

/**
 * Reading a public repository without any stored login (30d R4-01): whether anyone may read it
 * and which branches it has, from Git's smart HTTP ref advertisement, and how it runs, from a
 * clone without file contents (only the few manifest files are fetched). Only the four public
 * hosts a pasted link can name are ever asked, over HTTPS.
 */

export const PUBLIC_GIT_HOSTS = [
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "codeberg.org",
] as const;
export type PublicGitHost = (typeof PUBLIC_GIT_HOSTS)[number];

export const HOST_LABELS: Record<PublicGitHost, string> = {
  "github.com": "GitHub",
  "gitlab.com": "GitLab",
  "bitbucket.org": "Bitbucket",
  "codeberg.org": "Codeberg",
};

export type PublicRefs =
  | { kind: "public"; defaultBranch: string | null; branches: string[] }
  /** The host asked for a login: private, or missing (hosts answer both the same way). */
  | { kind: "private" }
  | { kind: "unreachable"; reason: string };

export interface PublicInspection {
  files: TreeEntry[];
  manifests: { path: string; content: string }[];
}

export interface PublicRepositoryReader {
  refs(url: string): Promise<PublicRefs>;
  inspect(url: string, branch: string): Promise<PublicInspection>;
}

export function publicCloneUrl(host: PublicGitHost, fullName: string): string {
  return `https://${host}/${fullName}.git`;
}

/** The refs of a ref advertisement (pkt-lines: four hex digits of length, then the line). */
export function advertisedRefs(body: Uint8Array): {
  defaultBranch: string | null;
  branches: string[];
} {
  const text = Buffer.from(body).toString("latin1");
  const branches: string[] = [];
  let defaultBranch: string | null = null;
  let headSha: string | null = null;
  const shas = new Map<string, string>();
  let at = 0;
  while (at + 4 <= text.length) {
    const length = Number.parseInt(text.slice(at, at + 4), 16);
    if (Number.isNaN(length)) break;
    if (length === 0) {
      at += 4;
      continue;
    }
    if (length < 4 || at + length > text.length) break;
    const line = text.slice(at + 4, at + length).replace(/\n$/, "");
    at += length;
    if (line.startsWith("#")) continue;
    const [head = "", capabilities = ""] = line.split("\0");
    const match = /^([0-9a-f]{40}|[0-9a-f]{64}) (\S+)$/.exec(head);
    if (!match) continue;
    const [, sha = "", name = ""] = match;
    const symref = /(?:^| )symref=HEAD:refs\/heads\/(\S+)/.exec(capabilities);
    if (symref?.[1]) defaultBranch = symref[1];
    if (name === "HEAD") headSha = sha;
    if (name.startsWith("refs/heads/")) {
      const branch = name.slice("refs/heads/".length);
      branches.push(branch);
      shas.set(branch, sha);
    }
  }
  if (!defaultBranch && headSha) {
    defaultBranch = branches.find((branch) => shas.get(branch) === headSha) ?? null;
  }
  return { defaultBranch, branches };
}

const REFS_TIMEOUT_MS = 10_000;
const REFS_MAX_BYTES = 4 * 1024 * 1024;

async function readCapped(response: Response, max: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** Asks the host over Git's smart HTTP, with no login, whether anyone may read the repository. */
export async function publicRefs(http: HttpFetch, url: string): Promise<PublicRefs> {
  const target = `${url.replace(/\/+$/, "")}/info/refs?service=git-upload-pack`;
  const host = new URL(url).hostname;
  if (!(PUBLIC_GIT_HOSTS as readonly string[]).includes(host)) {
    return { kind: "unreachable", reason: "That host isn't one Nearzero checks links on." };
  }
  let response: Response;
  try {
    response = await http(target, {
      method: "GET",
      // A redirect could lead anywhere; the four hosts answer the address directly.
      redirect: "manual",
      headers: { "user-agent": "git/2.47.0 (nearzero)", accept: "*/*" },
      signal: AbortSignal.timeout(REFS_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = (error as Error).name === "TimeoutError";
    return {
      kind: "unreachable",
      reason: timedOut ? "it didn't answer within 10 seconds." : "the connection failed.",
    };
  }
  const type = response.headers.get("content-type") ?? "";
  if (response.ok && type.includes("application/x-git-upload-pack-advertisement")) {
    return { kind: "public", ...advertisedRefs(await readCapped(response, REFS_MAX_BYTES)) };
  }
  await response.body?.cancel().catch(() => {});
  // 401 or 403 asks for a login; 404 and the hosts' sign-in redirects say the same thing.
  if ([301, 302, 303, 307, 308, 401, 403, 404].includes(response.status))
    return { kind: "private" };
  return { kind: "unreachable", reason: `it answered with HTTP ${response.status}.` };
}

const GIT_TIMEOUT_MS = 90_000;

async function git(args: string[], cwd: string, env: Record<string, string>): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), GIT_TIMEOUT_MS);
  try {
    const [out, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const code = await child.exited;
    if (code !== 0) throw new Error(err.trim().split("\n").at(-1) || `git exited with ${code}`);
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A clone without file contents (`--filter=blob:none --no-checkout`, one commit deep): the file
 * list, three folders deep like the provider inspection, and the manifests it would read, each
 * fetched alone and capped. No stored login, prompt or credential helper is ever used.
 */
export async function inspectByClone(url: string, branch: string): Promise<PublicInspection> {
  const dir = await mkdtemp(join(tmpdir(), "nearzero-inspect-"));
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: dir,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
  };
  const quiet = [
    "-c",
    "credential.helper=",
    "-c",
    "protocol.allow=never",
    "-c",
    "protocol.https.allow=always",
  ];
  try {
    await git(
      [
        ...quiet,
        "clone",
        "--quiet",
        "--filter=blob:none",
        "--no-checkout",
        "--depth=1",
        "--single-branch",
        "--branch",
        branch,
        "--",
        url,
        "repo",
      ],
      dir,
      env,
    );
    const repo = join(dir, "repo");
    const listing = await git([...quiet, "ls-tree", "-r", "-t", "-z", "HEAD"], repo, env);
    const files: TreeEntry[] = [];
    for (const entry of listing.split("\0")) {
      const match = /^\d+ (blob|tree) [0-9a-f]+\t(.+)$/s.exec(entry);
      if (!match) continue;
      const [, type = "", path = ""] = match;
      if (path.split("/").length > INSPECT_DEPTH) continue;
      files.push({ path, type: type === "tree" ? "folder" : "file", size: null });
      if (files.length >= FILE_LIST_CAP) break;
    }
    const manifests: { path: string; content: string }[] = [];
    // The manifests, then the example variable files the variables step reads.
    const examples = files
      .filter((file) => file.type === "file")
      .map((file) => file.path)
      .filter((path) => isExampleEnvFile(path) || isEnvSchemaFile(path))
      .slice(0, 6);
    const wanted = [...new Set([...pickManifests(files, INSPECT_MANIFEST_CAP), ...examples])];
    for (const path of wanted) {
      try {
        const content = await git([...quiet, "show", `HEAD:${path}`], repo, env);
        if (content.length <= FILE_READ_MAX_BYTES && !content.includes("\0")) {
          manifests.push({ path, content });
        }
      } catch {
        // A file that can't be read is left out; the rest still tell how it runs.
      }
    }
    return { files, manifests };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export function defaultPublicReader(http: HttpFetch): PublicRepositoryReader {
  return {
    refs: (url) => publicRefs(http, url),
    inspect: (url, branch) => inspectByClone(url, branch),
  };
}
