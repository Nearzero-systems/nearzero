import { bitbucket, githubLike, gitlab, type ProviderPush } from "../git-providers/events.ts";
import { type PushDecision, shouldDeployPush } from "./push-rules.ts";

/**
 * What a call to the generic deploy webhook is (spec 6.6, 24 G4, 30b R2-03, R2-10, 30d R4-12,
 * R4-13), read from its Git host headers first and then from the shape of its body:
 *
 * - a Git host checking the webhook (GitHub's ping when it is added, Bitbucket's test);
 * - a push from GitHub, Gitea, GitLab, Bitbucket or Soft Serve, or a body shaped like one;
 * - another event of a Git host (issues, stars, comments…), which never deploys;
 * - a container registry's push: a Docker Hub webhook, or GitHub's package events;
 * - anything else, an empty body included: a plain call, which deploys (CI tools use these).
 *
 * Then, by the service's source: a Git source deploys pushes to its branch (or new tags, with
 * the On tag trigger) under its watch paths; an image source deploys a registry push only for
 * its own image and tag; an upload source has nothing to redeploy from.
 */

export interface ImageName {
  /** registry/path, lower case, Docker Hub as docker.io with library/ for official images. */
  repository: string;
  tag: string | null;
  digest: string | null;
  /** As written, for messages. */
  shown: string;
}

export type WebhookCall =
  | { kind: "plain" }
  | { kind: "ping"; host: string }
  | { kind: "event"; host: string; event: string }
  | {
      kind: "push";
      host: string | null;
      pushes: ProviderPush[];
      repository: string | null;
    }
  | { kind: "image"; host: string; image: ImageName }
  | { kind: "package"; host: string; reason: string }
  /** A push event whose body can't be read as one. */
  | { kind: "unreadable"; host: string };

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

const DOCKER_HUB = new Set(["docker.io", "index.docker.io", "registry-1.docker.io"]);

/**
 * An image reference as Docker reads it: [registry/]path[:tag][@digest]. The first part is a
 * registry when it has a dot or a port, or is localhost; otherwise the image is on Docker Hub.
 */
export function parseImage(reference: string): ImageName | null {
  const shown = reference.trim();
  if (shown === "" || /\s/.test(shown)) return null;
  let rest = shown;
  let digest: string | null = null;
  const at = rest.indexOf("@");
  if (at >= 0) {
    digest = rest.slice(at + 1) || null;
    rest = rest.slice(0, at);
  }
  let tag: string | null = null;
  const lastSlash = rest.lastIndexOf("/");
  const colon = rest.lastIndexOf(":");
  if (colon > lastSlash) {
    tag = rest.slice(colon + 1) || null;
    rest = rest.slice(0, colon);
  }
  const parts = rest.split("/").filter(Boolean);
  if (parts.length === 0) return null;
  const first = parts[0] as string;
  let registry = "docker.io";
  if (parts.length > 1 && (/[.:]/.test(first) || first === "localhost")) {
    registry = first.toLowerCase();
    parts.shift();
  }
  if (DOCKER_HUB.has(registry)) {
    registry = "docker.io";
    if (parts.length === 1) parts.unshift("library");
  }
  return {
    repository: `${registry}/${parts.join("/").toLowerCase()}`,
    tag,
    digest,
    shown,
  };
}

/** The pushed image of a Docker Hub webhook's body, or null when the body isn't one. */
function dockerHubPush(body: unknown): ImageName | null {
  const value = record(body);
  const pushData = record(value.push_data);
  const repository = record(value.repository);
  const name = text(repository.repo_name);
  if (!name || value.push_data === undefined) return null;
  const tag = text(pushData.tag);
  const parsed = parseImage(name);
  if (!parsed) return null;
  return { ...parsed, tag, shown: tag ? `${name}:${tag}` : name };
}

