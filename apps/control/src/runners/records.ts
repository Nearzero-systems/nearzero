import {
  http3OffMessage,
  type RunnerChecks,
  type RunnerState,
  routerHttp3Schema,
  runnerChecksSchema,
  type SystemInfo,
  systemInfoSchema,
} from "@nearzero/shared";
import type { ControlServices } from "../services.ts";
import { HOST_TARGET, targetOf } from "./hub.ts";

/**
 * The runner's link as people see it on a server's page: connected or not, its version, the
 * system it reported, "update needed" when it is older than this control plane accepts (run
 * setup again to update it, G3-05), and what is wrong with where it reaches Nearzero: refused
 * for plain HTTP, with "Run setup again on the server" (spec 31, C4-05), or connected on its
 * fallback because it can't use the preferred address.
 */

export interface RunnerView {
  state: RunnerState;
  version: string | null;
  protocol: number | null;
  connectedAt: string | null;
  lastSeenAt: string | null;
  /** Why it isn't working, in plain words; null when it is. */
  message: string | null;
  /** True when the control plane refused it for its version (Run setup again updates it). */
  updateNeeded: boolean;
  system: SystemInfo | null;
  checks: RunnerChecks | null;
  credentialIssuedAt: string | null;
  /**
   * HTTP/3 on the router (R3-22), from a connected runner that reports it: on, or off with the
   * line the server's details show ("HTTP/3 is off: UDP port 443 is in use by …"). Null when
   * the runner isn't connected or is older.
   */
  http3: { enabled: boolean; message: string | null } | null;
}

export const NEVER_CONNECTED =
  "The runner hasn't connected yet. Run setup, or the join command, on the server.";
export const OFFLINE =
  "The runner isn't connected. Check that the server is on and can reach Nearzero; the runner reconnects by itself. If it doesn't, run setup again on the server: a runner left with a plain http:// address doesn't connect at all.";

interface RunnerRow {
  server_id: string | null;
  runner_version: string | null;
  protocol: number | null;
  system: unknown;
  checks: unknown;
  connected_at: Date | null;
  last_seen_at: Date | null;
  refusal: string | null;
  /** What is wrong with where it reaches Nearzero (hub.ts; spec 31), or null. */
  link_problem: string | null;
  credential_hash: string | null;
  credential_issued_at: Date | null;
}

function view(services: ControlServices, target: string, row: RunnerRow | undefined): RunnerView {
  const live = services.runners.connection(target);
  const system = systemInfoSchema.safeParse(row?.system);
  const checks = runnerChecksSchema.safeParse(
    services.runners.state(target)?.checks ?? row?.checks,
  );
  const routerHttp3 = live
    ? routerHttp3Schema.safeParse(services.runners.state(target)?.router?.http3)
    : null;
  const http3 = routerHttp3?.success
    ? {
        enabled: routerHttp3.data.enabled,
        message: routerHttp3.data.enabled
          ? null
          : http3OffMessage(routerHttp3.data.port, routerHttp3.data.blockedBy ?? "another program"),
      }
    : null;
  let state: RunnerState;
  let message: string | null = null;
  if (live) {
    state = "online";
    // Connected, with a note: it can't use the address it should (it checks again by itself).
    message = row?.link_problem ?? null;
  } else if (row?.link_problem) {
    // Refused for reaching Nearzero over plain HTTP (C4-05): the words say to run setup again.
    state = "offline";
    message = row.link_problem;
  } else if (row?.refusal) {
    state = "update_needed";
    message = row.refusal;
  } else if (!row?.connected_at) {
    state = "never_connected";
    message = NEVER_CONNECTED;
  } else {
    state = "offline";
    message = OFFLINE;
  }
  return {
    state,
    version: live?.runnerVersion ?? row?.runner_version ?? null,
    protocol: live?.protocol ?? row?.protocol ?? null,
    connectedAt: live
      ? new Date(live.connectedAt).toISOString()
      : (row?.connected_at?.toISOString() ?? null),
    lastSeenAt: live ? new Date().toISOString() : (row?.last_seen_at?.toISOString() ?? null),
    message,
    updateNeeded: state === "update_needed",
    system: system.success ? system.data : null,
    checks: checks.success ? checks.data : null,
    credentialIssuedAt: row?.credential_issued_at?.toISOString() ?? null,
    http3,
  };
}

const COLUMNS = [
  "server_id",
  "runner_version",
  "protocol",
  "system",
  "checks",
  "connected_at",
  "last_seen_at",
  "refusal",
  "link_problem",
  "credential_hash",
  "credential_issued_at",
] as const;

export async function runnerViews(
  services: ControlServices,
  serverIds: string[],
): Promise<Map<string, RunnerView>> {
  const rows =
    serverIds.length === 0
      ? []
      : await services.db
          .selectFrom("runner")
          .select(COLUMNS)
          .where("server_id", "in", serverIds)
          .execute();
  const out = new Map<string, RunnerView>();
  for (const id of serverIds) {
    const row = rows.find((item) => item.server_id === id);
    out.set(id, view(services, targetOf(id), row));
  }
  return out;
}

export async function hostRunnerView(services: ControlServices): Promise<RunnerView> {
  const row = await services.db
    .selectFrom("runner")
    .select(COLUMNS)
    .where("server_id", "is", null)
    .executeTakeFirst();
  return view(services, HOST_TARGET, row);
}
