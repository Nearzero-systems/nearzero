import { createHash } from "node:crypto";
import { posix } from "node:path";
import { DEFAULT_COMPOSE_PATH, GIT_PROVIDER_LABELS, type GitProviderKind } from "@nearzero/shared";
import { readSource } from "../service-runtime/app-settings.ts";
import { isObject } from "./model.ts";

/**
 * Where a Compose service's file comes from (spec 07 7.1, 7.2): pasted YAML saved on the service
 * (`{ type: "raw", composeFile }`), a repository through a connected Git provider (the Git
 * milestone's `{ type: "provider", …, composePath }`), or a plain Git URL (`{ type: "git", url,
 * branch, composePath }`, which the Agent and the test suites use).
 */

export type ComposeSource =
  | { type: "raw"; composeFile: string }
  | {
      type: "provider";
      providerId: string | null;
      provider: GitProviderKind;
      repository: string;
      branch: string;
      composePath: string;
      submodules: boolean;
    }
  | {
      type: "git";
      url: string;
      branch: string;
      composePath: string;
      sshKeyId: string | null;
      submodules: boolean;
    };

/** A repository's Compose file path without its leading ./ (default ./docker-compose.yml). */
export function cleanComposePath(path: string | null | undefined): string {
  const value = (path ?? "").trim().replace(/^(\.\/)+/, "");
  return value === "" ? DEFAULT_COMPOSE_PATH.replace(/^\.\//, "") : value;
}

export function composeSourceOf(settings: Record<string, unknown> | null): ComposeSource | null {
  const value = settings?.source;
  if (!isObject(value)) return null;
  if (value.type === "raw") {
    return typeof value.composeFile === "string" && value.composeFile.trim() !== ""
      ? { type: "raw", composeFile: value.composeFile }
      : null;
  }
  const read = readSource(value);
  if (read?.type === "provider") {
    return {
      type: "provider",
      providerId: read.providerId,
      provider: read.provider,
      repository: read.repository,
      branch: read.branch,
      composePath: cleanComposePath(read.composePath),
      submodules: read.submodules,
    };
  }
  if (read?.type === "git") {
    return {
      type: "git",
      url: read.url,
      branch: read.branch,
      composePath: cleanComposePath(
        typeof value.composePath === "string" ? value.composePath : null,
      ),
      sshKeyId: read.sshKeyId,
      submodules: read.submodules,
    };
  }
  return null;
}

/**
 * Where the file comes from, for host approvals (privileged.ts): the same Compose file from
 * another repository, branch or path builds other code, so it is another definition.
 */
export function sourceOrigin(source: ComposeSource): string {
  if (source.type === "raw") return "raw";
  if (source.type === "provider") {
    return `provider:${source.providerId ?? ""}:${source.repository}#${source.branch}:${source.composePath}`;
  }
  return `git:${source.url}#${source.branch}:${source.composePath}`;
}

/** The project directory inside the stack's folder, and how far relative paths may reach. */
export function folderOf(source: ComposeSource): { projectDirectory: string; root: string } {
  if (source.type === "raw") return { projectDirectory: "", root: "" };
  const folder = posix.dirname(source.composePath);
  return { projectDirectory: folder === "." ? "repo" : `repo/${folder}`, root: "repo" };
}

/** What the stack is made from, for "saved changes need a deploy". */
export function sourceFingerprint(source: ComposeSource): string {
  const text =
    source.type === "raw"
      ? `raw\n${source.composeFile}`
      : source.type === "provider"
        ? `provider\n${source.providerId}\n${source.repository}\n${source.branch}\n${source.composePath}`
        : `git\n${source.url}\n${source.branch}\n${source.composePath}`;
  return createHash("sha256").update(text).digest("hex");
}

/** The source as a deployment shows it (no tokens, no file contents). */
export function describeComposeSource(source: ComposeSource): Record<string, unknown> {
  if (source.type === "raw") {
    return { provider: "Compose file", repository: null, branch: null, path: null };
  }
  if (source.type === "provider") {
    return {
      type: "git",
      provider: GIT_PROVIDER_LABELS[source.provider],
      repository: source.repository,
      branch: source.branch,
      path: `./${source.composePath}`,
    };
  }
  const host = /^(?:https?:\/\/|ssh:\/\/)?(?:[^@/]+@)?([^:/]+)/.exec(source.url)?.[1] ?? null;
  return {
    type: "git",
    provider: host,
    repository: source.url,
    branch: source.branch,
    path: `./${source.composePath}`,
  };
}

/** One line for the page: "Pasted YAML" or "GitHub · owner/repo · main · ./compose.yml". */
export function sourceLabel(source: ComposeSource | null): string {
  if (!source) return "No Compose file yet";
  if (source.type === "raw") return "Compose file (YAML)";
  const where =
    source.type === "provider"
      ? `${GIT_PROVIDER_LABELS[source.provider]} · ${source.repository}`
      : source.url;
  return `${where} · ${source.branch} · ./${source.composePath}`;
}