/** GitHub's `package` and `registry_package` events, for container images on ghcr.io. */
function githubPackage(event: string, body: unknown): WebhookCall {
  const value = record(body);
  const item = record(event === "package" ? value.package : value.registry_package);
  const action = text(value.action);
  const type = (text(item.package_type) ?? text(item.ecosystem) ?? "").toLowerCase();
  if (type !== "container" && type !== "docker") {
    return {
      kind: "package",
      host: "GitHub",
      reason: "GitHub sent a package event for something other than a container image.",
    };
  }
  if (action && action !== "published" && action !== "updated") {
    return {
      kind: "package",
      host: "GitHub",
      reason: `GitHub sent a package event (${action}), not a newly pushed image.`,
    };
  }
  const version = record(item.package_version);
  const tag = text(record(record(version.container_metadata).tag).name);
  const url = text(version.package_url);
  const owner = text(item.namespace) ?? text(record(item.owner).login);
  const name = text(item.name);
  const fromUrl = url ? parseImage(url) : null;
  const base = fromUrl ?? (owner && name ? parseImage(`ghcr.io/${owner}/${name}`) : null);
  if (!base) {
    return {
      kind: "package",
      host: "GitHub",
      reason: "GitHub's package event doesn't say which image was pushed.",
    };
  }
  const shownName = base.repository.replace(/^docker\.io\/(library\/)?/, "");
  return {
    kind: "image",
    host: "GitHub",
    image: {
      repository: base.repository,
      tag: tag ?? base.tag,
      digest: null,
      shown: (tag ?? base.tag) ? `${shownName}:${tag ?? base.tag}` : shownName,
    },
  };
}

function genericPush(body: unknown, host: string | null): WebhookCall {
  const parsed = githubLike(body);
  if (parsed.pushes.length === 0) {
    return host ? { kind: "unreadable", host } : { kind: "plain" };
  }
  return { kind: "push", host, pushes: parsed.pushes, repository: parsed.repository.fullName };
}

/** Reads a call to the deploy webhook. */
export function classifyCall(headers: Headers, body: unknown): WebhookCall {
  const gitea = headers.get("x-gitea-event") ?? headers.get("x-gogs-event");
  if (gitea !== null) {
    return gitea === "push"
      ? genericPush(body, "Gitea")
      : { kind: "event", host: "Gitea", event: gitea };
  }
  const gitlabEvent = headers.get("x-gitlab-event");
  if (gitlabEvent !== null) {
    const parsed = gitlab(body);
    if (parsed.event !== "push") return { kind: "event", host: "GitLab", event: gitlabEvent };
    return {
      kind: "push",
      host: "GitLab",
      pushes: parsed.pushes,
      repository: parsed.repository.fullName,
    };
  }
  const softServe = headers.get("x-softserve-event");
  if (softServe !== null) {
    return softServe === "push"
      ? genericPush(body, "Soft Serve")
      : { kind: "event", host: "Soft Serve", event: softServe };
  }
  const github = headers.get("x-github-event");
  if (github !== null) {
    if (github === "ping") return { kind: "ping", host: "GitHub" };
    if (github === "push") return genericPush(body, "GitHub");
    if (github === "package" || github === "registry_package") return githubPackage(github, body);
    return { kind: "event", host: "GitHub", event: github };
  }
  const eventKey = headers.get("x-event-key");
  if (eventKey !== null) {
    const parsed = bitbucket(body, eventKey);
    if (parsed.event === "ping") return { kind: "ping", host: "Bitbucket" };
    if (parsed.event !== "push") return { kind: "event", host: "Bitbucket", event: eventKey };
    return {
      kind: "push",
      host: "Bitbucket",
      pushes: parsed.pushes,
      repository: parsed.repository.fullName,
    };
  }
  // No Git host headers: the body's shape.
  const hub = dockerHubPush(body);
  if (hub) return { kind: "image", host: "Docker Hub", image: hub };
  const value = record(body);
  if (typeof value.ref === "string") return genericPush(body, null);
  if (Array.isArray(record(value.push).changes)) {
    const parsed = bitbucket(body, "repo:push");
    return {
      kind: "push",
      host: "Bitbucket",
      pushes: parsed.pushes,
      repository: parsed.repository.fullName,
    };
  }
  return { kind: "plain" };
}

