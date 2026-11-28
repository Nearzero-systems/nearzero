import type {
  FirewallKind,
  FirewallPort,
  FirewallPortResult,
  FirewallSyncAnswer,
} from "@nearzero/shared";

/**
 * Published ports in this server's host firewall (30b R2-13; spec 30 "Decisions, part 2",
 * 06 6.8, 08 8.2): the active firewall is found the way setup's firewall step finds it (ufw,
 * then firewalld, then iptables), every port a service's container publishes is allowed with its
 * protocol, and the rules Nearzero added for ports nothing publishes any more are removed.
 *
 * Rules Nearzero didn't add are never touched: the runner keeps a record of the rules it added,
 * marks them with the comment "nearzero" in ufw and iptables, never records a port something
 * else already allowed, and removes only rules carrying its mark (firewalld has no comments, so
 * there the record alone says which are Nearzero's).
 *
 * Pure apart from the programs it runs (`exec`) and the record it keeps, so it is tested with a
 * fake firewall.
 */

export const RULE_COMMENT = "nearzero";

/** Runs a program with its arguments (never through a shell): its exit code and output. */
export type Exec = (argv: readonly string[]) => Promise<{ code: number | null; output: string }>;

/** A port a service's container publishes, with the services publishing it. */
export interface PublishedPort extends FirewallPort {
  services: string[];
}

/** One rule the runner added. `comment` is false when the firewall refused the mark. */
export interface RecordedRule extends FirewallPort {
  firewall: FirewallKind;
  comment: boolean;
}

export interface FirewallRecord {
  version: 1;
  rules: RecordedRule[];
}

export const EMPTY_RECORD: FirewallRecord = { version: 1, rules: [] };

export interface SyncDeps {
  exec: Exec;
  published: readonly PublishedPort[];
  record: FirewallRecord;
}

const same = (a: FirewallPort, b: FirewallPort) => a.port === b.port && a.protocol === b.protocol;
const spec = (rule: FirewallPort) => `${rule.port}/${rule.protocol}`;

function failure(output: string, code: number | null): string {
  const text = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(-2)
    .join(" ");
  return text || `exit code ${code ?? "none"}`;
}

// ---- Which firewall is active

/** Matches setup's firewall step: an INPUT chain that drops or rejects counts as active. */
const RESTRICTIVE_INPUT = /^-P INPUT (DROP|REJECT)|^-A INPUT .*-j (DROP|REJECT)/m;

export async function activeFirewall(exec: Exec): Promise<FirewallKind | null> {
  const ufw = await exec(["ufw", "status"]);
  if (ufw.code === 0 && /^status:\s*active/im.test(ufw.output)) return "ufw";
  const firewalld = await exec(["firewall-cmd", "--state"]);
  if (firewalld.code === 0 && /running/i.test(firewalld.output)) return "firewalld";
  const iptables = await exec(["iptables", "-S", "INPUT"]);
  if (iptables.code === 0 && RESTRICTIVE_INPUT.test(iptables.output)) return "iptables";
  return null;
}

// ---- The three firewalls

interface Presence {
  /** A rule of Nearzero's for exactly this port and protocol is there. */
  ours: boolean;
  /** Something else already allows the port. */
  others: boolean;
}

interface Driver {
  inspect(port: FirewallPort, recorded: RecordedRule | undefined): Promise<Presence>;
  add(port: FirewallPort): Promise<{ ok: true; comment: boolean } | { ok: false; error: string }>;
  remove(rule: RecordedRule): Promise<{ ok: true } | { ok: false; error: string }>;
}

/** One line of `ufw status numbered`. */
export interface UfwRule {
  number: number;
  to: string;
  v6: boolean;
  action: string;
  from: string;
  comment: string | null;
}

export function parseUfwNumbered(text: string): UfwRule[] {
  const rules: UfwRule[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const start = /^\[\s*(\d+)\]\s+/.exec(line);
    if (!start) continue;
    const rest = line.slice(start[0].length);
    const action = /\s(ALLOW|DENY|REJECT|LIMIT)(?:\s+(IN|OUT|FWD))?\s+/.exec(` ${rest}`);
    if (!action) continue;
    const toPart = ` ${rest}`.slice(0, action.index).trim();
    let fromPart = ` ${rest}`.slice(action.index + action[0].length).trim();
    let comment: string | null = null;
    const hash = fromPart.indexOf(" # ");
    if (hash >= 0) {
      comment = fromPart.slice(hash + 3).trim();
      fromPart = fromPart.slice(0, hash).trim();
    } else if (fromPart.startsWith("# ")) {
      comment = fromPart.slice(2).trim();
      fromPart = "";
    }
    const v6 = /\s\(v6\)$/.test(toPart);
    rules.push({
      number: Number(start[1]),
      to: toPart.replace(/\s\(v6\)$/, ""),
      v6,
      // Only rules for incoming traffic open a port.
      action:
        action[2] === "OUT" || action[2] === "FWD"
          ? `${action[1]} ${action[2]}`
          : (action[1] as string),
      from: fromPart.replace(/\s\(v6\)$/, ""),
      comment,
    });
  }
  return rules;
}

