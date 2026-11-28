import { recordAudit } from "../audit/audit.ts";
import {
  cancelNextLinkCertificate,
  createNextLinkCertificate,
  PREVIOUS_KEPT_MS,
  readLinkCertificate,
  readNextLinkCertificate,
  readPreviousLinkCertificate,
  switchLinkCertificate,
} from "../runners/link-certificate.ts";
import type { ControlServices } from "../services.ts";
import type { CliIo } from "./commands.ts";

/**
 * Replacing the runner link's certificate (C4-10; docs/runner-protocol.md, "Replacing the link
 * certificate"), as `sudo nearzero runner-link …` runs it inside the control plane's container:
 *
 * - `rotate` makes the next pair beside the current one. Within a minute the control plane gives
 *   its fingerprint to every connected server over the link that still works (each reconnects
 *   once), and to the others when they next connect; runners accept both from then on.
 * - `status` prints both fingerprints and the servers whose runner doesn't hold the next one yet.
 * - `switch` puts the next pair in place. It refuses while a server is missing the next
 *   fingerprint, unless --force; the nearzero command then restarts the control plane, which
 *   serves the new pair. Until then the running control plane keeps announcing the new
 *   fingerprint (C4-13). Runners that took it never accept the old one again (C4-12). The old pair
 *   is kept as link.previous.* until every server has reconnected, or a week (C4-14).
 * - `cancel` drops the next pair.
 *
 * Each of rotate, switch and cancel is recorded in the audit log with the fingerprints (spec 22.4
 * rule 8), and a forced switch names the servers it cut off.
 */

const AUDIT_ACTOR = { kind: "command", label: "nearzero runner-link" } as const;

async function audit(
  services: ControlServices,
  action: string,
  fingerprint: string,
  details: Record<string, unknown>,
): Promise<void> {
  await recordAudit(services.db, services.log, AUDIT_ACTOR, {
    action: `runner-link.${action}`,
    target: { kind: "runner-link", id: fingerprint || "none" },
    details,
  });
}

export const RUNNER_LINK_USAGE = [
  "  runner-link status [--json]",
  "                            Show the runner link's certificate fingerprint, the next one",
  "                            while it is being replaced, and which servers don't hold it yet",
  "  runner-link rotate        Make the next certificate; servers are given its fingerprint",
  "  runner-link switch [--force]",
  "                            Use the next certificate (restart to serve it); refuses while a",
  "                            server doesn't hold its fingerprint, unless --force",
  "  runner-link cancel        Drop the next certificate without using it",
];

interface ServerPin {
  name: string;
  /** Where the runner reaches Nearzero, as of its last hello. */
  link: string | null;
  /** Whether it holds the next fingerprint. */
  holdsNext: boolean;
  lastSeenAt: string | null;
}

async function serverPins(services: ControlServices, next: string | null): Promise<ServerPin[]> {
  const rows = await services.db
    .selectFrom("runner as r")
    .innerJoin("server as s", "s.id", "r.server_id")
    .select(["s.name", "r.link_url", "r.link_next", "r.last_seen_at"])
    .where("r.revoked_at", "is", null)
    .where("r.credential_hash", "is not", null)
    .orderBy("s.name")
    .execute();
  return rows.map((row) => ({
    name: row.name,
    link: row.link_url,
    holdsNext: next !== null && row.link_next === next,
    lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
  }));
}

