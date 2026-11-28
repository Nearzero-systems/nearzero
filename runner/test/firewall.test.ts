import { describe, expect, test } from "bun:test";
import {
  EMPTY_RECORD,
  type Exec,
  type FirewallRecord,
  parseUfwNumbered,
  publishedPorts,
  syncFirewall,
  ufwCovers,
} from "../src/firewall/firewall.ts";

/**
 * Published ports in a remote server's host firewall (30b R2-13): against fake ufw, firewalld
 * and iptables that keep their rules the way the real tools print them.
 */

type Rule = { to: string; comment: string | null };

/** ufw as `ufw status numbered` shows it: each rule once for IPv4, then once for IPv6. */
function fakeUfw(initial: Rule[] = [], active = true) {
  let entries: (Rule & { v6: boolean })[] = [];
  const order = () => {
    entries = [...entries.filter((entry) => !entry.v6), ...entries.filter((entry) => entry.v6)];
  };
  for (const rule of initial) entries.push({ ...rule, v6: false }, { ...rule, v6: true });
  order();
  const calls: string[][] = [];
  const exec: Exec = async (argv) => {
    calls.push([...argv]);
    const [program, ...args] = argv;
    if (program !== "ufw") return { code: 127, output: `${program}: not found` };
    if (args.join(" ") === "status") {
      return { code: 0, output: active ? "Status: active\n" : "Status: inactive\n" };
    }
    if (args.join(" ") === "status numbered") {
      const body = entries
        .map((rule, index) => {
          const to = `${rule.to}${rule.v6 ? " (v6)" : ""}`.padEnd(27);
          const from = (rule.v6 ? "Anywhere (v6)" : "Anywhere").padEnd(27);
          const comment = rule.comment ? `# ${rule.comment}` : "";
          return `[${String(index + 1).padStart(2)}] ${to}ALLOW IN    ${from}${comment}`.trimEnd();
        })
        .join("\n");
      return {
        code: 0,
        output: `Status: active\n\n     To                         Action      From\n     --                         ------      ----\n${body}\n`,
      };
    }
    if (args[0] === "allow") {
      const comment = args[2] === "comment" ? (args[3] ?? null) : null;
      if (!entries.some((rule) => rule.to === args[1])) {
        entries.push({ to: args[1] as string, comment, v6: false });
        entries.push({ to: args[1] as string, comment, v6: true });
        order();
      }
      return { code: 0, output: "Rule added\nRule added (v6)\n" };
    }
    if (args[0] === "--force" && args[1] === "delete") {
      const index = Number(args[2]) - 1;
      if (!entries[index]) return { code: 1, output: "ERROR: Could not find rule" };
      entries.splice(index, 1);
      return { code: 0, output: "Rule deleted" };
    }
    return { code: 1, output: `unexpected ${argv.join(" ")}` };
  };
  return {
    get rules(): Rule[] {
      return entries.filter((entry) => !entry.v6).map(({ to, comment }) => ({ to, comment }));
    },
    get all() {
      return entries;
    },
    calls,
    exec,
  };
}

function fakeFirewalld(initial: string[] = []) {
  const permanent = new Set(initial);
  const runtime = new Set(initial);
  const calls: string[][] = [];
  const exec: Exec = async (argv) => {
    calls.push([...argv]);
    const [program, ...args] = argv;
    if (program === "ufw") return { code: 127, output: "ufw: not found" };
    if (program !== "firewall-cmd") return { code: 127, output: `${program}: not found` };
    if (args[0] === "--state") return { code: 0, output: "running\n" };
    const perm = args[0] === "--permanent";
    const option = (perm ? args[1] : args[0]) as string;
    const [name, value = ""] = option.split("=");
    const set = perm ? permanent : runtime;
    if (name === "--query-port")
      return set.has(value) ? { code: 0, output: "yes" } : { code: 1, output: "no" };
    if (name === "--add-port") {
      set.add(value);
      return { code: 0, output: "success" };
    }
    if (name === "--remove-port") {
      set.delete(value);
      return { code: 0, output: "success" };
    }
    return { code: 1, output: `unexpected ${argv.join(" ")}` };
  };
  return { permanent, runtime, calls, exec };
}

function fakeIptables(initial: string[] = [], policy = "DROP") {
  const input: string[] = [...initial];
  const calls: string[][] = [];
  const rule = (args: readonly string[]) => `-A INPUT ${args.join(" ")}`;
  const exec: Exec = async (argv) => {
    calls.push([...argv]);
    const [program, ...args] = argv;
    if (program !== "iptables") return { code: 127, output: `${program}: not found` };
    if (args[0] === "-S") {
      return { code: 0, output: [`-P INPUT ${policy}`, ...input].join("\n") };
    }
    if (args[0] === "-C") {
      return input.includes(rule(args.slice(2)))
        ? { code: 0, output: "" }
        : { code: 1, output: "Bad rule" };
    }
    if (args[0] === "-I") {
      input.unshift(rule(args.slice(3)));
      return { code: 0, output: "" };
    }
    if (args[0] === "-D") {
      const index = input.indexOf(rule(args.slice(2)));
      if (index < 0) return { code: 1, output: "Bad rule" };
      input.splice(index, 1);
      return { code: 0, output: "" };
    }
    return { code: 1, output: `unexpected ${argv.join(" ")}` };
  };
  return { input, calls, exec };
}

