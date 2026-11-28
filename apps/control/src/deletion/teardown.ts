import type { ServiceKind, ServiceStatus } from "@nearzero/shared";

/**
 * Removing a service from the server it runs on (spec 23.1, "Teardown is complete"): its
 * containers, images, folders, volumes (when asked), routes, hostnames and DNS records, and the
 * push webhook Nearzero registered for it at GitLab, Gitea or Bitbucket (spec 16.6).
 *
 * The delete job calls this once per service and records the answer; the records are deleted only
 * after it says "removed". The job catalog uses runnerTeardown (service-runtime/teardown.ts), which
 * removes the service from its server through the runner.
 * Rules for an implementation:
 * - Safe to repeat: the job runs at least once, and a retried delete calls it again for a service
 *   that may be half removed. Something already gone counts as removed.
 * - A running service is stopped first when `stopFirst` is set.
 * - Never report "removed" while anything of the service is left running or routed. A server
 *   that can't be reached is "not removed" with a reason the person can act on.
 * - Watch `signal`: it is aborted when the control plane stops; return or throw promptly.
 */

export interface TeardownTarget {
  serviceId: string;
  workspaceId: string;
  projectId: string;
  environmentId: string;
  kind: ServiceKind;
  name: string;
  appName: string;
  /** null for the Nearzero host. */
  serverId: string | null;
  status: ServiceStatus;
  /** The kind's settings (volume names and so on); never secrets. */
  settings: Record<string, unknown>;
}

export interface TeardownOptions {
  stopFirst: boolean;
  /** Deleting from the console and the Agent always wipes volumes in 1.0. */
  removeVolumes: boolean;
  signal: AbortSignal;
}

export type TeardownResult =
  /** `notes`: what removing it left for the person to do (a webhook the Git host kept). */
  { removed: true; notes?: string[] } | { removed: false; reason: string };

export interface ServiceTeardown {
  remove(target: TeardownTarget, options: TeardownOptions): Promise<TeardownResult>;
}

export const DEPLOYED_TEARDOWN_UNAVAILABLE =
  "This service was deployed, and removing deployed services from servers isn't available in this version yet. Nothing of it was deleted.";

/**
 * The teardown until servers can be reached: a service that was never deployed has nothing on any
 * server, so it is removed; anything else is refused rather than reported done.
 */
export const recordsOnlyTeardown: ServiceTeardown = {
  async remove(target) {
    if (target.status === "idle") return { removed: true };
    return { removed: false, reason: DEPLOYED_TEARDOWN_UNAVAILABLE };
  },
};