export async function runnerLinkCommand(
  args: readonly string[],
  services: ControlServices,
  io: CliIo,
  directory: string | null,
): Promise<number> {
  const [action = "status", ...rest] = args;
  const json = rest.includes("--json");
  const force = rest.includes("--force");
  if (!directory) {
    io.err(
      "This Nearzero has no runner link port (NEARZERO_RUNNER_TLS_DIR isn't set), so there is no certificate to replace.",
    );
    return 1;
  }
  try {
    switch (action) {
      case "status": {
        const current = await readLinkCertificate(directory);
        if (!current) {
          io.err(
            `There is no runner link certificate in ${directory} yet; Nearzero makes one when it starts.`,
          );
          return 1;
        }
        const next = await readNextLinkCertificate(directory);
        const previous = await readPreviousLinkCertificate(directory);
        const servers = await serverPins(services, next?.fingerprint ?? null);
        if (json) {
          io.out(
            JSON.stringify({
              fingerprint: current.fingerprint,
              next: next?.fingerprint ?? null,
              previous: previous
                ? {
                    fingerprint: previous.fingerprint,
                    switchedAt: previous.switchedAt.toISOString(),
                  }
                : null,
              servers,
            }),
          );
          return 0;
        }
        io.out(`Runner link certificate: sha256:${current.fingerprint}`);
        if (previous) {
          io.out(
            `Replaced certificate:    sha256:${previous.fingerprint} (switched ${previous.switchedAt.toISOString()}). Its key is deleted once every server has reconnected to the new one, or by ${new Date(previous.switchedAt.getTime() + PREVIOUS_KEPT_MS).toISOString()}.`,
          );
        }
        if (!next) {
          io.out("No replacement is waiting. Make one with: sudo nearzero runner-link rotate");
          return 0;
        }
        io.out(`Next certificate:        sha256:${next.fingerprint}`);
        const missing = servers.filter((server) => !server.holdsNext);
        if (missing.length === 0) {
          io.out(
            "Every server holds the next fingerprint. Switch with: sudo nearzero runner-link switch",
          );
        } else {
          io.out(
            "These servers don't hold the next fingerprint yet. Connected ones get it within a minute; the others when they next connect. After the switch, any still without it need setup again:",
          );
          for (const server of missing) {
            io.out(
              `  - ${server.name}${server.link ? ` (${server.link})` : ""}${server.lastSeenAt ? `, last seen ${server.lastSeenAt}` : ", never connected"}`,
            );
          }
        }
        return 0;
      }
      case "rotate": {
        const made = await createNextLinkCertificate(directory);
        if (made.created) {
          await audit(services, "rotate", made.fingerprint, {
            fingerprint: made.fingerprint,
            current: (await readLinkCertificate(directory))?.fingerprint ?? null,
          });
        }
        io.out(
          `${made.created ? "Made the next runner link certificate" : "The next runner link certificate is already waiting"}: sha256:${made.fingerprint}`,
        );
        io.out(
          "Within a minute Nearzero gives its fingerprint to every connected server over the link that still works (each reconnects once), and to the others when they next connect. Check with: sudo nearzero runner-link status, then switch with: sudo nearzero runner-link switch",
        );
        return 0;
      }
      case "switch": {
        const next = await readNextLinkCertificate(directory);
        if (!next) {
          io.err(
            "No next certificate is waiting. Make one first: sudo nearzero runner-link rotate",
          );
          return 1;
        }
        const missing = (await serverPins(services, next.fingerprint)).filter(
          (server) => !server.holdsNext,
        );
        if (missing.length > 0 && !force) {
          io.err(
            `${missing.length === 1 ? "A server doesn't" : `${missing.length} servers don't`} hold the next fingerprint yet, so switching now would cut ${missing.length === 1 ? "it" : "them"} off until setup runs there again:`,
          );
          for (const server of missing) io.err(`  - ${server.name}`);
          io.err(
            "Wait for them to connect (sudo nearzero runner-link status), or switch anyway with: sudo nearzero runner-link switch --force",
          );
          return 1;
        }
        const switched = await switchLinkCertificate(directory);
        await audit(services, "switch", switched.current, {
          fingerprint: switched.current,
          previous: switched.previous || null,
          forced: missing.length > 0,
          ...(missing.length > 0 ? { cutOff: missing.map((server) => server.name) } : {}),
        });
        io.out(
          `The runner link uses sha256:${switched.current} once Nearzero restarts; until then it keeps telling servers the new fingerprint. Servers that hold it never accept the old one again. The old certificate is kept as link.previous.* until every server has reconnected, or a week.`,
        );
        if (missing.length > 0) {
          io.out(`Run setup again on: ${missing.map((server) => server.name).join(", ")}`);
        }
        return 0;
      }
      case "cancel": {
        const dropped = await cancelNextLinkCertificate(directory);
        if (dropped !== null) {
          await audit(services, "cancel", dropped, { fingerprint: dropped || null });
        }
        io.out(
          dropped !== null
            ? "Dropped the next runner link certificate."
            : "No next certificate was waiting.",
        );
        return 0;
      }
      default:
        io.err(`Unknown runner-link command: ${action}`);
        for (const line of RUNNER_LINK_USAGE) io.err(line);
        return 1;
    }
  } catch (error) {
    io.err((error as Error).message);
    return 1;
  }
}
