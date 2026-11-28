import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachedServicesText,
  missingChecksMessage,
  passwordlessSudoMessage,
  SETUP_MESSAGES,
  stepFailureMessage,
  sudoFixCommand,
  VALIDATION_VERDICTS,
  wrongUserMessage,
} from "@nearzero/shared";
import { TOOL_RELEASES } from "../../../runner/tools/pins.ts";
import { AUDIT_PROBE } from "../src/server-setup/audit.ts";
import { dueCleanup, nextCleanupAt } from "../src/server-setup/cleanup.ts";
import { AccessFailure, readFacts } from "../src/server-setup/connection.ts";
import {
  askedForUser,
  containersPublishing,
  familyOf,
  parseAudit,
  parseFacts,
  parseOsRelease,
  portHolders,
  portVerdict,
  redact,
  type SystemFacts,
  scriptLine,
  sudoProblem,
  sudoProblemMessage,
  swapPlan,
} from "../src/server-setup/parse.ts";
import {
  loadRunnerBinary,
  MissingRunnerError,
  parseSums,
  runnerFileName,
} from "../src/server-setup/runner-binaries.ts";
import {
  allScripts,
  basicToolsScript,
  dockerRepository,
  FACTS_PROBE,
  registerRunnerScript,
  remoteCommand,
  runnerEnvironmentLines,
  STEP_PRELUDE,
} from "../src/server-setup/scripts.ts";
import { classifyClientError, fingerprintOfHostKey } from "../src/server-setup/ssh.ts";
import { checksFrom, verdictOf } from "../src/server-setup/validation.ts";

/**
 * Server setup's rules that are easy to get wrong (spec 09 9.3, 9.4; 23.1 "Scripts are safe to
 * feed on standard input"): reading what servers answer, the exact failure words, and the
 * scripts themselves for every supported kind of system.
 */

const UBUNTU_RELEASE = `PRETTY_NAME="Ubuntu 24.04.3 LTS"
NAME="Ubuntu"
VERSION_ID="24.04"
VERSION_CODENAME=noble
ID=ubuntu
ID_LIKE=debian
UBUNTU_CODENAME=noble
`;

const ALPINE_RELEASE = `NAME="Alpine Linux"
ID=alpine
VERSION_ID=3.22.2
PRETTY_NAME="Alpine Linux v3.22"
`;

function factsText(release: string, extra: string): string {
  return `${extra}\n::os-release::begin\n${release}::os-release::end\n`;
}

describe("wrong user and sudo (spec 9.3 Failure messages)", () => {
  test("cloud images that refuse root name the user they want", () => {
    const ubuntu = 'Please login as the user "ubuntu" rather than the user "root".\n\n';
    expect(askedForUser(ubuntu, "root")).toBe("ubuntu");
    expect(
      askedForUser('Please login as the user "ec2-user" rather than the user "root".', "root"),
    ).toBe("ec2-user");
    expect(
      askedForUser('Please login as the user \\"admin\\" rather than the user \\"root\\".', "root"),
    ).toBe("admin");
    expect(askedForUser("Permission denied", "root")).toBeNull();
    expect(askedForUser('Please login as the user "ubuntu"', "ubuntu")).toBeNull();
  });

  test("the wrong-user message and button use the spec's words", () => {
    expect(wrongUserMessage("root", "ubuntu")).toBe(
      'This server does not allow logging in as "root". It asks for the user "ubuntu": change the server\'s SSH user to "ubuntu" and run setup again.',
    );
  });

  test("sudo's refusals are told apart", () => {
    expect(sudoProblem("sudo: a password is required\n", 1)).toBe("needs_password");
    expect(sudoProblem("sudo: a terminal is required to read the password", 1)).toBe(
      "needs_password",
    );
    expect(sudoProblem("mia is not in the sudoers file.", 1)).toBe("needs_password");
    expect(sudoProblem("sh: sudo: not found", 127)).toBe("not_installed");
    expect(sudoProblem("sudo: sorry, you must have a tty to run sudo", 1)).toBe("needs_tty");
    expect(sudoProblem("", 0)).toBeNull();
  });

  test("the passwordless sudo message carries the exact fix", () => {
    expect(sudoFixCommand("deploy")).toBe(
      "echo 'deploy ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/deploy",
    );
    expect(passwordlessSudoMessage("deploy")).toBe(
      "The user \"deploy\" needs passwordless sudo for setup. On the server, run: echo 'deploy ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/deploy, then run setup again.",
    );
    expect(sudoProblemMessage("needs_password", "deploy")).toBe(passwordlessSudoMessage("deploy"));
    expect(sudoProblemMessage("not_installed", "deploy")).toContain("sudo isn't installed");
  });

  test("a failed step reads as the spec's sentence", () => {
    expect(
      stepFailureMessage({
        number: 5,
        title: "Install Docker",
        reason: "Installing Docker from Docker's repository.",
        cause: "E: Unable to locate package docker-ce",
        exitCode: 100,
      }),
    ).toBe(
      "Setup stopped at step 5 (Install Docker): Installing Docker from Docker's repository. Cause: E: Unable to locate package docker-ce (exit code 100)",
    );
    expect(missingChecksMessage(["Runner", "Router"])).toBe(
      "Server setup did not complete. Missing: Runner, Router",
    );
  });
});