/** Whether a ufw "To" (like 9000/udp, 9000, 80,443/tcp or 6000:6010/tcp) covers the port. */
export function ufwCovers(to: string, port: FirewallPort): boolean {
  const match = /^([\d,:]+)(?:\/(tcp|udp))?$/.exec(to);
  if (!match) return false;
  if (match[2] && match[2] !== port.protocol) return false;
  return (match[1] as string).split(",").some((part) => {
    const [low, high] = part.split(":").map(Number);
    if (low === undefined || Number.isNaN(low)) return false;
    return high === undefined ? low === port.port : port.port >= low && port.port <= high;
  });
}

function ufw(exec: Exec): Driver {
  const rules = async () => {
    const answer = await exec(["ufw", "status", "numbered"]);
    return answer.code === 0 ? parseUfwNumbered(answer.output) : [];
  };
  const isOurs = (rule: UfwRule, port: FirewallPort, comment: boolean) =>
    rule.action === "ALLOW" &&
    rule.from === "Anywhere" &&
    rule.to === spec(port) &&
    (comment ? rule.comment === RULE_COMMENT : rule.comment === null);
  return {
    async inspect(port, recorded) {
      const list = await rules();
      const ours = list.some(
        (rule) =>
          isOurs(rule, port, true) || (recorded?.comment === false && isOurs(rule, port, false)),
      );
      const others = list.some(
        (rule) =>
          rule.action === "ALLOW" &&
          rule.from === "Anywhere" &&
          rule.comment !== RULE_COMMENT &&
          ufwCovers(rule.to, port) &&
          !(recorded?.comment === false && isOurs(rule, port, false)),
      );
      return { ours, others };
    },
    async add(port) {
      const marked = await exec(["ufw", "allow", spec(port), "comment", RULE_COMMENT]);
      if (marked.code === 0) return { ok: true, comment: true };
      // A ufw from before comments (0.35) refuses the mark.
      const plain = await exec(["ufw", "allow", spec(port)]);
      if (plain.code === 0) return { ok: true, comment: false };
      return { ok: false, error: failure(marked.output, marked.code) };
    },
    async remove(rule) {
      // Deleted by number, highest first, and only lines that are exactly Nearzero's.
      const numbers = (await rules())
        .filter((item) => isOurs(item, rule, rule.comment))
        .map((item) => item.number)
        .sort((a, b) => b - a);
      for (const number of numbers) {
        const deleted = await exec(["ufw", "--force", "delete", String(number)]);
        if (deleted.code !== 0) return { ok: false, error: failure(deleted.output, deleted.code) };
      }
      return { ok: true };
    },
  };
}

function firewalld(exec: Exec): Driver {
  const query = async (port: FirewallPort) =>
    (await exec(["firewall-cmd", "--permanent", `--query-port=${spec(port)}`])).code === 0;
  return {
    async inspect(port, recorded) {
      const present = await query(port);
      return { ours: present && recorded !== undefined, others: present && recorded === undefined };
    },
    async add(port) {
      for (const argv of [
        ["firewall-cmd", "--permanent", `--add-port=${spec(port)}`],
        ["firewall-cmd", `--add-port=${spec(port)}`],
      ]) {
        const answer = await exec(argv);
        if (answer.code !== 0) return { ok: false, error: failure(answer.output, answer.code) };
      }
      return { ok: true, comment: false };
    },
    async remove(rule) {
      if (!(await query(rule))) return { ok: true };
      for (const argv of [
        ["firewall-cmd", "--permanent", `--remove-port=${spec(rule)}`],
        ["firewall-cmd", `--remove-port=${spec(rule)}`],
      ]) {
        const answer = await exec(argv);
        if (answer.code !== 0) return { ok: false, error: failure(answer.output, answer.code) };
      }
      return { ok: true };
    },
  };
}

function iptables(exec: Exec): Driver {
  const match = (port: FirewallPort, comment: boolean) => [
    "-p",
    port.protocol,
    "--dport",
    String(port.port),
    ...(comment ? ["-m", "comment", "--comment", RULE_COMMENT] : []),
    "-j",
    "ACCEPT",
  ];
  const has = async (port: FirewallPort, comment: boolean) =>
    (await exec(["iptables", "-C", "INPUT", ...match(port, comment)])).code === 0;
  return {
    async inspect(port, recorded) {
      const marked = await has(port, true);
      const plain = await has(port, false);
      const plainIsOurs = recorded?.comment === false;
      return { ours: marked || (plainIsOurs && plain), others: plain && !plainIsOurs };
    },
    async add(port) {
      const marked = await exec(["iptables", "-I", "INPUT", "1", ...match(port, true)]);
      if (marked.code === 0) return { ok: true, comment: true };
      // Without the comment match module, the rule goes in plain (the record says it's ours).
      const plain = await exec(["iptables", "-I", "INPUT", "1", ...match(port, false)]);
      if (plain.code === 0) return { ok: true, comment: false };
      return { ok: false, error: failure(marked.output, marked.code) };
    },
    async remove(rule) {
      if (!(await has(rule, rule.comment))) return { ok: true };
      const answer = await exec(["iptables", "-D", "INPUT", ...match(rule, rule.comment)]);
      return answer.code === 0
        ? { ok: true }
        : { ok: false, error: failure(answer.output, answer.code) };
    },
  };
}

