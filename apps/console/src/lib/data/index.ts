import { agentData } from "./agent.ts";
import { backupsData } from "./backups.ts";
import { gitData } from "./git.ts";
import { identityData } from "./identity.ts";
import { m10Data } from "./m10.ts";
import { operationsData } from "./operations.ts";
import { projectsData } from "./projects.ts";
import type { ConsoleData, DataContext } from "./types.ts";

export type * from "./agent.ts";
export type * from "./backups.ts";
export type * from "./git.ts";
export type * from "./m10.ts";
export type * from "./operations-types.ts";
export type * from "./types.ts";

interface Host {
  cookies: DataContext["cookies"];
  request: Request;
  url: URL;
  locals: App.Locals;
  /** Astro throws when the adapter can't tell the peer; read it lazily and safely. */
  clientAddress?: string;
}

function peerOf(host: Host): string | undefined {
  try {
    return host.clientAddress;
  } catch {
    return undefined;
  }
}

/**
 * The one place pages get their data from, once per request, from the control plane's API:
 * identity, projects, Git, backups and operations (deployments, runtime, domains, servers).
 * and the Agent (its home, sessions and one session for the first paint).
 */
export function consoleData(host: Host): ConsoleData {
  const existing = host.locals.consoleData;
  if (existing) return existing;
  const ctx: DataContext = {
    cookies: host.cookies,
    request: host.request,
    url: host.url,
    clientAddress: peerOf(host),
  };
  const data: ConsoleData = {
    ...identityData(ctx),
    ...projectsData(ctx),
    ...gitData(ctx),
    ...backupsData(ctx),
    ...operationsData(ctx),
    // Tasks, Analytics and notification channels (spec 12, 13, 15).
    ...m10Data(ctx),
    // The Agent (spec 19).
    ...agentData(ctx),
  };
  host.locals.consoleData = data;
  return data;
}
