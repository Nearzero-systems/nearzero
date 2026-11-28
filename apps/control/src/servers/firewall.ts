import type { FirewallPort, FirewallSyncAnswer } from "@nearzero/shared";
import { HOST_TARGET, RunnerCommandError } from "../runners/hub.ts";
import { readAppSettings } from "../service-runtime/app-settings.ts";
import { reasonOf, type ServerOps } from "../service-runtime/server-ops.ts";

/**
 * Published ports in a remote server's host firewall (30b R2-13; spec 30 "Decisions, part 2",
 * 06 6.8, 08 8.2). After a deploy on a remote server, and after a service there is deleted, the
 * server's runner makes its active firewall (ufw, then firewalld, then iptables) allow exactly
 * what the server's services publish: it adds what is missing and removes the rules it added for
 * ports nothing publishes any more, never touching rules it didn't add. The deploy log, or the
 * deletion's result, says what changed and reminds that a cloud firewall must allow the ports
 * too. The Nearzero host is never changed.
 */

const spec = (port: FirewallPort) => `${port.port}/${port.protocol}`;
const list = (ports: readonly FirewallPort[]) => ports.map(spec).join(", ");

/** What a service publishes, from its saved settings: for a runner too old to say. */
export interface PublishingService {
  id: string;
  kind: string;
  settings: Record<string, unknown> | null;
  public_port: number | null;
}

/** The ports a service publishes by its settings; null when only its runner knows (Compose). */
export function settingsPorts(service: PublishingService): FirewallPort[] | null {
  if (service.kind === "application") {
    return readAppSettings(service.settings).ports.map((port) => ({
      port: port.publishedPort,
      protocol: port.protocol,
    }));
  }
  if (service.kind === "compose") return null;
  return service.public_port === null ? [] : [{ port: service.public_port, protocol: "tcp" }];
}

const cloudReminder = (ports: readonly FirewallPort[], too: boolean) =>
  `If this server is behind a cloud firewall or security group, allow ${list(ports)} there${too ? " too" : ""}.`;

/**
 * The log lines for one sync: the ports `serviceId` publishes (none when it was deleted), and
 * every rule Nearzero removed.
 */
export function firewallLines(answer: FirewallSyncAnswer, serviceId: string | null): string[] {
  const mine = answer.ports.filter(
    (port) => serviceId !== null && port.services.includes(serviceId),
  );
  const lines: string[] = [];
  if (answer.state === "none") {
    if (mine.length > 0) {
      lines.push(
        "No host firewall is active, so no ports were opened.",
        cloudReminder(mine, false),
      );
    }
    return lines;
  }
  if (answer.state === "no_rights") {
    if (mine.length > 0) {
      lines.push(
        `Skipped opening ports in the host firewall: the runner isn't root and can't use passwordless sudo. Allow ${list(mine)} in the server's firewall, and in any cloud firewall in front of it.`,
      );
    }
    return lines;
  }
  if (answer.state !== "changed" || !answer.firewall) return lines;
  const name = answer.firewall;
  for (const port of mine) {
    if (port.result === "allowed") lines.push(`${name}: allowed ${spec(port)}`);
    else if (port.result === "open" || port.result === "already") {
      lines.push(`${name}: ${spec(port)} is already allowed`);
    } else if (port.result === "failed") {
      lines.push(
        `${name}: couldn't allow ${spec(port)}: ${port.error ?? "it refused"}. Allow it in the server's firewall yourself.`,
      );
    }
  }
  for (const port of answer.removed) {
    lines.push(
      `${name}: removed the rule Nearzero added for ${spec(port)}, which nothing on this server publishes any more`,
    );
  }
  for (const port of answer.notRemoved) {
    lines.push(
      `${name}: couldn't remove the rule Nearzero added for ${spec(port)}: ${port.error}. Remove it in the server's firewall yourself.`,
    );
  }
  if (name === "iptables" && mine.some((port) => port.result === "allowed")) {
    lines.push(
      "iptables rules last until the server restarts unless you save them with your distribution's tool.",
    );
  }
  if (mine.length > 0) lines.push(cloudReminder(mine, true));
  return lines;
}

/**
 * Syncs the server's firewall and answers the lines for the log. `service` is the one just
 * deployed (its ports are named) or null after a deletion (only removals are named). Never
 * throws: a firewall that can't be changed doesn't fail a deploy or a deletion.
 */
export async function syncPublishedPorts(
  ops: ServerOps,
  service: PublishingService | null,
): Promise<string[]> {
  if (ops.target === HOST_TARGET) return [];
  try {
    const answer = (await ops.command("firewall.sync", {}, 120_000)) as FirewallSyncAnswer;
    return firewallLines(answer, service?.id ?? null);
  } catch (error) {
    const ports = service ? settingsPorts(service) : [];
    if (ports !== null && ports.length === 0) return [];
    const which = ports === null ? "the ports it publishes" : list(ports);
    if (error instanceof RunnerCommandError && error.runnerCode === "unsupported") {
      return [
        `This server's runner is too old to open published ports in its firewall, so no ports were opened. Run setup again on the server's page to update the runner, or allow ${which} in the server's firewall and in any cloud firewall in front of it.`,
      ];
    }
    const reason = reasonOf(error).replace(/[.\s]*$/, ".");
    return [
      `Published ports weren't opened in the server's firewall: ${reason} Allow ${which} there yourself, and in any cloud firewall in front of it.`,
    ];
  }
}