const udp9000 = { port: 9000, protocol: "udp" as const, services: ["svc-app"] };
const tcp5432 = { port: 5432, protocol: "tcp" as const, services: ["svc-db"] };

describe("ufw", () => {
  test("allows a published port with Nearzero's mark, leaves one someone already allowed, and removes only its own", async () => {
    const ufw = fakeUfw([
      { to: "5432/tcp", comment: null },
      { to: "22/tcp", comment: null },
    ]);
    const first = await syncFirewall({
      exec: ufw.exec,
      published: [udp9000, tcp5432],
      record: EMPTY_RECORD,
    });
    expect(first.answer.state).toBe("changed");
    expect(first.answer.firewall).toBe("ufw");
    expect(first.answer.ports.map((port) => [port.port, port.result])).toEqual([
      [9000, "allowed"],
      [5432, "already"],
    ]);
    expect(ufw.calls).toContainEqual(["ufw", "allow", "9000/udp", "comment", "nearzero"]);
    // Only what Nearzero added is in its record.
    expect(first.record.rules).toEqual([
      { firewall: "ufw", port: 9000, protocol: "udp", comment: true },
    ]);

    // A redeploy keeps it, and says it is already allowed.
    const again = await syncFirewall({
      exec: ufw.exec,
      published: [udp9000, tcp5432],
      record: first.record,
    });
    expect(again.answer.ports[0]?.result).toBe("open");
    expect(ufw.calls.filter((call) => call[1] === "allow")).toHaveLength(1);

    // Nothing publishes either port any more: Nearzero's rule goes (both halves), the
    // person's 5432/tcp and 22/tcp stay.
    const after = await syncFirewall({ exec: ufw.exec, published: [], record: again.record });
    expect(after.answer.removed).toEqual([{ port: 9000, protocol: "udp" }]);
    expect(after.answer.notRemoved).toEqual([]);
    expect(after.record.rules).toEqual([]);
    expect(ufw.rules).toEqual([
      { to: "5432/tcp", comment: null },
      { to: "22/tcp", comment: null },
    ]);
    expect(ufw.all).toHaveLength(4);
    // Deleted by number, highest first, so the second number still meant the same rule.
    const deletes = ufw.calls.filter((call) => call[2] === "delete").map((call) => Number(call[3]));
    expect(deletes).toEqual([6, 3]);
  });

  test("a mark found without a record is still Nearzero's", async () => {
    const ufw = fakeUfw([{ to: "9000/udp", comment: "nearzero" }]);
    const found = await syncFirewall({
      exec: ufw.exec,
      published: [udp9000],
      record: EMPTY_RECORD,
    });
    expect(found.answer.ports[0]?.result).toBe("open");
    expect(found.record.rules).toHaveLength(1);
    const gone = await syncFirewall({ exec: ufw.exec, published: [], record: found.record });
    expect(gone.answer.removed).toEqual([{ port: 9000, protocol: "udp" }]);
    expect(ufw.all).toEqual([]);
  });

  test("a person's rule for the same port is never removed", async () => {
    const ufw = fakeUfw([{ to: "9000", comment: null }]);
    const synced = await syncFirewall({
      exec: ufw.exec,
      published: [udp9000],
      record: EMPTY_RECORD,
    });
    expect(synced.answer.ports[0]?.result).toBe("already");
    expect(synced.record.rules).toEqual([]);
    await syncFirewall({ exec: ufw.exec, published: [], record: synced.record });
    expect(ufw.rules).toEqual([{ to: "9000", comment: null }]);
  });

  test("reads ufw's numbered list, IPv6 lines and comments included", () => {
    const rules = parseUfwNumbered(`Status: active

     To                         Action      From
     --                         ------      ----
[ 1] 22/tcp                     ALLOW IN    Anywhere
[ 2] 9000/udp                   ALLOW IN    Anywhere                   # nearzero
[ 3] 6000:6010/tcp              DENY IN     10.0.0.0/8
[ 4] 9000/udp (v6)              ALLOW IN    Anywhere (v6)              # nearzero
[ 5] 7000/tcp                   ALLOW OUT   Anywhere (out)
`);
    expect(rules).toEqual([
      { number: 1, to: "22/tcp", v6: false, action: "ALLOW", from: "Anywhere", comment: null },
      {
        number: 2,
        to: "9000/udp",
        v6: false,
        action: "ALLOW",
        from: "Anywhere",
        comment: "nearzero",
      },
      {
        number: 3,
        to: "6000:6010/tcp",
        v6: false,
        action: "DENY",
        from: "10.0.0.0/8",
        comment: null,
      },
      {
        number: 4,
        to: "9000/udp",
        v6: true,
        action: "ALLOW",
        from: "Anywhere",
        comment: "nearzero",
      },
      // An outgoing rule opens nothing for incoming traffic.
      {
        number: 5,
        to: "7000/tcp",
        v6: false,
        action: "ALLOW OUT",
        from: "Anywhere (out)",
        comment: null,
      },
    ]);
    expect(ufwCovers("6000:6010/tcp", { port: 6005, protocol: "tcp" })).toBe(true);
    expect(ufwCovers("6000:6010/tcp", { port: 6005, protocol: "udp" })).toBe(false);
    expect(ufwCovers("80,443", { port: 443, protocol: "udp" })).toBe(true);
    expect(ufwCovers("OpenSSH", { port: 22, protocol: "tcp" })).toBe(false);
  });
});