const DRIVERS: Record<FirewallKind, (exec: Exec) => Driver> = { ufw, firewalld, iptables };

// ---- One sync

/**
 * Makes the active firewall allow every published port and removes the rules Nearzero added for
 * ports nothing publishes. Answers what happened and the record to keep.
 */
export async function syncFirewall(
  deps: SyncDeps,
): Promise<{ answer: FirewallSyncAnswer; record: FirewallRecord }> {
  const kind = await activeFirewall(deps.exec);
  const record: FirewallRecord = { version: 1, rules: [...deps.record.rules] };
  if (!kind) {
    return {
      answer: {
        state: "none",
        firewall: null,
        ports: deps.published.map((port) => ({ ...port, result: "skipped" })),
        removed: [],
        notRemoved: [],
      },
      record,
    };
  }
  const driver = DRIVERS[kind](deps.exec);
  const ports: FirewallPortResult[] = [];
  const recordedFor = (port: FirewallPort) =>
    record.rules.find((rule) => rule.firewall === kind && same(rule, port));
  const forget = (port: FirewallPort) => {
    record.rules = record.rules.filter((rule) => !(rule.firewall === kind && same(rule, port)));
  };
  for (const port of deps.published) {
    const recorded = recordedFor(port);
    const presence = await driver.inspect(port, recorded);
    if (presence.ours) {
      // A mark found without a record (the record was lost) is Nearzero's all the same.
      if (!recorded) record.rules.push({ firewall: kind, ...pick(port), comment: true });
      ports.push({ ...port, result: "open" });
      continue;
    }
    if (presence.others) {
      // Someone else's rule: never recorded, so never removed.
      if (recorded) forget(port);
      ports.push({ ...port, result: "already" });
      continue;
    }
    const added = await driver.add(port);
    if (added.ok) {
      forget(port);
      record.rules.push({ firewall: kind, ...pick(port), comment: added.comment });
      ports.push({ ...port, result: "allowed" });
    } else {
      ports.push({ ...port, result: "failed", error: added.error });
    }
  }
  const removed: FirewallPort[] = [];
  const notRemoved: (FirewallPort & { error: string })[] = [];
  for (const rule of [...record.rules]) {
    if (rule.firewall !== kind) continue;
    if (deps.published.some((port) => same(port, rule))) continue;
    const result = await driver.remove(rule);
    if (result.ok) {
      forget(rule);
      removed.push(pick(rule));
    } else {
      notRemoved.push({ ...pick(rule), error: result.error });
    }
  }
  return { answer: { state: "changed", firewall: kind, ports, removed, notRemoved }, record };
}

function pick(port: FirewallPort): FirewallPort {
  return { port: port.port, protocol: port.protocol };
}

// ---- What the Engine publishes

/** A container's port bindings (from inspect): `"9000/udp": [{ HostIp, HostPort }]`. */
export type PortBindings = Record<string, { HostIp?: string; HostPort?: string }[] | null>;

/**
 * The ports the given containers publish on the host, with the services publishing each. A
 * binding to a loopback address isn't reachable from outside, so it isn't opened.
 */
export function publishedPorts(
  containers: readonly { service: string; bindings: PortBindings | null | undefined }[],
): PublishedPort[] {
  const found = new Map<string, PublishedPort>();
  for (const container of containers) {
    for (const [key, bindings] of Object.entries(container.bindings ?? {})) {
      const [, protocolText = "tcp"] = key.split("/");
      if (protocolText !== "tcp" && protocolText !== "udp") continue;
      for (const binding of bindings ?? []) {
        const ip = binding.HostIp ?? "";
        if (/^127\.|^::1$|^\[::1\]$/.test(ip)) continue;
        const port = Number(binding.HostPort);
        if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
        const id = `${port}/${protocolText}`;
        const entry = found.get(id) ?? { port, protocol: protocolText, services: [] };
        if (!entry.services.includes(container.service)) entry.services.push(container.service);
        found.set(id, entry);
      }
    }
  }
  return [...found.values()].sort(
    (a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol),
  );
}

export function readRecord(text: string | null): FirewallRecord {
  if (!text) return { ...EMPTY_RECORD, rules: [] };
  try {
    const parsed = JSON.parse(text) as Partial<FirewallRecord>;
    const rules = (Array.isArray(parsed.rules) ? parsed.rules : []).filter(
      (rule): rule is RecordedRule =>
        typeof rule === "object" &&
        rule !== null &&
        ["ufw", "firewalld", "iptables"].includes(rule.firewall) &&
        Number.isInteger(rule.port) &&
        (rule.protocol === "tcp" || rule.protocol === "udp"),
    );
    return {
      version: 1,
      rules: rules.map((rule) => ({ ...rule, comment: rule.comment !== false })),
    };
  } catch {
    return { ...EMPTY_RECORD, rules: [] };
  }
}
