import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type FirewallCommandKind,
  type FirewallSyncAnswer,
  NEARZERO_LABELS,
  type ParsedCommandParams,
} from "@nearzero/shared";
import type { CommandContext } from "../commands.ts";
import { runCommand } from "../exec/command.ts";
import { type Exec, publishedPorts, readRecord, syncFirewall } from "./firewall.ts";

/**
 * The runner's firewall command (30b R2-13): `firewall.sync`. commands.ts adds it to its table.
 *
 * - On a remote server the runner runs as root (setup's system service), so it changes the
 *   firewall itself; a runner someone started as another user uses passwordless sudo, and
 *   without it changes nothing and says so.
 * - A runner in a container is the Nearzero host's, which this never changes (the control plane
 *   doesn't ask it either). It never reaches through to its host for this.
 * - Syncs on one server run one at a time.
 */

type Handler<K extends FirewallCommandKind> = (
  params: ParsedCommandParams<K>,
  context: CommandContext,
) => Promise<unknown>;

const RECORD_FILE = "firewall.json";

/** Runs a program, never failing: a missing program is exit code 127. */
function execWith(prefix: readonly string[], signal: AbortSignal): Exec {
  return async (argv) => {
    try {
      const result = await runCommand({ argv: [...prefix, ...argv], timeoutMs: 30_000, signal });
      return { code: result.exitCode, output: result.output };
    } catch (error) {
      return { code: 127, output: (error as Error).message };
    }
  };
}

/** How the runner may change the firewall: itself as root, through passwordless sudo, or not. */
async function firewallRights(signal: AbortSignal): Promise<Exec | null> {
  if (process.getuid?.() === 0) return execWith([], signal);
  const sudo = await execWith([], signal)(["sudo", "-n", "true"]);
  return sudo.code === 0 ? execWith(["sudo", "-n", "--"], signal) : null;
}

async function published(context: CommandContext) {
  const containers = await context.docker.listContainers({
    all: true,
    labels: [NEARZERO_LABELS.service],
  });
  const found: {
    service: string;
    bindings: Parameters<typeof publishedPorts>[0][number]["bindings"];
  }[] = [];
  for (const container of containers) {
    const labels = container.Labels ?? {};
    const service = labels[NEARZERO_LABELS.service];
    if (!service || labels[NEARZERO_LABELS.component]) continue;
    const details = await context.docker.inspectContainer(container.Id).catch(() => null);
    if (details) found.push({ service, bindings: details.HostConfig.PortBindings ?? null });
  }
  return publishedPorts(found);
}

let queue: Promise<unknown> = Promise.resolve();

async function sync(context: CommandContext): Promise<FirewallSyncAnswer> {
  if (context.containerized) {
    return { state: "containerized", firewall: null, ports: [], removed: [], notRemoved: [] };
  }
  const ports = await published(context);
  const exec = await firewallRights(context.signal);
  if (!exec) {
    return {
      state: "no_rights",
      firewall: null,
      ports: ports.map((port) => ({ ...port, result: "skipped" })),
      removed: [],
      notRemoved: [],
    };
  }
  const file = join(context.workDirectory, RECORD_FILE);
  const before = readRecord(await readFile(file, "utf8").catch(() => null));
  const { answer, record } = await syncFirewall({ exec, published: ports, record: before });
  if (JSON.stringify(record) !== JSON.stringify(before)) {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(`${file}.new`, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await rename(`${file}.new`, file);
  }
  return answer;
}

export const firewallHandlers: { [K in FirewallCommandKind]: Handler<K> } = {
  "firewall.sync": async (_params, context) => {
    const run = queue.then(() => sync(context));
    queue = run.catch(() => {});
    return run;
  },
};