describe("firewalld", () => {
  test("adds the port for now and for good; one already open is left, and only Nearzero's is removed", async () => {
    const fw = fakeFirewalld(["5432/tcp"]);
    const first = await syncFirewall({
      exec: fw.exec,
      published: [udp9000, tcp5432],
      record: EMPTY_RECORD,
    });
    expect(first.answer.firewall).toBe("firewalld");
    expect(first.answer.ports.map((port) => port.result)).toEqual(["allowed", "already"]);
    expect([...fw.permanent].sort()).toEqual(["5432/tcp", "9000/udp"]);
    expect([...fw.runtime].sort()).toEqual(["5432/tcp", "9000/udp"]);
    const after = await syncFirewall({ exec: fw.exec, published: [], record: first.record });
    expect(after.answer.removed).toEqual([{ port: 9000, protocol: "udp" }]);
    expect([...fw.permanent]).toEqual(["5432/tcp"]);
    expect([...fw.runtime]).toEqual(["5432/tcp"]);
  });
});

describe("iptables", () => {
  test("counts as active when INPUT drops; adds a marked rule and removes only that one", async () => {
    const plain = "-A INPUT -p tcp --dport 5432 -j ACCEPT";
    const ipt = fakeIptables([plain]);
    const first = await syncFirewall({
      exec: ipt.exec,
      published: [udp9000, tcp5432],
      record: EMPTY_RECORD,
    });
    expect(first.answer.firewall).toBe("iptables");
    expect(first.answer.ports.map((port) => port.result)).toEqual(["allowed", "already"]);
    expect(ipt.input[0]).toBe(
      "-A INPUT -p udp --dport 9000 -m comment --comment nearzero -j ACCEPT",
    );
    const after = await syncFirewall({ exec: ipt.exec, published: [], record: first.record });
    expect(after.answer.removed).toEqual([{ port: 9000, protocol: "udp" }]);
    expect(ipt.input).toEqual([plain]);
  });

  test("an INPUT chain that accepts everything isn't a firewall to change", async () => {
    const ipt = fakeIptables([], "ACCEPT");
    const synced = await syncFirewall({
      exec: ipt.exec,
      published: [udp9000],
      record: EMPTY_RECORD,
    });
    expect(synced.answer).toEqual({
      state: "none",
      firewall: null,
      ports: [{ ...udp9000, result: "skipped" }],
      removed: [],
      notRemoved: [],
    });
    // Only looked at, never changed.
    expect(ipt.calls.filter((call) => call[0] === "iptables")).toEqual([
      ["iptables", "-S", "INPUT"],
    ]);
  });
});

describe("which firewall, and what is published", () => {
  test("ufw comes before firewalld and iptables; an inactive ufw is passed over", async () => {
    const calls: string[] = [];
    const exec: Exec = async (argv) => {
      calls.push(argv.join(" "));
      if (argv[0] === "ufw") return { code: 0, output: "Status: inactive" };
      if (argv[0] === "firewall-cmd") return { code: 252, output: "not running" };
      if (argv[0] === "iptables") return { code: 0, output: "-P INPUT ACCEPT" };
      return { code: 127, output: "" };
    };
    const record: FirewallRecord = {
      version: 1,
      rules: [{ firewall: "ufw", port: 9000, protocol: "udp", comment: true }],
    };
    const synced = await syncFirewall({ exec, published: [], record });
    expect(synced.answer.state).toBe("none");
    // A firewall that isn't active keeps its record; nothing is removed behind its back.
    expect(synced.record).toEqual(record);
    expect(calls).toEqual(["ufw status", "firewall-cmd --state", "iptables -S INPUT"]);
  });

  test("published ports come from the containers' bindings; loopback ones aren't opened", () => {
    expect(
      publishedPorts([
        {
          service: "a",
          bindings: {
            "9000/udp": [{ HostIp: "", HostPort: "9000" }],
            "80/tcp": [{ HostIp: "127.0.0.1", HostPort: "8088" }],
          },
        },
        { service: "b", bindings: { "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "20001" }] } },
        { service: "c", bindings: { "9000/udp": [{ HostIp: "::", HostPort: "9000" }] } },
        { service: "d", bindings: null },
      ]),
    ).toEqual([
      { port: 9000, protocol: "udp", services: ["a", "c"] },
      { port: 20001, protocol: "tcp", services: ["b"] },
    ]);
  });
});
