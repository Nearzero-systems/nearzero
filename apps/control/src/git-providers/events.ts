import type { GitProviderKind } from "@nearzero/shared";
import { type PushEvent, readPushBody } from "../webhooks/push-rules.ts";

/**
 * Push events of the four hosts read into one shape (spec 6.6): the ref, the commit it ends at,
 * the commit before it, the files it touched when the host lists them, whether it deleted the
 * ref, the head commit's subject, and the repository it was to. Bitbucket sends one change per
 * ref in a push, so a push is a list.
 */

export interface ProviderPush extends PushEvent {
  before: string | null;
  subject: string | null;
}

export interface ParsedPushes {
  /** "push" for push events; anything else is acknowledged and ignored. */
  event: "push" | "ping" | "other";
  repository: { fullName: string | null; id: string | null };
  pushes: ProviderPush[];
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function zeroless(commit: string | null): string | null {
  return commit && !/^0+$/.test(commit) ? commit : null;
}

function firstLine(message: unknown): string | null {
  return typeof message === "string" ? (message.split("\n")[0]?.trim() ?? null) || null : null;
}

/** GitHub (app webhook) and Gitea share GitHub's push payload. */
export function githubLike(body: unknown): ParsedPushes {
  const value = record(body);
  const repository = record(value.repository);
  const push = readPushBody(body);
  return {
    event: push ? "push" : "other",
    repository: {
      fullName: text(repository.full_name),
      id: repository.id === undefined ? null : String(repository.id),
    },
    pushes: push ? [{ ...push, before: zeroless(text(value.before)) }] : [],
  };
}

export function gitlab(body: unknown): ParsedPushes {
  const value = record(body);
  const project = record(value.project);
  const kind = value.object_kind;
  if (kind !== "push" && kind !== "tag_push") {
    return {
      event: "other",
      repository: { fullName: text(project.path_with_namespace), id: null },
      pushes: [],
    };
  }
  const push = readPushBody(body);
  const after = zeroless(text(value.checkout_sha) ?? text(value.after));
  const commits = Array.isArray(value.commits) ? (value.commits as unknown[]).map(record) : [];
  const head = commits.find((commit) => commit.id === after) ?? commits.at(-1);
  return {
    event: "push",
    repository: {
      fullName: text(project.path_with_namespace),
      id: project.id === undefined ? null : String(project.id),
    },
    pushes: push
      ? [
          {
            ...push,
            commit: after,
            before: zeroless(text(value.before)),
            subject: firstLine(head?.title ?? head?.message),
            message: text(head?.message) ?? text(head?.title),
          },
        ]
      : [],
  };
}

export function bitbucket(body: unknown, eventKey: string | null): ParsedPushes {
  const value = record(body);
  const repository = record(value.repository);
  const repo = { fullName: text(repository.full_name), id: text(repository.uuid) };
  if (eventKey === "diagnostics:ping") return { event: "ping", repository: repo, pushes: [] };
  if (eventKey !== "repo:push") return { event: "other", repository: repo, pushes: [] };
  const changes = Array.isArray(record(value.push).changes)
    ? (record(value.push).changes as unknown[]).map(record)
    : [];
  const pushes: ProviderPush[] = [];
  for (const change of changes) {
    const next = record(change.new);
    const old = record(change.old);
    const ref = next.name ? next : old;
    const type = ref.type === "tag" ? "tags" : "heads";
    const name = text(ref.name);
    if (!name) continue;
    const target = record(next.target);
    pushes.push({
      ref: `refs/${type}/${name}`,
      commit: text(target.hash),
      before: text(record(old.target).hash),
      files: null,
      deleted: change.closed === true || !change.new,
      subject: firstLine(target.message),
      message: text(target.message),
    });
  }
  return { event: "push", repository: repo, pushes };
}

export function parsePushes(kind: GitProviderKind, body: unknown, headers: Headers): ParsedPushes {
  switch (kind) {
    case "github": {
      const event = headers.get("x-github-event");
      if (event === "ping")
        return { event: "ping", repository: { fullName: null, id: null }, pushes: [] };
      if (event !== "push")
        return { event: "other", repository: { fullName: null, id: null }, pushes: [] };
      return githubLike(body);
    }
    case "gitea": {
      const event = headers.get("x-gitea-event") ?? headers.get("x-gogs-event");
      if (event !== "push")
        return { event: "other", repository: { fullName: null, id: null }, pushes: [] };
      return githubLike(body);
    }
    case "gitlab":
      return gitlab(body);
    case "bitbucket":
      return bitbucket(body, headers.get("x-event-key"));
  }
}
