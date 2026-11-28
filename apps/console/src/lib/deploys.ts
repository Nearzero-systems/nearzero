import { ApiError } from "./api-error.ts";
import type { DeployStart } from "./data/types.ts";

/**
 * Starting a deploy (spec 06 6.5, 07 7.2, 08 8.1). This is the one place that knows how: the
 * console's pages call it through the data layer (data.deploy) and its browser code calls it
 * with the console's API proxy (client/deploys.ts). A refusal comes back with the API's words
 * ("Wait for the deployment to finish first.", the Compose milestone's note, a missing right).
 */

/** Sends one request to the Nearzero API (the server-side client or the browser's proxy). */
export type ApiSender = <T>(method: string, path: string, body?: unknown) => Promise<T>;

interface DeployAnswer {
  deployment: { id: string };
  replaced: boolean;
  waiting: boolean;
  message: string;
}

export async function startDeploy(
  send: ApiSender,
  serviceId: string,
  options: { cleanCache?: boolean; redeploy?: boolean } = {},
): Promise<DeployStart> {
  try {
    const answer = await send<DeployAnswer>(
      "POST",
      `/services/${encodeURIComponent(serviceId)}/deployments`,
      {
        ...(options.cleanCache ? { cleanCache: true } : {}),
        // Recorded as "Redeploy" on the deployment row (spec 6.3).
        ...(options.redeploy ? { redeploy: true } : {}),
      },
    );
    return {
      status: "started",
      deploymentId: answer.deployment.id,
      message: answer.message || "Deployment started",
      waiting: answer.waiting === true,
      replaced: answer.replaced === true,
    };
  } catch (error) {
    if (error instanceof ApiError) {
      return { status: "refused", message: error.message, code: error.code };
    }
    throw error;
  }
}

/** The header's runtime actions (spec 6.2, 8.2) and what each success toast says. */
export const RUNTIME_ACTIONS = ["start", "stop", "reload"] as const;
export type RuntimeAction = (typeof RUNTIME_ACTIONS)[number];

export const RUNTIME_ACTION_DONE: Record<RuntimeAction, string> = {
  start: "Started",
  stop: "Stopped",
  reload: "Reloaded",
};

export type HeaderAction = "deploy" | "redeploy" | RuntimeAction | "cancel";

/** "Confirm action" wording for every header action (spec 6.2). */
export function confirmText(
  action: HeaderAction,
  service: { name: string; kind: string },
  environment: string,
): string {
  switch (action) {
    case "redeploy":
      if (service.kind === "application") return "Rebuild application";
      if (service.kind === "compose") return `Redeploy ${service.name} in ${environment}?`;
      // Databases stop first: two containers can't share the data (spec 8.2).
      return `Redeploy ${service.name} in ${environment}? It stops for a moment while the new container starts on the same data.`;
    case "deploy":
      return `Deploy ${service.name} in ${environment}?`;
    case "reload":
      // Apps start their running image again with the saved settings (30b R2-02).
      return service.kind === "application"
        ? `Reload ${service.name}? It starts again with its saved variables, mounts and ports, without rebuilding.`
        : `Restart ${service.name} without rebuilding it?`;
    case "start":
      return `Start ${service.name}?`;
    case "stop":
      return `Stop ${service.name}? It stops serving until you start it again.`;
    case "cancel":
      return "Cancel this deployment? The running version keeps serving.";
  }
}

/** What a service page's header offers (spec 6.2, 7.2, 8.2). */
export interface HeaderActions {
  primary: "deploy" | "redeploy" | null;
  runtime: RuntimeAction[];
  terminal: boolean;
  /** Compose: "Reload (redeploy)" beside Deploy once the stack was deployed (spec 7.2). */
  redeploy: boolean;
  /** Compose: Deploy and Reload stay shown but disabled while a deploy runs (spec 7.2). */
  busy: boolean;
}