export type CallDecision =
  | { deploy: false; message: string }
  | { deploy: true; commit: string | null; tag: string | null; title: string | null };

/** What the service's source is, for the decision. */
export type SourceForCall =
  | {
      type: "git";
      trigger: "push" | "tag";
      branch: string;
      watchPaths: readonly string[];
      /** owner/name for provider-linked sources: a push naming another repository is ignored. */
      repository: string | null;
    }
  | { type: "image"; image: string }
  | { type: "upload" }
  | { type: "other" };

const PING = "Ping received: the webhook is active.";

/** The answer to a Git host checking the webhook. */
export function pingAnswer(): string {
  return PING;
}

function imageDecision(appImage: string, call: ImageName, host: string): CallDecision {
  const app = parseImage(appImage);
  if (!app) {
    return { deploy: false, message: `This app's image ${appImage} can't be compared.` };
  }
  if (app.repository !== call.repository) {
    return {
      deploy: false,
      message: `Not deployed: ${host} pushed ${call.shown}, and this app runs ${appImage}.`,
    };
  }
  if (call.tag !== null) {
    if (app.digest !== null && app.tag === null) {
      return {
        deploy: false,
        message: `Not deployed: this app runs ${appImage}, pinned to one digest, so a pushed tag doesn't change it.`,
      };
    }
    const wanted = app.tag ?? "latest";
    if (call.tag !== wanted) {
      return {
        deploy: false,
        message: `Not deployed: ${host} pushed the tag ${call.tag}, and this app runs the tag ${wanted} (${appImage}).`,
      };
    }
  }
  return {
    deploy: true,
    commit: null,
    tag: null,
    title: `Image pushed: ${call.shown}`.slice(0, 300),
  };
}

function pushDecision(
  source: Extract<SourceForCall, { type: "git" }>,
  call: Extract<WebhookCall, { kind: "push" }>,
): CallDecision {
  if (
    source.repository &&
    call.repository &&
    call.repository.toLowerCase() !== source.repository.toLowerCase()
  ) {
    return {
      deploy: false,
      message: `The push was to ${call.repository}; this service deploys ${source.repository}.`,
    };
  }
  let last: PushDecision = { deploy: false, reason: "The push changed no branch or tag." };
  const rules = { trigger: source.trigger, branch: source.branch, watchPaths: source.watchPaths };
  for (const push of call.pushes) {
    const decision = shouldDeployPush(rules, push);
    if (decision.deploy) {
      return {
        deploy: true,
        commit: decision.commit,
        tag: decision.tag,
        title: push.subject ? push.subject.slice(0, 300) : null,
      };
    }
    last = decision;
  }
  return { deploy: false, message: last.reason };
}

/** Whether a call deploys a service with this source. Pings are answered before this. */
export function decideCall(source: SourceForCall, call: WebhookCall): CallDecision {
  if (call.kind === "ping") return { deploy: false, message: PING };
  if (call.kind === "event") {
    return {
      deploy: false,
      message: `Not deployed: only pushes deploy, and ${call.host} sent the ${call.event} event.`,
    };
  }
  if (call.kind === "package") return { deploy: false, message: `Not deployed: ${call.reason}` };
  if (call.kind === "unreadable") {
    return {
      deploy: false,
      message: `Not deployed: ${call.host} sent a push this webhook can't read.`,
    };
  }
  if (source.type === "upload") {
    return {
      deploy: false,
      message:
        "Not deployed: this app runs an uploaded archive, which a webhook can't update. Upload a new archive to deploy it.",
    };
  }
  if (call.kind === "image") {
    if (source.type === "image") return imageDecision(source.image, call.image, call.host);
    if (source.type === "git") {
      return {
        deploy: false,
        message: `Not deployed: ${call.host} pushed an image, and this service builds from Git.`,
      };
    }
    return { deploy: true, commit: null, tag: null, title: `Image pushed: ${call.image.shown}` };
  }
  if (call.kind === "push" && source.type === "git") return pushDecision(source, call);
  // A plain call, or a push to a service that doesn't build from Git: deploy what it runs.
  return { deploy: true, commit: null, tag: null, title: null };
}