describe("SSH errors become the dialog's failures", () => {
  test("authentication, timeouts and network errors", () => {
    expect(
      classifyClientError({
        level: "client-authentication",
        message: "All configured authentication methods failed",
      }).kind,
    ).toBe("key_rejected");
    expect(
      classifyClientError({
        level: "client-timeout",
        message: "Timed out while waiting for handshake",
      }).kind,
    ).toBe("unreachable");
    const refused = classifyClientError({ code: "ECONNREFUSED", message: "connect ECONNREFUSED" });
    expect(refused.kind).toBe("unreachable");
    expect(refused.detail).toBe("connection refused");
    expect(
      classifyClientError({ code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND" }).detail,
    ).toBe("name not found");
  });

  test("host key fingerprints read like ssh-keygen's", () => {
    expect(fingerprintOfHostKey(new Uint8Array([1, 2, 3]))).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });
});

describe("system facts (spec 9.3 Supported systems)", () => {
  test("Ubuntu with systemd as a non-root user", () => {
    const facts = parseFacts(
      factsText(
        UBUNTU_RELEASE,
        "uid=1000\nuser=ubuntu\narch=aarch64\nbash=/usr/bin/bash\nsudo=/usr/bin/sudo\nsystemd=yes\nmem_kb=2000000\nswap_kb=0\ndisk_free_kb=40000000",
      ),
    );
    expect(facts.family).toBe("debian");
    expect(facts.architecture).toBe("arm64");
    expect(facts.libc).toBe("glibc");
    expect(facts.init).toBe("systemd");
    expect(facts.hasBash).toBe(true);
    expect(facts.os.prettyName).toBe("Ubuntu 24.04.3 LTS");
    expect(dockerRepository(facts.os)).toEqual({ distro: "ubuntu", codename: "noble" });
  });

  test("Alpine without bash is musl", () => {
    const facts = parseFacts(
      factsText(ALPINE_RELEASE, "uid=0\nuser=root\narch=x86_64\nbash=\ncontainer=yes"),
    );
    expect(facts.family).toBe("alpine");
    expect(facts.libc).toBe("musl");
    expect(facts.hasBash).toBe(false);
    expect(facts.init).toBe("none");
    expect(facts.container).toBe(true);
    expect(runnerFileName("amd64", "musl")).toBe("nearzero-runner-linux-x64-musl");
  });

  test("families of the supported systems, and the refusal for others", () => {
    const of = (text: string) => familyOf(parseOsRelease(text));
    expect(of("ID=debian\nVERSION_CODENAME=bookworm")).toBe("debian");
    expect(of("ID=raspbian")).toBe("debian");
    expect(of('ID=linuxmint\nID_LIKE="ubuntu debian"')).toBe("debian");
    expect(of('ID="rocky"\nID_LIKE="rhel centos fedora"')).toBe("rhel");
    expect(of("ID=almalinux")).toBe("rhel");
    expect(of('ID="ol"')).toBe("rhel");
    expect(of("ID=fedora")).toBe("fedora");
    expect(of('ID="amzn"\nID_LIKE="fedora"')).toBe("amazon");
    expect(of('ID="opensuse-leap"\nID_LIKE="suse opensuse"')).toBe("suse");
    expect(of('ID="sles"')).toBe("suse");
    expect(of("ID=arch")).toBe("arch");
    expect(of("ID=alpine")).toBe("alpine");
    expect(of("ID=gentoo")).toBeNull();
    expect(of("ID=freebsd")).toBeNull();
    expect(SETUP_MESSAGES.unsupportedSystem).toBe(
      "This script only supports Debian, Red Hat, Arch Linux, Alpine Linux, or SUSE based operating systems for now.",
    );
  });

  test("swap: twice the RAM, from 2 to 8 GB, only when there is none and disk allows", () => {
    const gb = 1024 * 1024;
    expect(swapPlan({ memoryKb: 1 * gb, swapKb: 0, diskFreeKb: 50 * gb })).toEqual({
      add: true,
      megabytes: 2048,
    });
    expect(swapPlan({ memoryKb: 3 * gb, swapKb: 0, diskFreeKb: 50 * gb })).toEqual({
      add: true,
      megabytes: 6144,
    });
    expect(swapPlan({ memoryKb: 16 * gb, swapKb: 0, diskFreeKb: 50 * gb })).toEqual({
      add: true,
      megabytes: 8192,
    });
    expect(swapPlan({ memoryKb: 2 * gb, swapKb: 1024, diskFreeKb: 50 * gb }).add).toBe(false);
    expect(swapPlan({ memoryKb: 2 * gb, swapKb: 0, diskFreeKb: 6 * gb }).add).toBe(false);
  });
});

describe("ports 80 and 443 (spec 9.3 step 3)", () => {
  test("free ports and Nearzero's own router pass", () => {
    expect(portVerdict([], [])).toEqual({ ok: true, note: "Ports 80 and 443 are free." });
    const ss =
      'LISTEN 0 4096 0.0.0.0:80 0.0.0.0:* users:(("docker-proxy",pid=811,fd=7))\nLISTEN 0 4096 [::]:443 [::]:* users:(("docker-proxy",pid=822,fd=7))';
    const containers = containersPublishing(
      "nearzero-router\t0.0.0.0:80->8080/tcp, 0.0.0.0:443->8443/tcp",
    );
    expect(portVerdict(portHolders(ss), containers).ok).toBe(true);
  });

  test("another program or container is named", () => {
    const nginx = 'LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=1200,fd=6))';
    expect(portVerdict(portHolders(nginx), [])).toEqual({ ok: false, holder: "nginx (port 80)" });
    const netstat =
      "tcp        0      0 0.0.0.0:443             0.0.0.0:*               LISTEN      977/caddy";
    expect(portVerdict(portHolders(netstat), [])).toEqual({
      ok: false,
      holder: "caddy (port 443)",
    });
    const proxy = 'LISTEN 0 4096 0.0.0.0:80 0.0.0.0:* users:(("docker-proxy",pid=5,fd=7))';
    expect(
      portVerdict(portHolders(proxy), containersPublishing("web\t0.0.0.0:80->80/tcp")),
    ).toEqual({
      ok: false,
      holder: 'the container "web" (port 80)',
    });
    expect(portHolders("LISTEN 0 128 0.0.0.0:8080 0.0.0.0:*")).toEqual([]);
    // B2-37: BusyBox netstat (Alpine has no ss) names the program with its title after a colon.
    const busybox =
      "tcp        0      0 0.0.0.0:80              0.0.0.0:*               LISTEN      812/nginx: master p";
    expect(portVerdict(portHolders(busybox), [])).toEqual({
      ok: false,
      holder: "nginx (port 80)",
    });
  });
});

describe("what the facts probe reads (B2-33, B2-34, B2-35)", () => {
  test("B2-34: a 32-bit ARM userland (armv8l) is refused like any other architecture", () => {
    expect(parseFacts(factsText(UBUNTU_RELEASE, "uid=0\narch=armv8l")).architecture).toBeNull();
    expect(parseFacts(factsText(UBUNTU_RELEASE, "uid=0\narch=aarch64")).architecture).toBe("arm64");
  });

  test("B2-33: the C library is the one /bin/sh uses, not a musl loader lying around", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nz1-probe-"));
    try {
      const run = async (interpreter: string, loader: boolean) => {
        const shell = join(dir, `sh-${interpreter.replace(/\W/g, "")}`);
        await writeFile(shell, `\u007fELF\u0002\u0001\u0001\u0000${interpreter}\u0000rest`);
        const probe = FACTS_PROBE.replace("head -c 4096 /bin/sh", `head -c 4096 ${shell}`).replace(
          "[ -e /lib/ld-musl-x86_64.so.1 ]",
          loader ? "true" : "false",
        );
        const result = Bun.spawnSync(["sh", "-c", probe], { stdout: "pipe" });
        return parseFacts(result.stdout.toString()).libc;
      };
      // A glibc system with the musl package installed is glibc (it used to get the musl runner).
      expect(await run("/lib64/ld-linux-x86-64.so.2", true)).toBe("glibc");
      expect(await run("/lib/ld-musl-x86_64.so.1", false)).toBe("musl");
      // A static /bin/sh falls back to the loader on disk.
      expect(await run("", true)).toBe("musl");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("a facts probe that didn't run (B2-35)", () => {
  test("says why, instead of calling the system unsupported", async () => {
    const session = (code: number, stdout = "", stderr = "") =>
      ({ exec: async () => ({ code, signal: null, stdout, stderr }) }) as unknown as Parameters<
        typeof readFacts
      >[0];
    const full = await readFacts(session(97)).catch((error: AccessFailure) => error);
    expect(full).toBeInstanceOf(AccessFailure);
    expect((full as AccessFailure).failure.message).toBe(
      "Nearzero couldn't read what system this server runs, so setup stopped before changing anything. Cause: its script couldn't be saved in the temporary folder (is /tmp full or read-only?). Fix it, then run setup again.",
    );
    const broken = await readFacts(session(2, "", "sh: 3: cannot fork")).catch(
      (error: AccessFailure) => error,
    );
    expect((broken as AccessFailure).failure.message).toContain(
      "Cause: it ended with exit code 2: sh: 3: cannot fork.",
    );
  });
});

describe("setup's checks read whole outputs (B2-36) and Tumbleweed's sshd settings (B2-38)", () => {
  const ubuntu = () =>
    parseFacts(factsText(UBUNTU_RELEASE, "uid=0\nuser=root\narch=x86_64\nbash=/bin/bash"));

  test("B2-36: no check pipes a command into grep -q, which pipefail turns into false negatives", () => {
    for (const script of allScripts(
      { facts: ubuntu(), user: "ubuntu", builders: TOOL_RELEASES },
      environment,
    )) {
      for (const line of codeLines(script)) {
        expect(line).not.toMatch(/\|\s*grep\s+-[a-zA-Z]*q/);
      }
    }
  });

  test("B2-36: an installed rclone is found however much it prints", () => {
    const script = `set -eEuo pipefail
rclone() { printf 'rclone v1.2.3\n'; yes '- extra line' | head -n 20000; }
installed=$(rclone version 2>/dev/null || true)
if grep -qx "rclone v1.2.3" <<<"$installed"; then echo found; else echo missing; fi`;
    for (let i = 0; i < 20; i++) {
      const result = Bun.spawnSync(["bash", "-c", script], { stdout: "pipe" });
      expect(result.stdout.toString().trim()).toBe("found");
    }
  });

  test("B2-38: with only the vendor sshd_config (openSUSE Tumbleweed), SSH is still hardened", () => {
    const script = allScripts(
      { facts: ubuntu(), user: "ubuntu", builders: TOOL_RELEASES },
      environment,
    ).find((item) => item.includes("Reading the SSH configuration")) as string;
    expect(script).toContain(
      'if [ ! -f "$cfg" ] && [ -f /usr/etc/ssh/sshd_config ]; then source_cfg=/usr/etc/ssh/sshd_config; fi',
    );
    expect(script).toContain('cp -p "$source_cfg" "$cfg.nearzero-backup"');
  });
});

describe("server wording (G3-08)", () => {
  test("one attached service is singular; a failed setup has its toast", () => {
    expect(attachedServicesText(1)).toBe("1 attached service");
    expect(attachedServicesText(3)).toBe("3 attached services");
    expect(SETUP_MESSAGES.failedToast).toBe("Setup failed");
  });
});

describe("step 14 hardens SSH as 0.1.x did and checks what applies to the setup user (G3-02)", () => {
  const script = () =>
    allScripts(
      {
        facts: parseFacts(
          factsText(UBUNTU_RELEASE, "uid=1000\nuser=ubuntu\narch=x86_64\nbash=/bin/bash"),
        ),
        user: "ubuntu",
        builders: TOOL_RELEASES,
      },
      environment,
    ).find((item) => item.includes("Reading the SSH configuration")) as string;

  test("the managed block sets every setting 0.1.x set", () => {
    for (const line of [
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "ChallengeResponseAuthentication no",
      "PubkeyAuthentication yes",
      "AuthenticationMethods publickey",
      "MaxAuthTries 3",
      "LoginGraceTime 30",
      "AllowAgentForwarding no",
      "X11Forwarding no",
      "AllowTcpForwarding $3",
      "GatewayPorts no",
      "PermitTunnel no",
      "PermitUserEnvironment no",
    ])
      expect(script()).toContain(`echo "${line}"`);
  });

  test("it reads the settings that apply to the setup user before anything replaces the old file", () => {
    const text = script();
    expect(text).toContain("setup_user='ubuntu'");
    expect(text).toContain(
      '"$sshd_bin" -T -f "$new" -C "user=$setup_user,host=localhost,addr=127.0.0.1"',
    );
    const check = text.indexOf("Checking the SSH settings that apply to");
    const replace = text.indexOf('mv -f "$new" "$cfg"');
    expect(check).toBeGreaterThan(0);
    expect(replace).toBeGreaterThan(check);
    expect(text).toContain(
      "The old configuration was kept. Remove that setting, then run setup again.",
    );
  });
});

describe("the security audit reads only (spec 9.4)", () => {
  test("a hardened server", () => {
    const items = parseAudit(
      "::ufw::begin\nStatus: active\nLogging: on (low)\nDefault: deny (incoming), allow (outgoing), disabled (routed)\n::ufw::end\n::firewalld::begin\n::firewalld::end\n::iptables::begin\n::iptables::end\n::sshd::begin\npasswordauthentication no\nkbdinteractiveauthentication no\npubkeyauthentication yes\nusepam yes\npermitrootlogin prohibit-password\n::sshd::end\n::ban::begin\ninit=systemd\nfail2ban=active\nfail2ban_boot=yes\nsshguard=absent\ncrowdsec=absent\nfail2ban_jails=sshd\n::ban::end\n",
    );
    expect(items.map((item) => [item.id, item.state, item.value])).toEqual([
      ["firewall", "good", "ufw is active and denies incoming traffic by default"],
      ["ssh_password", "good", "Off: only keys can sign in"],
      ["ssh_keys", "good", "On, with PAM"],
      ["ssh_root", "good", "Root only with a key"],
      ["intrusion_ban", "good", "fail2ban protects SSH and starts on boot"],
    ]);
  });

  test("an open server gets plain recommendations", () => {
    const items = parseAudit(
      "::ufw::begin\nStatus: inactive\n::ufw::end\n::iptables::begin\n-P INPUT ACCEPT\n::iptables::end\n::sshd::begin\npasswordauthentication yes\npermitrootlogin yes\n::sshd::end\n::ban::begin\nfail2ban=inactive\nsshguard=absent\ncrowdsec=absent\n::ban::end\n",
    );
    const byId = Object.fromEntries(items.map((item) => [item.id, item]));
    expect(byId.firewall?.state).toBe("attention");
    expect(byId.firewall?.recommendation).toContain("80/tcp");
    expect(byId.ssh_password?.state).toBe("attention");
    expect(byId.ssh_root?.value).toBe("Root can sign in with a password");
    expect(byId.intrusion_ban?.value).toBe("fail2ban installed but not running");
  });

  test("nothing readable is unknown, not good", () => {
    const items = parseAudit("");
    expect(items.find((item) => item.id === "ssh_password")?.state).toBe("unknown");
    expect(items.find((item) => item.id === "ssh_keys")?.state).toBe("unknown");
    expect(items.find((item) => item.id === "firewall")?.state).toBe("unknown");
  });
});

describe("R3-07: the audit says whether the ban service protects SSH and the firewall denies by default", () => {
  const ban = (lines: string) =>
    parseAudit(`::ban::begin\n${lines}\n::ban::end\n`).find((item) => item.id === "intrusion_ban");
  const firewall = (sections: string) =>
    parseAudit(sections).find((item) => item.id === "firewall");

  test("fail2ban running with its SSH jail off needs attention and says to turn the jail on", () => {
    const item = ban(
      "init=systemd\nfail2ban=active\nfail2ban_boot=yes\nsshguard=absent\ncrowdsec=absent\nfail2ban_jails=nginx-http-auth,recidive",
    );
    expect(item).toMatchObject({
      state: "attention",
      value: "fail2ban running, but its SSH jail is off",
      recommendation:
        "Turn on its SSH jail: add [sshd] with enabled = true to /etc/fail2ban/jail.local, then run sudo fail2ban-client reload.",
    });
    // No jails at all is the same.
    expect(ban("fail2ban=active\nfail2ban_boot=yes\nfail2ban_jails=")?.state).toBe("attention");
    // A jail it couldn't read isn't called good.
    expect(ban("fail2ban=active\nfail2ban_boot=yes\nfail2ban_jails=?")).toMatchObject({
      state: "unknown",
      value: "fail2ban running; couldn't read its jails",
    });
  });

  test("a ban service that doesn't start on boot needs attention, with the init system's command", () => {
    expect(
      ban("init=systemd\nfail2ban=active\nfail2ban_boot=no\nfail2ban_jails=sshd"),
    ).toMatchObject({
      state: "attention",
      value: "fail2ban protects SSH, but doesn't start on boot",
      recommendation: "Have it start on boot: sudo systemctl enable fail2ban.",
    });
    expect(ban("init=openrc\nsshguard=active\nsshguard_boot=no")).toMatchObject({
      state: "attention",
      value: "sshguard protects SSH, but doesn't start on boot",
      recommendation: "Have it start on boot: sudo rc-update add sshguard default.",
    });
    // Unknown start-on-boot (no init system) isn't held against it.
    expect(ban("init=none\nsshguard=active\nsshguard_boot=unknown")).toMatchObject({
      state: "good",
      value: "sshguard protects SSH",
    });
  });

  test("one service that protects SSH and starts on boot is enough", () => {
    expect(
      ban(
        "init=systemd\nfail2ban=active\nfail2ban_boot=yes\nsshguard=active\nsshguard_boot=yes\nfail2ban_jails=",
      ),
    ).toMatchObject({ state: "good", value: "sshguard protects SSH and starts on boot" });
  });

  test("an active firewall that allows incoming traffic by default is flagged", () => {
    const allowing = firewall(
      "::ufw::begin\nStatus: active\nDefault: allow (incoming), allow (outgoing), disabled (routed)\n::ufw::end\n",
    );
    expect(allowing).toMatchObject({
      state: "attention",
      value: "ufw is active but allows incoming traffic by default",
    });
    expect(allowing?.recommendation).toContain("sudo ufw default deny incoming");
    expect(
      firewall(
        "::ufw::begin\nStatus: active\nDefault: reject (incoming), allow (outgoing), disabled (routed)\n::ufw::end\n",
      )?.state,
    ).toBe("good");
    expect(
      firewall("::firewalld::begin\nrunning\nzone=trusted\ntarget=ACCEPT\n::firewalld::end\n"),
    ).toMatchObject({
      state: "attention",
      value: "firewalld is running but its trusted zone accepts all incoming traffic",
    });
    expect(
      firewall("::firewalld::begin\nrunning\nzone=public\ntarget=default\n::firewalld::end\n"),
    ).toMatchObject({
      state: "good",
      value: "firewalld is running and rejects incoming traffic by default",
    });
    // iptables dropping one address but accepting the rest by default…
    expect(
      firewall(
        "::iptables::begin\n-P INPUT ACCEPT\n-A INPUT -s 192.0.2.7/32 -j DROP\n::iptables::end\n",
      ),
    ).toMatchObject({
      state: "attention",
      value: "iptables filters some incoming traffic but allows the rest by default",
    });
    // …and denying what no rule allows.
    for (const rules of [
      "-P INPUT DROP\n-A INPUT -p tcp --dport 22 -j ACCEPT",
      "-P INPUT ACCEPT\n-A INPUT -p tcp --dport 22 -j ACCEPT\n-A INPUT -j REJECT --reject-with icmp-host-prohibited",
    ]) {
      expect(firewall(`::iptables::begin\n${rules}\n::iptables::end\n`)).toMatchObject({
        state: "good",
        value: "iptables denies incoming traffic by default",
      });
    }
  });

  test("SSH key sign-in and PAM are reported", () => {
    const keys = (lines: string) =>
      parseAudit(`::sshd::begin\n${lines}\n::sshd::end\n`).find((item) => item.id === "ssh_keys");
    expect(keys("pubkeyauthentication yes\nusepam no")).toMatchObject({
      state: "good",
      value: "On, without PAM",
    });
    expect(keys("pubkeyauthentication no\nusepam yes")).toMatchObject({
      state: "attention",
      value: "Off, with PAM",
    });
  });

  test("the probe itself reads fail2ban's jails, start on boot and ufw's default policy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nz-audit-"));
    try {
      const file = join(dir, "probe.sh");
      await writeFile(file, AUDIT_PROBE);
      // Stand-ins for the server's tools, as exported shell functions (PATH is reset by the
      // probe, functions aren't).
      const fakes: Record<string, string> = {
        pgrep: 'case "$*" in *fail2ban-server*) return 0 ;; *) return 1 ;; esac',
        // As fail2ban-client prints it, with tabs: "`- Jail list:<tab>nginx-http-auth, recidive".
        "fail2ban-client":
          "if [ \"$1\" = status ]; then printf '%s\\n' 'Status' '|- Number of jail:\t2' '`- Jail list:\tnginx-http-auth, recidive'; fi",
        systemctl: 'if [ "$1" = is-enabled ]; then echo enabled; fi',
        "rc-update": 'if [ "$1" = show ]; then echo " fail2ban | default"; fi',
        ufw: 'printf "Status: active\\nLogging: on (low)\\nDefault: deny (incoming), allow (outgoing), disabled (routed)\\n"',
        iptables: "echo '-P INPUT ACCEPT'",
        sshd: 'printf "passwordauthentication no\\nkbdinteractiveauthentication no\\npubkeyauthentication yes\\nusepam yes\\npermitrootlogin without-password\\n"',
      };
      const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
      for (const [name, body] of Object.entries(fakes))
        env[`BASH_FUNC_${name}%%`] = `() { ${body}; }`;
      const run = Bun.spawnSync(["bash", file], { env, stdout: "pipe", stderr: "pipe" });
      const output = run.stdout.toString();
      expect(output).toContain("fail2ban=active");
      expect(output).toContain("fail2ban_boot=yes");
      expect(output).toContain("fail2ban_jails=nginx-http-auth,recidive");
      const byId = Object.fromEntries(parseAudit(output).map((item) => [item.id, item]));
      expect(byId.intrusion_ban).toMatchObject({
        state: "attention",
        value: "fail2ban running, but its SSH jail is off",
      });
      expect(byId.firewall?.value).toBe("ufw is active and denies incoming traffic by default");
      expect(byId.ssh_keys?.value).toBe("On, with PAM");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("validation verdicts (spec 9.4)", () => {
  const allReady = [
    "docker_version=28.5.1",
    "compose_version=v2.40.0",
    "buildx_version=v0.29.1",
    "docker_security=[name=seccomp,profile=builtin name=cgroupns]",
    "swarm=inactive",
    "folders_missing=",
    "router_dir_owner=ubuntu",
    ...TOOL_RELEASES.map(
      (release) => `tool_${release.tool}_${release.version.replace(/\W/g, "_")}=${release.version}`,
    ),
    "rclone_version=v1.71.2",
    "network=nearzero-edge",
    "router=true|1000:1000|traefik:v3.7.18",
    "runner_installed=yes",
    "swap_kb=0",
    "docker_group=yes",
  ].join("\n");
  const runner = { online: true, version: "1.0.0-dev" };

  test("everything ready", () => {
    const checks = checksFrom(allReady, {
      user: "ubuntu",
      sudoWorks: true,
      runner,
      metricsRecently: true,
    });
    expect(checks.find((item) => item.id === "router")?.value).toBe(
      "Running as ubuntu (traefik:v3.7.18)",
    );
    expect(verdictOf(checks, "ready", null)).toEqual({
      ok: true,
      verdict: VALIDATION_VERDICTS.ready,
    });
  });

  test("missing mandatory checks are named", () => {
    const checks = checksFrom(allReady.replace("network=nearzero-edge", "network="), {
      user: "ubuntu",
      sudoWorks: true,
      runner: { online: false, version: null },
      metricsRecently: false,
    });
    expect(verdictOf(checks, "inactive", null).verdict).toBe(
      "Mandatory checks still missing: Private network, Runner",
    );
  });

  test("all checks pass but setup isn't finished", () => {
    const checks = checksFrom(allReady, {
      user: "ubuntu",
      sudoWorks: true,
      runner,
      metricsRecently: true,
    });
    expect(verdictOf(checks, "setup_failed", "SSH hardening failed").verdict).toBe(
      "Nearzero reports this server as Setup failed (SSH hardening failed). Finish setup before deploying.",
    );
  });

  test("root skips sudo and the Docker group", () => {
    const checks = checksFrom(allReady, {
      user: "root",
      sudoWorks: true,
      runner,
      metricsRecently: true,
    });
    expect(checks.some((item) => item.id === "docker_group")).toBe(false);
    expect(checks.find((item) => item.id === "sudo")?.value).toBe("Signed in as root");
  });

  test("an unknown mandatory check can't be confirmed", () => {
    expect(
      verdictOf(
        [{ id: "docker", label: "Docker", mandatory: true, state: "unknown", value: null }],
        null,
        null,
      ).verdict,
    ).toBe(VALIDATION_VERDICTS.unconfirmed);
  });
});

describe("the daily Docker cleanup runs at 23:50 server time (spec 9.4, 14.4)", () => {
  test("due from 23:50 for an hour, in the server's zone", () => {
    expect(dueCleanup(Date.parse("2026-11-25T23:52:00Z"), "UTC")).toEqual({
      localDate: "2026-11-25",
    });
    expect(dueCleanup(Date.parse("2026-11-25T23:49:00Z"), "UTC")).toBeNull();
    expect(dueCleanup(Date.parse("2026-11-26T01:00:00Z"), "UTC")).toBeNull();
    // B1-47: the late hour runs past midnight, for the day it belongs to.
    expect(dueCleanup(Date.parse("2026-11-26T00:05:00Z"), "UTC")).toEqual({
      localDate: "2026-11-25",
    });
    expect(dueCleanup(Date.parse("2026-11-26T00:45:00Z"), "UTC")).toEqual({
      localDate: "2026-11-25",
    });
    expect(dueCleanup(Date.parse("2026-11-26T00:51:00Z"), "UTC")).toBeNull();
    expect(dueCleanup(Date.parse("2026-11-25T18:55:00Z"), "Asia/Kolkata")).toEqual({
      localDate: "2026-11-25",
    });
    // 23:50 in India is 18:20 UTC.
    expect(dueCleanup(Date.parse("2026-11-25T18:25:00Z"), "Asia/Kolkata")).toEqual({
      localDate: "2026-11-25",
    });
    expect(nextCleanupAt(Date.parse("2026-11-25T10:00:00Z"), "UTC").toISOString()).toBe(
      "2026-11-25T23:50:00.000Z",
    );
    expect(nextCleanupAt(Date.parse("2026-11-25T23:55:00Z"), "UTC").toISOString()).toBe(
      "2026-11-26T23:50:00.000Z",
    );
  });
});

describe("secrets never reach the log", () => {
  test("join tokens, credentials, keys and named values are cut out", () => {
    const token =
      "nzj1.0f8e0a52-7d0b-4d0e-9a51-1f4b8c2d3e4f.c2VjcmV0LXRva2VuLXZhbHVlLWZvci10ZXN0cw";
    expect(redact(`joining with ${token} now`)).toBe("joining with [redacted] now");
    expect(
      redact("-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----"),
    ).toBe("[redacted]");
    expect(redact("password=hunter22 ok", ["hunter22"])).toBe("password=[redacted] ok");
  });

  test("markers from the step scripts", () => {
    expect(scriptLine("::nz-doing::Installing Docker")).toEqual({
      kind: "doing",
      text: "Installing Docker",
    });
    expect(scriptLine("::nz-failed::100::apt-get install -y docker-ce")).toEqual({
      kind: "failed",
      exitCode: 100,
      command: "apt-get install -y docker-ce",
    });
    expect(scriptLine("plain output")).toEqual({ kind: "text", text: "plain output" });
  });

  test("SHA256SUMS lines", () => {
    const sums = parseSums(
      `${"a".repeat(64)}  nearzero-runner-linux-x64\n${"b".repeat(64)} *nearzero-runner-linux-arm64\n`,
    );
    expect(sums.get("nearzero-runner-linux-x64")).toBe("a".repeat(64));
    expect(sums.get("nearzero-runner-linux-arm64")).toBe("b".repeat(64));
  });

  test("the image's runners are gzip-compressed and checked against the binary's sum", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nz-runners-"));
    try {
      const binary = new TextEncoder().encode("#!/bin/sh\necho runner\n".repeat(100));
      const sum = new Bun.CryptoHasher("sha256").update(binary).digest("hex");
      await writeFile(join(dir, "nearzero-runner-linux-arm64-musl.gz"), Bun.gzipSync(binary));
      await writeFile(join(dir, "SHA256SUMS"), `${sum}  nearzero-runner-linux-arm64-musl\n`);
      const loaded = await loadRunnerBinary(dir, "arm64", "musl");
      expect(loaded.sha256).toBe(sum);
      expect(loaded.file).toBe("nearzero-runner-linux-arm64-musl");
      expect(loaded.bytes).toEqual(binary);
      // A compressed file whose content doesn't match is never sent.
      await writeFile(
        join(dir, "nearzero-runner-linux-x64.gz"),
        Bun.gzipSync(new TextEncoder().encode("other")),
      );
      await writeFile(
        join(dir, "SHA256SUMS"),
        `${sum}  nearzero-runner-linux-arm64-musl\n${sum}  nearzero-runner-linux-x64\n`,
      );
      await expect(loadRunnerBinary(dir, "amd64", "glibc")).rejects.toBeInstanceOf(
        MissingRunnerError,
      );
      await expect(loadRunnerBinary(dir, "arm64", "glibc")).rejects.toThrow(
        "doesn't have the runner for this server (nearzero-runner-linux-arm64)",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---- The scripts themselves (spec 23.1)

const RELEASES: Record<string, string> = {
  debian: "ID=debian\nVERSION_CODENAME=bookworm\nPRETTY_NAME=Debian",
  ubuntu: UBUNTU_RELEASE,
  rhel: 'ID="rhel"\nID_LIKE="fedora"',
  rocky: 'ID="rocky"\nID_LIKE="rhel centos fedora"',
  fedora: "ID=fedora",
  amazon: 'ID="amzn"\nID_LIKE="fedora"',
  suse: 'ID="opensuse-leap"\nID_LIKE="suse opensuse"',
  arch: "ID=arch",
  alpine: ALPINE_RELEASE,
};

function factsFor(release: string, init: "systemd" | "openrc" | "none", uid: number): SystemFacts {
  return parseFacts(
    factsText(
      release,
      `uid=${uid}\nuser=${uid === 0 ? "root" : "ubuntu"}\narch=x86_64\nbash=/bin/bash\n${init === "systemd" ? "systemd=yes" : init === "openrc" ? "openrc=yes" : ""}`,
    ),
  );
}

const environment = {
  controlUrl: "https://nearzero.example.com",
  routerImage: null,
  acmeEmail: "ops@example.com",
  extra: {},
};

const cases: { name: string; scripts: string[] }[] = [];
for (const [name, release] of Object.entries(RELEASES)) {
  for (const init of ["systemd", "openrc", "none"] as const) {
    for (const uid of [0, 1000]) {
      const facts = factsFor(release, init, uid);
      cases.push({
        name: `${name}, ${init}, ${uid === 0 ? "root" : "ubuntu"}`,
        scripts: allScripts(
          { facts, user: uid === 0 ? "root" : "ubuntu", builders: TOOL_RELEASES },
          environment,
        ),
      });
    }
  }
}

/** Lines of shell code, without comments and the contents of quoted printf lines. */
function codeLines(script: string): string[] {
  return script
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

describe("every script is safe on standard input and checks each step (spec 23.1)", () => {
  test.each(cases)("$name", ({ scripts }) => {
    for (const script of scripts) {
      const lines = codeLines(script);
      // Standard input is /dev/null before anything runs.
      const firstLines = lines.slice(0, 3).join("\n");
      expect(firstLines).toContain("exec </dev/null");
      // Nothing reads input: no read builtin, no cat or head without a file, no interactive tools.
      for (const line of lines) {
        expect(line).not.toMatch(/(^|[;&|(]\s*|\b(then|do|else)\s+)read\s/);
        expect(line).not.toMatch(/\bcat\s*($|[|;)]|>(?!\s*&))/);
        expect(line).not.toMatch(/\bcat\s+-(\s|$)/);
        // No nested SSH client (it would read the script's input).
        expect(line).not.toMatch(/(^|[;&|(]\s*|\b(then|do|else)\s+|\$\()ssh\s/);
        // sudo as a command (not "command -v sudo") always has -n.
        if (/(^|[;&|(]\s*|\b(then|do|else)\s+|\$\()sudo\s/.test(line)) {
          expect(line).toMatch(/sudo -n\b|snap remove docker/);
        }
        if (/\bapt-get install\b/.test(line)) expect(line).toMatch(/apt-get install -y/);
        if (/\b(dnf|yum) install\b/.test(line)) expect(line).toMatch(/(dnf|yum) install -y/);
        if (/\bzypper\b.*\binstall\b/.test(line)) expect(line).toContain("--non-interactive");
        if (/\bpacman -S/.test(line)) {
          expect(line).toContain("--noconfirm");
          // Arch supports no partial upgrades: refresh and upgrade together (B2-31).
          expect(line).toMatch(/\bpacman -Syu\b/);
        }
        if (/\bapk add\b/.test(line)) expect(line).not.toMatch(/\s-i\b|--interactive/);
        // Options BusyBox lacks.
        expect(line).not.toMatch(
          /status=none|\bsed\s+-r\b|\bgrep\s+-[a-zA-Z]*P|\bxargs\s+-r\b|\bdate\s+-d\b|\bstat\s+--|\breadlink\s+-e\b|--no-run-if-empty/,
        );
      }
      // Steps run under bash with every command's status checked, or are the two sh probes.
      if (script.startsWith("set -eEuo pipefail")) {
        expect(script).toContain(`trap 'nz_rc=$?;`);
        expect(script).toContain("ERR");
      } else {
        expect([FACTS_PROBE.split("\n")[0], "exec </dev/null"]).toContain(script.split("\n")[0]);
      }
    }
  });
});

describe("running a script on the server", () => {
  test("it is saved privately and run from the file with no input", () => {
    const asRoot = remoteCommand({ shell: "bash", sudo: false });
    expect(asRoot).toStartWith("sh -c '");
    expect(asRoot).toContain("umask 077");
    expect(asRoot).toContain('bash "$f" </dev/null');
    expect(asRoot).not.toContain("sudo");
    const asUser = remoteCommand({ shell: "bash", sudo: true });
    expect(asUser).toContain('sudo -n -- bash "$f" </dev/null');
  });

  test("the join token travels only inside the script, never in the runner's settings", () => {
    const token =
      "nzj1.0f8e0a52-7d0b-4d0e-9a51-1f4b8c2d3e4f.c2VjcmV0LXRva2VuLXZhbHVlLWZvci10ZXN0cw";
    const script = registerRunnerScript({ init: "systemd", environment, joinToken: token });
    expect(script).toContain(`export NEARZERO_RUNNER_JOIN_TOKEN='${token}'`);
    expect(script).toContain("/usr/local/bin/nearzero-runner enroll");
    expect(script).toContain("unset NEARZERO_RUNNER_JOIN_TOKEN");
    expect(runnerEnvironmentLines(environment).join("\n")).not.toContain("nzj1");
    expect(runnerEnvironmentLines(environment)).toContain("NEARZERO_RUNNER_CONTAINERIZED='false'");
  });
});

describe("every script parses", () => {
  test.each(cases.filter((item) => item.name.endsWith("ubuntu")))("$name", ({ scripts }) => {
    for (const script of scripts) {
      const shell = script.startsWith("set -eEuo pipefail") ? "bash" : "sh";
      const checked = Bun.spawnSync([shell, "-n"], {
        stdin: new TextEncoder().encode(script),
        stderr: "pipe",
      });
      if (checked.exitCode !== 0) throw new Error(`${checked.stderr.toString()}\n${script}`);
    }
  });
});

describe("package installs wait for the lock and try again (R3-02, B2-07)", () => {
  /** Runs nz_pkg from the prelude with stand-ins for the package manager, ps and sleep. */
  function runPkg(stubs: string): { code: number; out: string } {
    const script = `${STEP_PRELUDE}
${stubs}
sleep() { :; }
nz_pkg apt-get install -y -q docker-ce
echo "exit=$?"
`;
    const result = Bun.spawnSync(["bash", "-c", script], { stdout: "pipe", stderr: "pipe" });
    return {
      code: result.exitCode,
      out: `${result.stdout.toString()}${result.stderr.toString()}`,
    };
  }

  test("a held package lock is waited for, with a line saying why", () => {
    const run = runPkg(`
busy=3
# dpkg at work; Ubuntu's idle unattended-upgrade-shutdown alone is no job (C2-06).
ps() { if [ "$busy" -gt 0 ]; then busy=$((busy - 1)); printf 'bash\nunattended-upgr\ndpkg\n'; else printf 'bash\nunattended-upgr\n'; fi; }
apt-get() { echo installed; }`);
    expect(run.code).toBe(0);
    expect(run.out).toContain(
      "::nz-note::Another package job is running (a fresh server often runs its automatic updates first); waiting up to 5 minutes for it to finish.",
    );
    expect(run.out).toContain("exit=0");
  });

  test("a failing install is tried 3 times, 10 seconds apart, then the step fails", () => {
    const flaky = runPkg(`
tries=0
ps() { printf 'bash\n'; }
apt-get() { tries=$((tries + 1)); [ "$tries" -ge 3 ]; }`);
    expect(flaky.out).toContain(
      "::nz-note::apt-get install failed (attempt 1/3); retrying in 10s...",
    );
    expect(flaky.out).toContain(
      "::nz-note::apt-get install failed (attempt 2/3); retrying in 10s...",
    );
    expect(flaky.out).toContain("exit=0");
    const broken = runPkg(`
ps() { printf 'bash\n'; }
apt-get() { return 100; }`);
    expect(broken.code).toBe(100);
    expect(broken.out).toContain("::nz-failed::100::");
    expect(broken.out).not.toContain("exit=");
  });

  test("every apt, dnf, zypper, pacman and apk command in setup goes through it", () => {
    const debian = basicToolsScript({
      facts: parseFacts(
        `uid=0\narch=x86_64\n::os-release::begin\n${UBUNTU_RELEASE}\n::os-release::end`,
      ),
      user: "root",
      builders: TOOL_RELEASES,
    });
    expect(debian).toContain(
      "nz_pkg apt-get update -q -o DPkg::Lock::Timeout=300\n  nz_pkg apt-get install -y -q -o DPkg::Lock::Timeout=300",
    );
    for (const { scripts } of cases) {
      for (const line of scripts.flatMap(codeLines)) {
        if (/^(exec|set|if command -v|command -v|export)\b/.test(line)) continue;
        if (
          /\b(apt-get (update|install)|dnf install|yum install|zypper .*install|pacman -S|apk add)\b/.test(
            line,
          )
        ) {
          expect(line).toMatch(
            // The bash bootstrap runs under plain sh, so it retries in its own loop.
            /nz_pkg (apt-get|dnf|yum|zypper|pacman|apk)\b|^until /,
          );
        }
      }
    }
  });
});
