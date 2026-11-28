import type { ServiceKind, ServiceStatus } from "./data/types.ts";

/**
 * Deleting projects and services (spec 05 5.1, 5.2): the plan the dialog loads, the run that
 * follows in the background, and the words for each service's state. The shapes are the API's
 * (docs/api/projects.md); the dialogs are client/teardown.ts and client/service-delete.ts.
 */

export interface DeletePlanService {
  id: string | null;
  name: string | null;
  kind: ServiceKind | null;
  kindLabel: string | null;
  environment: { id: string; name: string } | null;
  serverId: string | null;
  production: boolean;
  access: boolean;
  status: ServiceStatus | null;
  deploying: boolean;
  willStop: boolean;
  beingDeleted: boolean;
}

export interface DeletePlan {
  scope: "project" | "services";
  project: { id: string; name: string };
  services: DeletePlanService[];
  counts: {
    services: number;
    noAccess: number;
    production: number;
    deploying: number;
    running: number;
    beingDeleted: number;
  };
  canDelete: boolean;
  blockers: string[];
  warnings: string[];
  summary: string;
  confirmLabel: string;
  confirmText: string;
  fingerprint: string;
  inProgress: { runId: string; message: string } | null;
}

export type RunItemState = "waiting" | "removing" | "removed" | "not_removed";

export interface DeleteRun {
  id: string;
  scope: "project" | "services";
  state: "running" | "succeeded" | "failed";
  /** false while running: the platform stopped carrying it out. */
  tracked: boolean;
  project: { id: string; name: string; kept: boolean };
  items: {
    serviceId: string | null;
    name: string | null;
    kind: ServiceKind | null;
    environmentName: string;
    production: boolean;
    state: RunItemState;
    reason: string | null;
  }[];
  counts: { waiting: number; removing: number; removed: number; notRemoved: number };
  message: string;
  createdAt: string;
  finishedAt: string | null;
}

export interface ServiceDeletePlan {
  service: {
    id: string;
    name: string;
    kind: ServiceKind;
    environment: { id: string; name: string };
    production: boolean;
    willStop: boolean;
  };
  canDelete: boolean;
  blockers: string[];
  copies: {
    id: string;
    environmentId: string;
    environmentName: string;
    label: string;
    production: boolean;
    canDelete: boolean;
    deploying: boolean;
  }[];
  copiesHint: string | null;
  confirmText: string;
}

export const ITEM_STATES: Record<
  RunItemState,
  { label: string; pill: "ok" | "run" | "fail" | "idle" }
> = {
  waiting: { label: "Waiting", pill: "idle" },
  removing: { label: "Removing…", pill: "run" },
  removed: { label: "Removed", pill: "ok" },
  not_removed: { label: "Not removed", pill: "fail" },
};

export const KEEPS_GOING = "You can close this; the delete keeps going.";
export const UNTRACKED_MESSAGE =
  "Nearzero restarted while this delete was running, so it is no longer tracked. Start it again to remove what's left.";
export const SERVICE_DIALOG_TEXT =
  "Nearzero removes it and everything it keeps on its server: containers, volumes, files, logs, images, domains and DNS records. This cannot be undone.";
export const COMPOSE_VOLUMES_NOTE = "Deleting a Compose service always removes its volumes.";

export function isFinished(run: Pick<DeleteRun, "state">): boolean {
  return run.state !== "running";
}

export function isUntracked(run: Pick<DeleteRun, "state" | "tracked">): boolean {
  return run.state === "running" && !run.tracked;
}

/** How a planned service is described in the list: its kind, environment and server. */
export function planRowDetail(service: DeletePlanService, serverName: (id: string) => string) {
  if (!service.access) return "No access";
  const parts = [service.kindLabel, service.environment?.name].filter(Boolean);
  if (service.serverId) parts.push(serverName(service.serverId));
  return parts.join(" · ");
}

/**
 * The toast after a single-service delete (spec 05 5.2): "Service removed", or a persistent
 * "Service removed, but not everywhere" naming what failed.
 */
export function serviceDeleteOutcome(run: DeleteRun): { message: string; persist: boolean } {
  const failed = run.items.filter((item) => item.state === "not_removed");
  if (failed.length === 0) return { message: run.message || "Service removed", persist: false };
  const removed = run.items.length - failed.length;
  const named = failed
    .map(
      (item) =>
        `${item.environmentName} (${item.name ?? "service"})${item.reason ? `: ${item.reason}` : ""}`,
    )
    .join("; ");
  if (removed === 0) return { message: `Nothing was removed. ${named}`, persist: true };
  return { message: `Service removed, but not everywhere. Not removed: ${named}`, persist: true };
}
