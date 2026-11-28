import {
  type AuditItemView,
  formatBytes,
  passwordlessSudoMessage,
  type SetupFailureKind,
  sudoNotInstalledMessage,
  sudoTtyMessage,
} from "@nearzero/shared";

/**
 * Reading what servers answer during setup: the cloud images that refuse a user and name the
 * right one, sudo's refusals, the system facts, who holds the web ports, and the security audit
 * (spec 09 9.3, 9.4). Pure functions, so every message rule is unit tested.
 */

// ---- Wrong user and sudo

const ASKS_FOR_USER =
  /log ?in as (?:the )?user\s+\\?["'`]?([A-Za-z_][A-Za-z0-9_.-]{0,31})\\?["'`]?/i;

/**
 * The user a cloud image asks for instead, from its refusal ("Please login as the user "ubuntu"
 * rather than the user "root"."), or null.
 */
export function askedForUser(output: string, current: string): string | null {
  const match = ASKS_FOR_USER.exec(output);
  const user = match?.[1]?.replace(/[.]+$/, "") ?? null;
  if (!user || user === current) return null;
  return user;
}

export type SudoProblem = "needs_password" | "not_installed" | "needs_tty";

/** Why `sudo -n true` failed, or null when it worked. */
export function sudoProblem(output: string, code: number | null): SudoProblem | null {
  if (code === 0) return null;
  const text = output.toLowerCase();
  if (/must have a tty|requiretty/.test(text)) return "needs_tty";
  if (code === 127 || /sudo: (command )?not found|sudo: not found|no such file/.test(text)) {
    return "not_installed";
  }
  return "needs_password";
}

export function sudoProblemMessage(problem: SudoProblem, user: string): string {
  if (problem === "not_installed") return sudoNotInstalledMessage(user);
  if (problem === "needs_tty") return sudoTtyMessage(user);
  return passwordlessSudoMessage(user);
}

// ---- Secrets in output

const SECRET_PATTERNS: RegExp[] = [
  /nzj1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{16,}/g,
  /nzr1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{16,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export const REDACTED = "[redacted]";

/** Cuts secrets out of text before it is stored or shown (spec 9.3: logs are cleaned). */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 6) out = out.split(secret).join(REDACTED);
  }
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

// ---- System facts

export type OsFamily = "debian" | "rhel" | "fedora" | "amazon" | "suse" | "arch" | "alpine";
export type InitSystem = "systemd" | "openrc" | "none";
export type Architecture = "amd64" | "arm64";

export interface OsRelease {
  id: string;
  idLike: string[];
  versionId: string;
  codename: string;
  ubuntuCodename: string;
  prettyName: string;
}

export interface SystemFacts {
  uid: number;
  user: string;
  os: OsRelease;
  family: OsFamily | null;
  /** uname -m as the server says it. */
  machine: string;
  architecture: Architecture | null;
  libc: "glibc" | "musl";
  init: InitSystem;
  hasBash: boolean;
  hasSudo: boolean;
  memoryKb: number;
  swapKb: number;
  diskFreeKb: number;
  /** Docker installed with Snap, which setup refuses. */
  snapDocker: boolean;
  /** The server is itself a container (no swap there). */
  container: boolean;
}

/** Parses /etc/os-release text (KEY=value, values optionally quoted). */
export function parseOsRelease(text: string): OsRelease {
  const values = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    let value = (match[2] ?? "").trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values.set(match[1] as string, value.replace(/\\(["$`\\])/g, "$1"));
  }
  return {
    id: (values.get("ID") ?? "").toLowerCase(),
    idLike: (values.get("ID_LIKE") ?? "")
      .toLowerCase()
      .split(/\s+/)
      .filter((item) => item !== ""),
    versionId: values.get("VERSION_ID") ?? "",
    codename: values.get("VERSION_CODENAME") ?? "",
    ubuntuCodename: values.get("UBUNTU_CODENAME") ?? "",
    prettyName: values.get("PRETTY_NAME") ?? values.get("NAME") ?? "",
  };
}

/** Which kind of system it is, or null for one setup doesn't support (spec 9.3). */
export function familyOf(os: OsRelease): OsFamily | null {
  const ids = [os.id, ...os.idLike];
  if (os.id === "alpine") return "alpine";
  if (os.id === "amzn") return "amazon";
  if (os.id === "fedora") return "fedora";
  if (["rhel", "centos", "rocky", "almalinux", "ol", "oracle", "centos-stream"].includes(os.id)) {
    return "rhel";
  }
  if (["debian", "ubuntu", "raspbian"].includes(os.id)) return "debian";
  if (["arch", "manjaro", "endeavouros"].includes(os.id)) return "arch";
  if (os.id.startsWith("opensuse") || ["sles", "sled", "suse"].includes(os.id)) return "suse";
  if (ids.some((id) => id === "debian" || id === "ubuntu")) return "debian";
  if (ids.some((id) => id === "rhel" || id === "centos")) return "rhel";
  if (ids.includes("fedora")) return "fedora";
  if (ids.some((id) => id === "suse" || id.startsWith("opensuse"))) return "suse";
  if (ids.includes("arch")) return "arch";
  return null;
}

export function architectureOf(machine: string): Architecture | null {
  const value = machine.trim().toLowerCase();
  if (value === "x86_64" || value === "amd64") return "amd64";
  // armv8l is a 32-bit userland on a 64-bit ARM CPU: arm64 binaries can't run there (B2-34).
  if (value === "aarch64" || value === "arm64") return "arm64";
  return null;
}

/** Splits `key=value` lines; later keys win. */
export function keyValues(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    if (!/^[a-z_][a-z0-9_]*$/.test(key)) continue;
    out.set(key, line.slice(index + 1).trim());
  }
  return out;
}

/** The text between `::<name>::begin` and `::<name>::end` lines. */
export function section(text: string, name: string): string {
  const begin = `::${name}::begin`;
  const end = `::${name}::end`;
  const start = text.indexOf(begin);
  if (start < 0) return "";
  const from = start + begin.length;
  const stop = text.indexOf(end, from);
  return text.slice(from, stop < 0 ? undefined : stop).replace(/^\r?\n/, "");
}

function number(value: string | undefined): number {
  const parsed = Number(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Reads the facts probe's answer (see FACTS_PROBE in steps.ts). */
export function parseFacts(text: string): SystemFacts {
  const values = keyValues(text.replace(/::os-release::begin[\s\S]*?::os-release::end/, ""));
  const os = parseOsRelease(section(text, "os-release"));
  const machine = values.get("arch") ?? "";
  const init: InitSystem =
    values.get("systemd") === "yes"
      ? "systemd"
      : values.get("openrc") === "yes"
        ? "openrc"
        : "none";
  return {
    uid: number(values.get("uid")),
    user: values.get("user") ?? "",
    os,
    family: familyOf(os),
    machine,
    architecture: architectureOf(machine),
    // The C library /bin/sh itself uses, not whether a musl loader is lying around (B2-33).
    libc:
      values.get("libc") === "musl" || (values.get("libc") === undefined && os.id === "alpine")
        ? "musl"
        : "glibc",
    init,
    hasBash: (values.get("bash") ?? "") !== "",
    hasSudo: (values.get("sudo") ?? "") !== "",
    memoryKb: number(values.get("mem_kb")),
    swapKb: number(values.get("swap_kb")),
    diskFreeKb: number(values.get("disk_free_kb")),
    snapDocker: values.get("snap_docker") === "yes",
    container: values.get("container") === "yes",
  };
}

// ---- Swap (spec 9.3 step 7)

const GB = 1024 * 1024;

/**
 * The swap file to add, in megabytes, or why none is added: twice the RAM, at least 2 GB and at
 * most 8 GB, only when there is no swap and the disk keeps 4 GB free after it.
 */
export function swapPlan(
  facts: Pick<SystemFacts, "memoryKb" | "swapKb" | "diskFreeKb">,
): { add: true; megabytes: number } | { add: false; reason: string } {
  if (facts.swapKb > 0) return { add: false, reason: "this server already has swap" };
  const wantedKb = Math.min(8 * GB, Math.max(2 * GB, facts.memoryKb * 2));
  const megabytes = Math.round(wantedKb / 1024);
  if (facts.diskFreeKb < wantedKb + 4 * GB) {
    return {
      add: false,
      reason: `the disk has ${formatBytes(facts.diskFreeKb * 1024)} free, and a ${formatBytes(wantedKb * 1024)} swap file would leave less than 4 GB`,
    };
  }
  return { add: true, megabytes };
}

// ---- Ports 80 and 443 (spec 9.3 step 3)

export interface PortHolder {
  port: 80 | 443;
  process: string;
}

/** Listeners on 80 and 443 from `ss -H -ltnp` or `netstat -ltnp` output. */
export function portHolders(text: string): PortHolder[] {
  const holders: PortHolder[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const local = /(?:^|\s)(?:[0-9a-fA-F.:[\]*%a-z]+)?:(80|443)\s/.exec(`${line} `);
    if (!local || !/LISTEN/i.test(line)) continue;
    const port = Number(local[1]) as 80 | 443;
    const ssName = /users:\(\("([^"]+)"/.exec(line)?.[1];
    // netstat names the program after "<pid>/", and may go on: "812/nginx: master p" (B2-37).
    const netstatName = /\s\d+\/([^\s:]+)/.exec(line)?.[1];
    const process = ssName ?? netstatName ?? "an unknown program";
    const key = `${port}:${process}`;
    if (seen.has(key)) continue;
    seen.add(key);
    holders.push({ port, process });
  }
  return holders;
}

/** Containers publishing 80 or 443, from `docker ps --format '{{.Names}}\t{{.Ports}}'`. */
export function containersPublishing(text: string): { name: string; port: 80 | 443 }[] {
  const out: { name: string; port: 80 | 443 }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [name, ports] = line.split("\t");
    if (!name || !ports) continue;
    for (const port of [80, 443] as const) {
      if (new RegExp(`:${port}->`).test(ports)) out.push({ name: name.trim(), port });
    }
  }
  return out;
}

export const ROUTER_CONTAINER_NAME = "nearzero-router";

/**
 * Whether the web ports are free or held by Nearzero's router; otherwise who holds them, in
 * words for the failure message.
 */
export function portVerdict(
  holders: PortHolder[],
  containers: { name: string; port: 80 | 443 }[],
): { ok: true; note: string } | { ok: false; holder: string } {
  for (const holder of holders) {
    if (holder.process === "docker-proxy" || holder.process === "dockerd") {
      const container = containers.find((item) => item.port === holder.port);
      if (!container || container.name === ROUTER_CONTAINER_NAME) continue;
      return { ok: false, holder: `the container "${container.name}" (port ${holder.port})` };
    }
    return { ok: false, holder: `${holder.process} (port ${holder.port})` };
  }
  return holders.length > 0
    ? { ok: true, note: "Ports 80 and 443 are held by Nearzero's router." }
    : { ok: true, note: "Ports 80 and 443 are free." };
}

// ---- Security audit (spec 9.4)

function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function firewallItem(text: string): AuditItemView {
  const ufw = section(text, "ufw").trim();
  const firewalld = section(text, "firewalld").trim();
  const iptables = lines(section(text, "iptables"));
  const label = "Firewall";
  // An active firewall that lets in whatever no rule mentions protects little (R3-07).
  if (/^status:\s*active/im.test(ufw)) {
    const incoming = /^default:.*?\b(\w+)\s*\(incoming\)/im.exec(ufw)?.[1]?.toLowerCase();
    if (incoming === "allow") {
      return {
        id: "firewall",
        label,
        state: "attention",
        value: "ufw is active but allows incoming traffic by default",
        recommendation:
          "Deny what no rule allows: sudo ufw allow OpenSSH, then sudo ufw default deny incoming. Setup already allowed 80/tcp, 443/tcp and 443/udp.",
      };
    }
    return {
      id: "firewall",
      label,
      state: "good",
      value: incoming ? "ufw is active and denies incoming traffic by default" : "ufw is active",
      recommendation: "Keep it on. Only SSH, 80 and 443 need to be open.",
    };
  }
  if (/^running$/im.test(firewalld)) {
    const values = keyValues(firewalld);
    const zone = values.get("zone") ?? "";
    const target = (values.get("target") ?? "").toUpperCase();
    if (target === "ACCEPT") {
      return {
        id: "firewall",
        label,
        state: "attention",
        value: `firewalld is running but its ${zone} zone accepts all incoming traffic`,
        recommendation: `Reject what no rule allows: sudo firewall-cmd --permanent --zone=${zone} --set-target=default, then sudo firewall-cmd --reload. Setup already allowed 80/tcp, 443/tcp and 443/udp.`,
      };
    }
    return {
      id: "firewall",
      label,
      state: "good",
      value:
        target === ""
          ? "firewalld is running"
          : "firewalld is running and rejects incoming traffic by default",
      recommendation: "Keep it on. Only SSH, 80 and 443 need to be open.",
    };
  }
  const policy = iptables.find((line) => line.startsWith("-P INPUT"));
  // Denying by default: a DROP or REJECT policy, or a rule that drops everything still left.
  const denies =
    (policy !== undefined && /-P INPUT (DROP|REJECT)/.test(policy)) ||
    iptables.some((line) => /^-A INPUT -j (DROP|REJECT)(\s|$)/.test(line));
  if (denies) {
    return {
      id: "firewall",
      label,
      state: "good",
      value: "iptables denies incoming traffic by default",
      recommendation: "Keep it. Only SSH, 80 and 443 need to be open.",
    };
  }
  if (iptables.some((line) => /^-A INPUT .*-j (DROP|REJECT)/.test(line))) {
    return {
      id: "firewall",
      label,
      state: "attention",
      value: "iptables filters some incoming traffic but allows the rest by default",
      recommendation:
        "Deny what no rule allows: after the rules for SSH, 80/tcp, 443/tcp and 443/udp, add iptables -A INPUT -j DROP (or set the INPUT policy to DROP), then save the rules with your distribution's tool.",
    };
  }
  const known = ufw !== "" || firewalld !== "" || iptables.length > 0;
  return {
    id: "firewall",
    label,
    state: known ? "attention" : "unknown",
    value: known ? "No host firewall is active" : "Couldn't read the firewall",
    recommendation:
      "Turn on a host firewall that allows only SSH, 80/tcp, 443/tcp and 443/udp (for example ufw: allow OpenSSH, 80/tcp and 443, then enable it), or make sure your cloud provider's firewall does.",
  };
}

function sshdValue(text: string, key: string): string | null {
  for (const line of lines(section(text, "sshd"))) {
    const [name, ...rest] = line.split(/\s+/);
    if (name?.toLowerCase() === key) return rest.join(" ").toLowerCase();
  }
  return null;
}

function passwordItem(text: string): AuditItemView {
  const password = sshdValue(text, "passwordauthentication");
  const keyboard = sshdValue(text, "kbdinteractiveauthentication");
  const label = "SSH password sign-in";
  if (password === null) {
    return {
      id: "ssh_password",
      label,
      state: "unknown",
      value: "Couldn't read the SSH configuration",
      recommendation: "Check that sshd is OpenSSH and that the SSH user can use sudo.",
    };
  }
  if (password === "no" && keyboard !== "yes") {
    return {
      id: "ssh_password",
      label,
      state: "good",
      value: "Off: only keys can sign in",
      recommendation: "Nothing to do.",
    };
  }
  return {
    id: "ssh_password",
    label,
    state: "attention",
    value: password === "yes" ? "On" : "Keyboard-interactive sign-in is on",
    recommendation:
      "Turn password sign-in off: run setup again, which allows keys only. Passwords can be guessed; keys can't.",
  };
}

function rootItem(text: string): AuditItemView {
  const value = sshdValue(text, "permitrootlogin");
  const label = "SSH root sign-in";
  if (value === null) {
    return {
      id: "ssh_root",
      label,
      state: "unknown",
      value: "Couldn't read the SSH configuration",
      recommendation: "Check that sshd is OpenSSH and that the SSH user can use sudo.",
    };
  }
  if (value === "no") {
    return {
      id: "ssh_root",
      label,
      state: "good",
      value: "Root can't sign in",
      recommendation: "Nothing to do.",
    };
  }
  if (["prohibit-password", "without-password", "forced-commands-only"].includes(value)) {
    return {
      id: "ssh_root",
      label,
      state: "good",
      value: "Root only with a key",
      recommendation: "Nothing to do. A dedicated non-root user with sudo is safer still.",
    };
  }
  return {
    id: "ssh_root",
    label,
    state: "attention",
    value: "Root can sign in with a password",
    recommendation: "Allow root only with a key: run setup again, which sets that.",
  };
}

function keysItem(text: string): AuditItemView {
  const keys = sshdValue(text, "pubkeyauthentication");
  const pam = sshdValue(text, "usepam");
  const label = "SSH key sign-in";
  if (keys === null) {
    return {
      id: "ssh_keys",
      label,
      state: "unknown",
      value: "Couldn't read the SSH configuration",
      recommendation: "Check that sshd is OpenSSH and that the SSH user can use sudo.",
    };
  }
  const withPam = pam === null ? "" : pam === "yes" ? ", with PAM" : ", without PAM";
  if (keys === "yes") {
    return {
      id: "ssh_keys",
      label,
      state: "good",
      value: `On${withPam}`,
      recommendation: "Nothing to do.",
    };
  }
  return {
    id: "ssh_keys",
    label,
    state: "attention",
    value: `Off${withPam}`,
    recommendation:
      "Turn key sign-in on (PubkeyAuthentication yes in sshd_config), then sign in with keys only: keys can't be guessed.",
  };
}

const BAN_SERVICES = ["fail2ban", "sshguard", "crowdsec"] as const;

/** The command that has a service start on boot, for the server's init system. */
function enableCommand(name: string, init: string | undefined): string {
  return init === "openrc" ? `sudo rc-update add ${name} default` : `sudo systemctl enable ${name}`;
}

/**
 * One running ban service, as the audit judges it (R3-07): fail2ban protects SSH only with an
 * SSH jail on, and a service that doesn't start on boot is gone after the next restart.
 */
function banVerdict(
  name: (typeof BAN_SERVICES)[number],
  services: Map<string, string>,
): Omit<AuditItemView, "id" | "label"> {
  const boot = services.get(`${name}_boot`) ?? "unknown";
  const init = services.get("init");
  if (name === "fail2ban") {
    const jails = services.get("fail2ban_jails");
    if (jails === undefined || jails === "?") {
      return {
        state: "unknown",
        value: "fail2ban running; couldn't read its jails",
        recommendation: "Check that its SSH jail is on: sudo fail2ban-client status.",
      };
    }
    const names = jails.split(",").filter((jail) => jail !== "");
    if (!names.some((jail) => /^ssh/i.test(jail))) {
      return {
        state: "attention",
        value: "fail2ban running, but its SSH jail is off",
        recommendation:
          "Turn on its SSH jail: add [sshd] with enabled = true to /etc/fail2ban/jail.local, then run sudo fail2ban-client reload.",
      };
    }
  }
  const protects = name === "crowdsec" ? `${name} running` : `${name} protects SSH`;
  if (boot === "no") {
    return {
      state: "attention",
      value: `${protects}, but doesn't start on boot`,
      recommendation: `Have it start on boot: ${enableCommand(name, init)}.`,
    };
  }
  return {
    state: "good",
    value: boot === "yes" ? `${protects} and starts on boot` : protects,
    recommendation: "Nothing to do.",
  };
}

function banItem(text: string): AuditItemView {
  const label = "Intrusion-ban service";
  const services = keyValues(section(text, "ban"));
  const verdicts = BAN_SERVICES.filter((name) => services.get(name) === "active").map((name) =>
    banVerdict(name, services),
  );
  // Any one service that protects SSH and starts on boot is enough.
  const best =
    verdicts.find((verdict) => verdict.state === "good") ??
    verdicts.find((verdict) => verdict.state === "attention") ??
    verdicts[0];
  if (best) return { id: "intrusion_ban", label, ...best };
  const installed = BAN_SERVICES.filter((name) => services.get(name) === "inactive");
  if (installed.length > 0) {
    return {
      id: "intrusion_ban",
      label,
      state: "attention",
      value: `${installed.join(", ")} installed but not running`,
      recommendation: `Start it and have it start on boot (for example: sudo systemctl enable --now ${installed[0]}).`,
    };
  }
  return {
    id: "intrusion_ban",
    label,
    state: "attention",
    value: "None running",
    recommendation:
      "Install fail2ban (or sshguard) so addresses that keep failing to sign in are blocked for a while.",
  };
}

/** Reads the audit probe's answer (see AUDIT_PROBE in audit.ts). Read-only on the server. */
export function parseAudit(text: string): AuditItemView[] {
  return [firewallItem(text), passwordItem(text), keysItem(text), rootItem(text), banItem(text)];
}

// ---- Failures of a step script

export interface ScriptFailure {
  /** What the step was doing when it stopped (its last ::nz-doing:: line). */
  doing: string | null;
  /** The command that failed, from the ERR trap. */
  command: string | null;
  /** The last line of output that looks like an error. */
  lastError: string | null;
}

const MARKER = /^::nz-(doing|note|skip|failed)::(.*)$/;

export type ScriptLine =
  | { kind: "text"; text: string }
  | { kind: "doing" | "note" | "skip"; text: string }
  | { kind: "failed"; exitCode: number; command: string };

/** One line of a step's output: plain text or one of the markers the step scripts print. */
export function scriptLine(line: string): ScriptLine {
  const match = MARKER.exec(line.trim());
  if (!match) return { kind: "text", text: line };
  const kind = match[1] as "doing" | "note" | "skip" | "failed";
  const rest = match[2] ?? "";
  if (kind === "failed") {
    const split = rest.indexOf("::");
    const code = Number(split >= 0 ? rest.slice(0, split) : rest);
    return {
      kind,
      exitCode: Number.isFinite(code) ? code : 1,
      command: split >= 0 ? rest.slice(split + 2).trim() : "",
    };
  }
  return { kind, text: rest.trim() };
}

/** A short cause for the failure message: the last error line, else the failed command. */
export function causeOf(failure: ScriptFailure): string {
  const error = failure.lastError?.trim();
  if (error) return error.length > 300 ? `${error.slice(0, 297)}...` : error;
  if (failure.command) return `"${failure.command}" failed`;
  return "the step ended without saying why";
}

/** Lines that read like an error, for the cause. */
export function looksLikeError(line: string): boolean {
  return /\b(error|failed|failure|cannot|can't|could not|couldn't|unable|denied|not found|no such|refused|timed out|invalid|unsupported|E: )/i.test(
    line,
  );
}

export type { SetupFailureKind };
