import { z } from "zod";

/**
 * Published ports in a remote server's host firewall (30b R2-13; spec 30 "Decisions, part 2",
 * 06 6.8, 08 8.2). A new command kind of the runner protocol (runner-protocol.ts spreads it into
 * its list), so an older runner answers it with "unsupported".
 *
 * `firewall.sync` makes the active host firewall (ufw, then firewalld, then iptables) allow
 * every port a service's container on the server publishes, with its protocol, and removes the
 * rules Nearzero added for ports nothing publishes any more. The runner keeps a record of the
 * rules it added (and marks them in ufw and iptables), never records a port that was already
 * allowed, and never touches a rule it didn't add. It reads what is published from the Engine,
 * so a deploy, a database made private and a deleted service all end in the same state.
 */

export const FIREWALL_KINDS = ["ufw", "firewalld", "iptables"] as const;
export type FirewallKind = (typeof FIREWALL_KINDS)[number];

export const firewallCommandSchemas = {
  "firewall.sync": z.object({}),
} as const;

export type FirewallCommandKind = keyof typeof firewallCommandSchemas;

export interface FirewallPort {
  port: number;
  protocol: "tcp" | "udp";
}

/**
 * One published port after a sync:
 * - "allowed": the runner added the rule now;
 * - "open": a rule the runner added earlier is still there;
 * - "already": something else already allows it, so the runner left it alone;
 * - "failed": the rule couldn't be added (`error` says why);
 * - "skipped": the firewall couldn't be changed (see the answer's `state`).
 */
export interface FirewallPortResult extends FirewallPort {
  /** The services (their ids) whose containers publish it. */
  services: string[];
  result: "allowed" | "open" | "already" | "failed" | "skipped";
  error?: string;
}

/**
 * What `firewall.sync` answers. `state`:
 * - "changed": a firewall is active and the runner could change it;
 * - "none": no supported host firewall is active, so nothing was opened;
 * - "no_rights": the runner isn't root and has no passwordless sudo, so nothing was changed;
 * - "containerized": the runner runs in a container (the Nearzero host), which this never changes.
 */
export interface FirewallSyncAnswer {
  state: "changed" | "none" | "no_rights" | "containerized";
  firewall: FirewallKind | null;
  ports: FirewallPortResult[];
  /** Rules Nearzero added that were removed because nothing publishes their port any more. */
  removed: FirewallPort[];
  /** Rules Nearzero added that it couldn't remove, with the reason. */
  notRemoved: (FirewallPort & { error: string })[];
}