/** Which header actions a service shows for its state (spec 6.2, 7.2, 8.2). */
export function headerActions(service: {
  kind: string;
  status: string;
  can: { deploy: boolean };
  deploy?: { inProgress: unknown | null } | undefined;
  /** A Compose service's format; Stacks have no Start (spec 7.2). */
  format?: "compose" | "stack";
}): HeaderActions {
  const none: HeaderActions = {
    primary: null,
    runtime: [],
    terminal: false,
    redeploy: false,
    busy: false,
  };
  if (!service.can.deploy) return none;
  const deploying = service.status === "deploying" || Boolean(service.deploy?.inProgress);
  const running = service.status === "running";
  const deployed = service.status !== "idle";
  const runtime: RuntimeAction[] = [];
  if (service.kind === "compose") {
    // Deploy and Reload (redeploy), both disabled while deploying; Start (Compose format, when
    // stopped) or Stop. A Stack is started by deploying it, so it has no Start.
    if (!deploying && service.status === "stopped" && service.format !== "stack")
      runtime.push("start");
    if (!deploying && (running || service.status === "failed")) runtime.push("stop");
    return {
      primary: "deploy",
      runtime,
      terminal: !deploying && running,
      redeploy: deployed,
      busy: deploying,
    };
  }
  const database = service.kind !== "application";
  let primary: "deploy" | "redeploy" | null = null;
  if (!deploying) {
    // A database offers Deploy only when it isn't running (spec 8.2; B3-22): a deploy stops it
    // first, so one click on a plain "Deploy" mustn't take a running database down.
    if (database) primary = running ? null : "deploy";
    else primary = deployed ? "redeploy" : "deploy";
  }
  if (!deploying && running && service.kind === "application") {
    // Reload (restart without rebuilding) is an application action (spec 6.2).
    runtime.push("reload");
  }
  if (!deploying && service.status === "stopped") runtime.push("start");
  if (!deploying && (running || service.status === "failed")) runtime.push("stop");
  return { ...none, primary, runtime, terminal: !deploying && running };
}

/** Durations as the Deployments page shows them ("1m 12s", "4s so far"). */
export function durationLabel(ms: number | null, running: boolean): string {
  if (ms === null || !Number.isFinite(ms)) return running ? "Starting…" : "—";
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  const hours = Math.floor(minutes / 60);
  const text =
    hours > 0
      ? `${hours}h ${minutes % 60}m`
      : minutes > 0
        ? `${minutes}m ${seconds}s`
        : `${seconds}s`;
  return running ? `${text} so far` : text;
}

/** The pill for a deployment's status (spec 11.1 words; Failed everywhere). */
export function deploymentPill(status: string): "ok" | "run" | "warn" | "fail" | "idle" {
  switch (status) {
    case "active":
      return "ok";
    case "building":
      return "run";
    case "queued":
      return "warn";
    case "failed":
      return "fail";
    default:
      return "idle";
  }
}

/** A deployment pill's word (spec 21.10): the original says "Error" where the API says Failed. */
export function deploymentPillLabel(status: string, label: string): string {
  return status === "failed" ? "Error" : label;
}

/** The bell's four words (spec 11.5): Deployed, Failed, Running, Cancelled. */
/** The time a bell card shows: when the deployment finished, or when it started (spec 11.5). */
export function bellTime(item: { createdAt: string; finishedAt: string | null }): Date {
  return new Date(item.finishedAt ?? item.createdAt);
}

/**
 * The bell's list (spec 11.5): the latest 8, newest first by the time each card shows, so a
 * long build or a cancelled deploy that finished late sits where its time says (B3-20).
 */
export function bellDeployments<T extends { createdAt: string; finishedAt: string | null }>(
  list: readonly T[],
): T[] {
  return list
    .slice(0, 8)
    .map((item, index) => ({ item, index, at: bellTime(item).getTime() }))
    .sort((a, b) => b.at - a.at || a.index - b.index)
    .map(({ item }) => item);
}

export function bellStatus(status: string): {
  pill: "ok" | "run" | "fail" | "idle";
  label: string;
} {
  if (status === "failed") return { pill: "fail", label: "Failed" };
  if (status === "queued" || status === "building") return { pill: "run", label: "Running" };
  if (status === "cancelled") return { pill: "idle", label: "Cancelled" };
  return { pill: "ok", label: "Deployed" };
}

export const TRIGGER_LABELS: Record<string, string> = {
  push: "push",
  tag: "tag",
  webhook: "webhook",
  manual: "manual",
  agent: "Agent",
  redeploy: "redeploy",
  reload: "reload",
};

/** The first hostname's URL for the "Live at" banner and the header's Visit, or null. */
export function liveUrl(hostnames: readonly { url: string; service: unknown }[]): string | null {
  return hostnames.find((item) => item.service !== null)?.url ?? null;
}

/** The deploy log's closing line names the address once a deploy is complete (spec 6.1). */
export function liveAtFromLog(text: string): string | null {
  const match = text.match(/It's live at: (https?:\/\/[^\s,]+)/);
  return match?.[1] ?? null;
}
