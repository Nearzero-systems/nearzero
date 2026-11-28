import { PRIVATE_NETWORK } from "@nearzero/shared";
import { DEFAULT_BUILDERS_DIR, type ToolRelease } from "../../../../runner/tools/pins.ts";
import type { Architecture, InitSystem, OsFamily, OsRelease, SystemFacts } from "./parse.ts";
import { BUILDX_PLUGIN, COMPOSE_PLUGIN, type PinnedTool, RCLONE } from "./pins.ts";
import { shellQuote } from "./ssh.ts";

/**
 * The scripts setup runs on a server (spec 09 9.3, 23.1 "Scripts are safe to feed on standard
 * input"). Every one is generated here from the server's facts, so the rules hold everywhere:
 *
 * - A script is saved to a private temporary file and run from it, with standard input from
 *   /dev/null; the script itself starts with `exec </dev/null` too. Nothing in a script can read
 *   what follows it, and no step waits for input.
 * - Step scripts run under bash with `set -eEuo pipefail` and an ERR trap that names the failed
 *   command and its exit code, so every command's status is checked. Only the first probe and
 *   the bash bootstrap run under plain sh, for systems without bash yet (Alpine).
 * - They use options that BusyBox and GNU tools both have, and package managers in their
 *   non-interactive modes.
 * - Steps print markers the control plane reads: `::nz-doing::` (what it is doing, the reason in
 *   a failure message), `::nz-note::` (a line for the log), `::nz-skip::` (nothing to do).
 */

// ---- Where things live on a server

export const PATHS = {
  configDir: "/etc/nearzero",
  routerDir: "/etc/nearzero/router",
  runnerEnv: "/etc/nearzero/runner.env",
  stateDir: "/var/lib/nearzero-runner",
  workDir: "/var/lib/nearzero-runner/work",
  scratchDir: "/var/lib/nearzero/setup",
  libDir: "/usr/local/lib/nearzero",
  buildersDir: DEFAULT_BUILDERS_DIR,
  runnerBinary: "/usr/local/bin/nearzero-runner",
  runnerLauncher: "/usr/local/lib/nearzero/runner-launch",
  systemdUnit: "/etc/systemd/system/nearzero-runner.service",
  openrcService: "/etc/init.d/nearzero-runner",
  runnerLog: "/var/log/nearzero-runner.log",
  runnerPid: "/run/nearzero-runner.pid",
  dockerdLog: "/var/log/nearzero-dockerd.log",
  sshdConfig: "/etc/ssh/sshd_config",
} as const;

export const NETWORK_NAME = PRIVATE_NETWORK;
/** Where openSUSE Tumbleweed keeps sshd's settings when /etc has none (B2-38). */
const VENDOR_SSHD_CONFIG = "/usr/etc/ssh/sshd_config";

// ---- Running a script on the server

/**
 * The command line that runs a script given on standard input: the login shell (whatever it is)
 * starts sh, which saves the script to a private temporary file and then runs it with standard
 * input from /dev/null, as root through `sudo -n` when the user isn't root. Exit code 97 means
 * the script couldn't be saved.
 */
export function remoteCommand(options: { shell: "bash" | "sh"; sudo: boolean }): string {
  const run = `${options.sudo ? "sudo -n -- " : ""}${options.shell} "$f" </dev/null`;
  const inner = [
    "umask 077",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell expansion, not JavaScript.
    'f=$(mktemp "${TMPDIR:-/tmp}/nearzero-step.XXXXXX") || exit 97',
    'cat > "$f" || { rm -f "$f"; exit 97; }',
    run,
    "rc=$?",
    'rm -f "$f"',
    "exit $rc",
  ].join("; ");
  return `sh -c ${shellQuote(inner)}`;
}

/** The start of every step script (bash). */
export const STEP_PRELUDE = `set -eEuo pipefail
exec </dev/null
umask 022
export LC_ALL=C LANG=C DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a NEEDRESTART_SUSPEND=1
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
trap 'nz_rc=$?; printf "::nz-failed::%s::%s\\n" "$nz_rc" "$BASH_COMMAND" >&2; exit "$nz_rc"' ERR
nz_doing() { printf '::nz-doing::%s\\n' "$*"; }
nz_note() { printf '::nz-note::%s\\n' "$*"; }
nz_skip() { printf '::nz-skip::%s\\n' "$*"; }
nz_has() { command -v "$1" >/dev/null 2>&1; }
nz_sha256() { sha256sum "$1" | cut -d " " -f 1; }
nz_fetch() { curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 900 -o "$2" "$1"; }
nz_verify() {
  local got
  got=$(nz_sha256 "$1")
  if [ "$got" != "$2" ]; then
    echo "The download $1 has checksum $got, not the pinned $2, so it was not installed." >&2
    return 1
  fi
}
nz_lock_held() {
  local inode
  [ -e "$1" ] && [ -r "\${NZ_PROC_LOCKS:-/proc/locks}" ] || return 1
  inode=$(ls -di "$1" 2>/dev/null | awk '{print $1}')
  [ -n "$inode" ] || return 1
  awk -v inode="$inode" '{ for (i = 1; i <= NF; i++) if ($i ~ /^[0-9a-f]+:[0-9a-f]+:[0-9]+$/) { n = split($i, part, ":"); if (part[n] == inode) found = 1 } } END { exit !found }' "\${NZ_PROC_LOCKS:-/proc/locks}"
}
nz_pkg_busy() {
  local lock procs
  for lock in \${NZ_PKG_LOCKS:-/var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock /var/cache/apt/archives/lock /var/lib/rpm/.rpm.lock /lib/apk/db/lock}; do
    nz_lock_held "$lock" && return 0
  done
  procs=$(ps -e -o comm= 2>/dev/null || true)
  printf '%s\\n' "$procs" | grep -Ex '(apt|apt-get|aptitude|dpkg|dnf|dnf5|yum|rpm|zypper|pacman|apk)' >/dev/null
}
nz_kernel_modules_gone() {
  local running
  running=$(uname -r 2>/dev/null)
  [ -n "$running" ] && [ ! -d "\${NZ_ROOT:-}/usr/lib/modules/$running" ] && [ ! -d "\${NZ_ROOT:-}/lib/modules/$running" ] && [ -n "$(ls -A "\${NZ_ROOT:-}/usr/lib/modules" 2>/dev/null || true)" ]
}
nz_pkg() {
  local attempt=1 waited=0 rc
  while nz_pkg_busy && [ "$waited" -lt 300 ]; do
    if [ "$waited" -eq 0 ]; then nz_note "Another package job is running (a fresh server often runs its automatic updates first); waiting up to 5 minutes for it to finish."; fi
    sleep 5
    waited=$((waited + 5))
  done
  while :; do
    "$@" >/dev/null && return 0
    rc=$?
    if [ "$attempt" -ge 3 ]; then return "$rc"; fi
    nz_note "$1 $2 failed (attempt $attempt/3); retrying in 10s..."
    sleep 10
    attempt=$((attempt + 1))
  done
}
`;

/** A step that changes the server: the prelude, then its scratch folder, then the body. */
function stepScript(body: string): string {
  return `${STEP_PRELUDE}install -d -m 0755 ${PATHS.scratchDir}\n${body.trim()}\n`;
}

/** A script that only reads: the prelude and the body. */
function readOnlyScript(body: string): string {
  return `${STEP_PRELUDE}${body.trim()}\n`;
}

// ---- Before any step: who we are and what the system is (plain sh)

/**
 * The facts probe, run as the SSH user under plain sh (bash may not exist yet). Read-only.
 * Prints key=value lines and the os-release file between markers; parseFacts reads them.
 */
export const FACTS_PROBE = `exec </dev/null
echo "uid=$(id -u)"
echo "user=$(id -un)"
echo "arch=$(uname -m)"
echo "bash=$(command -v bash 2>/dev/null || true)"
echo "sudo=$(command -v sudo 2>/dev/null || true)"
if [ -d /run/systemd/system ]; then echo "systemd=yes"; fi
if command -v openrc >/dev/null 2>&1 && [ -d /run/openrc ]; then echo "openrc=yes"; fi
interp=$(head -c 4096 /bin/sh 2>/dev/null | tr -c 'A-Za-z0-9._/-' '\n' | grep -m 1 'ld-' || true)
case "$interp" in
  *ld-musl-*) echo "libc=musl" ;;
  *ld-linux*) echo "libc=glibc" ;;
  *) if [ -e /lib/ld-musl-x86_64.so.1 ] || [ -e /lib/ld-musl-aarch64.so.1 ]; then echo "libc=musl"; fi ;;
esac
if [ -e /.dockerenv ] || [ -e /run/.containerenv ]; then echo "container=yes"; fi
echo "mem_kb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
echo "swap_kb=$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
echo "disk_free_kb=$(df -Pk / 2>/dev/null | awk 'NR==2 {print $4}' || echo 0)"
if [ -e /snap/bin/docker ]; then echo "snap_docker=yes"; fi
echo "::os-release::begin"
cat /etc/os-release 2>/dev/null || cat /usr/lib/os-release 2>/dev/null || true
echo "::os-release::end"
`;

/**
 * Package manager commands run through nz_pkg (the prelude): it waits up to 5 minutes for
 * another package job (unattended upgrades, cloud-init) and tries 3 times, 10 seconds apart,
 * so a fresh cloud server and a passing mirror failure don't fail setup (R3-02). apt also waits
 * for its own lock. A job counts only while it holds a package manager's lock (read from
 * /proc/locks) or a package manager runs: Ubuntu's unattended-upgrade-shutdown, which waits
 * idle all the time, is no job (C2-06).
 */
const APT_LOCK = "-o DPkg::Lock::Timeout=300";

/** Installs bash where it is missing (Alpine), under plain sh, as root. */
export function bashBootstrap(family: OsFamily): string {
  const install: Record<OsFamily, string> = {
    alpine: "apk add --no-cache -q bash",
    debian: `apt-get update -q ${APT_LOCK} && apt-get install -y -q ${APT_LOCK} --no-install-recommends bash`,
    rhel: "if command -v dnf >/dev/null 2>&1; then dnf install -y -q bash; else yum install -y -q bash; fi",
    fedora: "dnf install -y -q bash",
    amazon:
      "if command -v dnf >/dev/null 2>&1; then dnf install -y -q bash; else yum install -y -q bash; fi",
    suse: "zypper --non-interactive --quiet install --no-recommends bash",
    arch: "pacman -Syu --noconfirm --needed bash",
  };
  return `exec </dev/null
set -e
export DEBIAN_FRONTEND=noninteractive
if command -v bash >/dev/null 2>&1; then exit 0; fi
n=1
until ${install[family]}; do
  if [ "$n" -ge 3 ]; then exit 1; fi
  echo "::nz-note::Installing bash failed (attempt $n/3); retrying in 10s..."
  n=$((n + 1))
  sleep 10
done
command -v bash >/dev/null 2>&1
`;
}

// ---- The steps

export interface ScriptInputs {
  facts: SystemFacts;
  /** The SSH user setup signs in as. */
  user: string;
  builders: readonly ToolRelease[];
}

function architecture(inputs: ScriptInputs): Architecture {
  return inputs.facts.architecture ?? "amd64";
}

function family(inputs: ScriptInputs): OsFamily {
  return inputs.facts.family ?? "debian";
}

/** Step 1. */
export function cleanupScript(): string {
  return stepScript(`
nz_doing "Removing temporary files from an earlier run"
found=no
for path in ${PATHS.scratchDir}/tool.* ${PATHS.scratchDir}/rclone.* ${PATHS.scratchDir}/plugin.* ${PATHS.runnerBinary}.new ${PATHS.runnerEnv}.new ${PATHS.sshdConfig}.nearzero-new; do
  if [ -e "$path" ]; then rm -rf "$path"; found=yes; fi
done
for path in /tmp/nearzero-runner.upload.*; do
  if [ -e "$path" ]; then rm -f "$path"; found=yes; fi
done
if [ "$found" = yes ]; then nz_note "Removed leftovers from an earlier run."; else nz_note "Nothing was left over."; fi
nz_note "Running apps, databases and the router's routes are kept."
`);
}

const BASIC_TOOLS = ["curl", "wget", "git", "jq", "openssl", "tar", "gzip", "unzip"] as const;

function packageInstall(family: OsFamily, packages: string): string {
  switch (family) {
    case "debian":
      return `nz_pkg apt-get update -q ${APT_LOCK}
  nz_pkg apt-get install -y -q ${APT_LOCK} --no-install-recommends ${packages}`;
    case "rhel":
    case "amazon":
      return `if nz_has dnf; then nz_pkg dnf install -y -q ${packages}; else nz_pkg yum install -y -q ${packages}; fi`;
    case "fedora":
      return `nz_pkg dnf install -y -q ${packages}`;
    case "suse":
      return `nz_pkg zypper --non-interactive --quiet install --no-recommends ${packages}`;
    case "arch":
      return `nz_pkg pacman -Syu --noconfirm --needed ${packages}`;
    case "alpine":
      return `nz_pkg apk add --no-cache -q ${packages}`;
  }
}

function socketToolsPackage(family: OsFamily): string {
  return family === "rhel" || family === "fedora" || family === "amazon" ? "iproute" : "iproute2";
}

/** Step 2: curl, wget, git, jq, openssl and what setup itself uses. */
export function basicToolsScript(inputs: ScriptInputs): string {
  const fam = family(inputs);
  const runtimeLibraries =
    fam === "alpine"
      ? `if [ ! -e /usr/lib/libstdc++.so.6 ]; then extra="$extra libstdc++ libgcc"; fi`
      : "";
  return stepScript(`
nz_doing "Checking which basic tools are missing"
missing=""
for tool in ${BASIC_TOOLS.join(" ")}; do
  if ! nz_has "$tool"; then missing="$missing $tool"; fi
done
if ! nz_has ss && ! nz_has netstat; then missing="$missing ${socketToolsPackage(fam)}"; fi
extra=""
if [ ! -s /etc/ssl/certs/ca-certificates.crt ] && [ ! -s /etc/pki/tls/certs/ca-bundle.crt ] && [ ! -s /etc/ssl/ca-bundle.pem ]; then extra="$extra ca-certificates"; fi
${runtimeLibraries}
if [ -n "$missing$extra" ]; then
  nz_doing "Installing basic tools:$missing$extra"
  ${packageInstall(fam, "$missing $extra")}
fi
for tool in ${BASIC_TOOLS.join(" ")}; do
  if ! nz_has "$tool"; then echo "$tool is still missing after installing it." >&2; exit 1; fi
done
if [ -n "$missing" ]; then nz_note "Installed:$missing."; else nz_note "curl, wget, git, jq and openssl are installed."; fi
`);
}

/** Step 3: what listens on 80 and 443 (the control plane decides; see portVerdict). */
export function portsScript(): string {
  return readOnlyScript(`
nz_doing "Looking at what listens on ports 80 and 443"
echo "::listeners::begin"
if nz_has ss; then
  ss -H -ltnp 2>/dev/null || ss -ltnp 2>/dev/null || true
elif nz_has netstat; then
  netstat -ltnp 2>/dev/null || true
fi
echo "::listeners::end"
echo "::containers::begin"
if nz_has docker; then docker ps --format '{{.Names}}\t{{.Ports}}' 2>/dev/null || true; fi
echo "::containers::end"
`);
}

function pinnedAsset(tool: PinnedTool, arch: Architecture) {
  return tool.assets[arch];
}

/** Step 4: rclone, pinned and checked. */
export function rcloneScript(inputs: ScriptInputs): string {
  const asset = pinnedAsset(RCLONE, architecture(inputs));
  return stepScript(`
# The whole output is read before it is matched: under pipefail, grep -q leaving early made the
# version read as missing (B2-36).
installed=$(rclone version 2>/dev/null || true)
if nz_has rclone && grep -qx "rclone v${RCLONE.version}" <<<"$installed"; then
  nz_note "rclone ${RCLONE.version} is already installed."
  exit 0
fi
nz_doing "Downloading rclone ${RCLONE.version}"
tmp=$(mktemp -d ${PATHS.scratchDir}/rclone.XXXXXX)
nz_fetch ${shellQuote(asset.url)} "$tmp/rclone.zip"
nz_doing "Checking rclone's checksum"
nz_verify "$tmp/rclone.zip" ${asset.sha256}
nz_doing "Installing rclone ${RCLONE.version}"
unzip -q "$tmp/rclone.zip" -d "$tmp"
install -m 0755 "$tmp"/rclone-v${RCLONE.version}-linux-*/rclone /usr/local/bin/rclone
rm -rf "$tmp"
rclone version >/dev/null
nz_note "Installed rclone ${RCLONE.version}."
`);
}

/** Which of Docker's repositories serves this system, and its release name. */
export function dockerRepository(os: OsRelease): { distro: string; codename: string } {
  if (os.id === "ubuntu" || os.idLike.includes("ubuntu")) {
    return { distro: "ubuntu", codename: os.ubuntuCodename || os.codename };
  }
  if (os.id === "raspbian") return { distro: "raspbian", codename: os.codename };
  return { distro: "debian", codename: os.codename };
}

function dockerInstall(inputs: ScriptInputs): string {
  const fam = family(inputs);
  const os = inputs.facts.os;
  switch (fam) {
    case "debian": {
      const repo = dockerRepository(os);
      if (!repo.codename) {
        return `echo "This system doesn't name its release (VERSION_CODENAME), so Docker's repository can't be chosen." >&2; exit 1`;
      }
      const base = `https://download.docker.com/linux/${repo.distro}`;
      return `nz_doing "Adding Docker's signed apt repository"
install -m 0755 -d /etc/apt/keyrings
nz_fetch ${shellQuote(`${base}/gpg`)} /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
printf '%s\\n' "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] ${base} ${repo.codename} stable" > /etc/apt/sources.list.d/docker.list
nz_doing "Installing Docker from Docker's repository"
nz_pkg apt-get update -q ${APT_LOCK}
nz_pkg apt-get install -y -q ${APT_LOCK} docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin`;
    }
    case "fedora":
    case "rhel": {
      const repo = fam === "fedora" ? "fedora" : os.id === "rhel" ? "rhel" : "centos";
      return `nz_doing "Adding Docker's signed repository"
nz_fetch ${shellQuote(`https://download.docker.com/linux/${repo}/docker-ce.repo`)} /etc/yum.repos.d/docker-ce.repo
nz_doing "Installing Docker from Docker's repository"
if nz_has dnf; then
  nz_pkg dnf install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
  nz_pkg yum install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi`;
    }
    case "amazon":
      return `nz_doing "Installing Docker from Amazon Linux's repository"
if nz_has dnf; then nz_pkg dnf install -y -q docker; else nz_pkg yum install -y -q docker; fi`;
    case "suse":
      return `nz_doing "Installing Docker from the distribution's repository"
nz_pkg zypper --non-interactive --quiet install --no-recommends docker
nz_pkg zypper --non-interactive --quiet install --no-recommends docker-compose docker-buildx 2>/dev/null || true`;
    case "arch":
      return `nz_doing "Installing Docker from Arch Linux's repository"
nz_pkg pacman -Syu --noconfirm --needed docker docker-compose docker-buildx`;
    case "alpine":
      return `nz_doing "Installing Docker from Alpine's repository"
nz_pkg apk add --no-cache -q docker docker-cli-compose docker-cli-buildx`;
  }
}

function pluginInstall(tool: PinnedTool, arch: Architecture, command: string, file: string) {
  const asset = pinnedAsset(tool, arch);
  return `if ! docker ${command} version >/dev/null 2>&1; then
  nz_doing "Installing the Docker ${command} plugin ${tool.version}"
  tmp=$(mktemp -d ${PATHS.scratchDir}/plugin.XXXXXX)
  nz_fetch ${shellQuote(asset.url)} "$tmp/${file}"
  nz_verify "$tmp/${file}" ${asset.sha256}
  install -d -m 0755 /usr/local/lib/docker/cli-plugins
  install -m 0755 "$tmp/${file}" /usr/local/lib/docker/cli-plugins/${file}
  rm -rf "$tmp"
  nz_note "Installed the ${command} plugin ${tool.version}."
fi`;
}

function startService(init: InitSystem, name: string, direct: string): string {
  if (init === "systemd") return `systemctl enable --now ${name} >/dev/null 2>&1`;
  if (init === "openrc") {
    return `rc-update add ${name} default >/dev/null 2>&1 || true
if ! rc-service ${name} status >/dev/null 2>&1; then rc-service ${name} start >/dev/null; fi`;
  }
  return direct;
}

/** Step 5: Docker from the distribution's signed repository, Compose and buildx; never Snap. */
export function dockerScript(inputs: ScriptInputs): string {
  const arch = architecture(inputs);
  const init = inputs.facts.init;
  return stepScript(`
nz_doing "Checking how Docker is installed"
if [ -e /snap/bin/docker ] || { nz_has snap && snap list docker >/dev/null 2>&1; }; then
  nz_doing "Docker from Snap can't be used"
  echo "Docker on this server comes from Snap, whose sandbox hides Nearzero's folders. Remove it (sudo snap remove docker) and run setup again." >&2
  exit 41
fi
if nz_has docker && nz_has dockerd; then
  nz_note "Docker is already installed; keeping it and everything it runs."
else
${dockerInstall(inputs)}
fi
${pluginInstall(COMPOSE_PLUGIN, arch, "compose", "docker-compose")}
${pluginInstall(BUILDX_PLUGIN, arch, "buildx", "docker-buildx")}
nz_doing "Starting Docker"
if ! docker info >/dev/null 2>&1; then
  ${startService(
    init,
    "docker",
    `if nz_has setsid; then setsid nohup dockerd >>${PATHS.dockerdLog} 2>&1 </dev/null & else nohup dockerd >>${PATHS.dockerdLog} 2>&1 </dev/null & fi
  nz_note "This server has no init system, so Docker was started directly; after a reboot, run setup again to start it."`,
  )}
else
  ${init === "systemd" ? "systemctl enable docker >/dev/null 2>&1 || true" : init === "openrc" ? "rc-update add docker default >/dev/null 2>&1 || true" : ":"}
fi
nz_doing "Waiting for Docker to answer"
tries=0
until docker info >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -ge 60 ]; then
    if nz_kernel_modules_gone; then
      echo "Docker can't start until this server reboots: the package upgrade installed a new kernel and removed the running kernel's modules ($(uname -r)), which Docker needs. Reboot the server, then run setup again." >&2
      exit 1
    fi
    echo "Docker didn't start within 60 seconds." >&2
    exit 1
  fi
  sleep 1
done
nz_doing "Checking the Compose and buildx plugins"
docker compose version >/dev/null
docker buildx version >/dev/null
nz_note "Docker $(docker version --format '{{.Server.Version}}'), $(docker compose version --short 2>/dev/null || echo compose) and buildx are ready."
`);
}

/** Step 6, first part: the runtime and the private network; reports the installed runner. */
export function runtimeScript(): string {
  return stepScript(`
nz_doing "Checking the container runtime"
security=$(docker info --format '{{.SecurityOptions}}')
case "$security" in
  *rootless*)
    echo "Docker runs rootless here, which Nearzero doesn't support. Use the system's Docker Engine." >&2
    exit 42
    ;;
esac
nz_doing "Preparing Nearzero's private network"
if docker network inspect ${NETWORK_NAME} >/dev/null 2>&1; then
  nz_note "The private network ${NETWORK_NAME} already exists; keeping it."
else
  docker network create --label dev.nearzero.managed=true --label dev.nearzero.edition=1 ${NETWORK_NAME} >/dev/null
  nz_note "Created the private network ${NETWORK_NAME}."
fi
if [ -x ${PATHS.runnerBinary} ]; then
  echo "runner_sha256=$(nz_sha256 ${PATHS.runnerBinary})"
else
  echo "runner_sha256="
fi
`);
}

/** Step 6, second part: puts an uploaded runner in place after checking it. */
export function installRunnerScript(upload: string, sha256: string): string {
  return stepScript(`
nz_doing "Checking the runner's checksum"
nz_verify ${shellQuote(upload)} ${sha256}
nz_doing "Installing the runner"
install -d -m 0755 /usr/local/bin
install -m 0755 ${shellQuote(upload)} ${PATHS.runnerBinary}.new
mv -f ${PATHS.runnerBinary}.new ${PATHS.runnerBinary}
rm -f ${shellQuote(upload)}
nz_note "Installed $(${PATHS.runnerBinary} version)."
`);
}

export interface RunnerEnvironment {
  /** Always https:// (spec 31 "Remote runners are always encrypted"). */
  controlUrl: string;
  /** SHA-256 of Nearzero's own certificate at that address, when there is no domain. */
  controlFingerprint?: string | null;
  /**
   * Nearzero's own TLS port and its certificate's fingerprint, which the runner tries when
   * `controlUrl` stops answering (C4-06); written when `controlUrl` is the console's domain.
   */
  controlFallback?: { url: string; fingerprint: string | null } | null;
  routerImage: string | null;
  acmeEmail: string | null;
  /** The SSH user setup runs as: the server's tasks run as this user (R3-28). */
  serverUser?: string | null;
  /** Extra settings (tests point the router at a private ACME server). */
  extra: Record<string, string>;
}

/** The runner's settings file (no secrets: its credential is in its state folder). */
export function runnerEnvironmentLines(settings: RunnerEnvironment): string[] {
  const values: Record<string, string> = {
    NEARZERO_CONTROL_URL: settings.controlUrl,
    ...(settings.controlFingerprint
      ? { NEARZERO_CONTROL_FINGERPRINT: `sha256:${settings.controlFingerprint}` }
      : {}),
    ...(settings.controlFallback?.fingerprint
      ? {
          NEARZERO_CONTROL_FALLBACK_URL: settings.controlFallback.url,
          NEARZERO_CONTROL_FALLBACK_FINGERPRINT: `sha256:${settings.controlFallback.fingerprint}`,
        }
      : {}),
    NEARZERO_RUNNER_STATE_DIR: PATHS.stateDir,
    NEARZERO_RUNNER_WORK_DIR: PATHS.workDir,
    NEARZERO_RUNNER_CONTAINERIZED: "false",
    NEARZERO_ROUTER_DIR: PATHS.routerDir,
    NEARZERO_ROUTER_HOST_DIR: PATHS.routerDir,
    NEARZERO_BUILDERS_DIR: PATHS.buildersDir,
    NEARZERO_NETWORK: NETWORK_NAME,
    PATH: `${PATHS.buildersDir}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    ...(settings.routerImage ? { NEARZERO_ROUTER_IMAGE: settings.routerImage } : {}),
    ...(settings.acmeEmail ? { NEARZERO_ACME_EMAIL: settings.acmeEmail } : {}),
    ...(settings.serverUser ? { NEARZERO_SERVER_USER: settings.serverUser } : {}),
    ...settings.extra,
  };
  return Object.entries(values)
    .filter(([key, value]) => /^[A-Z_][A-Z0-9_]*$/.test(key) && !/[\n\r]/.test(value))
    .map(([key, value]) => `${key}=${shellQuote(value)}`);
}

function writeFile(path: string, lines: string[], mode: string): string {
  return `printf '%s\\n' ${lines.map(shellQuote).join(" ")} > ${path}.new
chmod ${mode} ${path}.new
mv -f ${path}.new ${path}`;
}

const SYSTEMD_UNIT = [
  "[Unit]",
  "Description=Nearzero runner",
  "Documentation=https://nearzero.dev",
  "After=network-online.target docker.service",
  "Wants=network-online.target docker.service",
  "",
  "[Service]",
  `ExecStart=${PATHS.runnerLauncher}`,
  "Restart=always",
  "RestartSec=5",
  "",
  "[Install]",
  "WantedBy=multi-user.target",
];

const OPENRC_SERVICE = [
  "#!/sbin/openrc-run",
  'description="Nearzero runner"',
  "supervisor=supervise-daemon",
  `command=${PATHS.runnerLauncher}`,
  `output_log=${PATHS.runnerLog}`,
  `error_log=${PATHS.runnerLog}`,
  "respawn_delay=5",
  "depend() {",
  "  need docker",
  "  after net",
  "}",
];

/** Step 6, third part: settings, the system service, and joining with a one-time token. */
export function registerRunnerScript(inputs: {
  init: InitSystem;
  environment: RunnerEnvironment;
  joinToken: string;
}): string {
  const launcher = [
    "#!/bin/sh",
    "set -a",
    `. ${PATHS.runnerEnv}`,
    "set +a",
    `exec ${PATHS.runnerBinary} run`,
  ];
  let service = "";
  if (inputs.init === "systemd") {
    service = `nz_doing "Installing the runner's system service"
${writeFile(PATHS.systemdUnit, SYSTEMD_UNIT, "0644")}
systemctl daemon-reload
systemctl enable nearzero-runner >/dev/null 2>&1
nz_note "The runner is a systemd service (nearzero-runner) that starts on boot."`;
  } else if (inputs.init === "openrc") {
    service = `nz_doing "Installing the runner's system service"
${writeFile(PATHS.openrcService, OPENRC_SERVICE, "0755")}
rc-update add nearzero-runner default >/dev/null 2>&1
nz_note "The runner is an OpenRC service (nearzero-runner) that starts on boot."`;
  } else {
    service = `nz_note "This server has no init system, so the runner is started directly; after a reboot, run setup again to start it."`;
  }
  return stepScript(`
nz_doing "Writing the runner's settings"
install -d -m 0755 ${PATHS.configDir} ${PATHS.libDir}
${writeFile(PATHS.runnerEnv, runnerEnvironmentLines(inputs.environment), "0600")}
${writeFile(PATHS.runnerLauncher, launcher, "0755")}
${service}
nz_doing "Joining Nearzero with a one-time token"
install -d -m 0700 ${PATHS.stateDir}
export NEARZERO_RUNNER_JOIN_TOKEN=${shellQuote(inputs.joinToken)}
set -a
. ${PATHS.runnerEnv}
set +a
${PATHS.runnerBinary} enroll
unset NEARZERO_RUNNER_JOIN_TOKEN
chmod 0700 ${PATHS.stateDir}
nz_note "The runner has its own credential, readable only by root."
`);
}

/** Step 7: a swap file of the planned size (see swapPlan); never in a container. */
export function swapScript(megabytes: number): string {
  return stepScript(`
if [ "$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo)" != "0" ]; then
  nz_skip "This server already has swap."
  exit 0
fi
nz_doing "Creating a ${megabytes} MB swap file"
if [ -e /swapfile ]; then swapoff /swapfile >/dev/null 2>&1 || true; rm -f /swapfile; fi
if ! { nz_has fallocate && fallocate -l ${megabytes}M /swapfile 2>/dev/null; }; then
  dd if=/dev/zero of=/swapfile bs=1048576 count=${megabytes} 2>/dev/null
fi
chmod 0600 /swapfile
mkswap /swapfile >/dev/null
if ! problem=$(swapon /swapfile 2>&1); then
  rm -f /swapfile
  nz_skip "Swap not added: $problem"
  exit 0
fi
if ! grep -q '^/swapfile ' /etc/fstab 2>/dev/null; then
  printf '%s\\n' '/swapfile none swap sw 0 0' >> /etc/fstab
fi
nz_note "Added a ${megabytes} MB swap file."
`);
}

/** Step 8: Nearzero's folders; the router's belongs to the setup user (spec 9.3 step 9). */
export function foldersScript(inputs: ScriptInputs): string {
  const owner = shellQuote(inputs.user);
  return stepScript(`
nz_doing "Creating Nearzero's folders"
owner=${owner}
group=$(id -gn "$owner")
install -d -m 0755 ${PATHS.configDir} ${PATHS.libDir} ${PATHS.buildersDir} /var/lib/nearzero ${PATHS.scratchDir}
install -d -m 0700 ${PATHS.stateDir} ${PATHS.workDir}
install -d -m 0755 ${PATHS.routerDir}
chown -R "$owner:$group" ${PATHS.routerDir}
nz_note "The router's folder ${PATHS.routerDir} belongs to $owner, and the router runs as that user."
`);
}

/** Step 9, server side: (re)starts the runner, which starts the router. */
export function startRunnerScript(init: InitSystem): string {
  let start: string;
  if (init === "systemd") {
    start = `systemctl daemon-reload
systemctl enable nearzero-runner >/dev/null 2>&1
systemctl restart nearzero-runner`;
  } else if (init === "openrc") {
    start = `rc-update add nearzero-runner default >/dev/null 2>&1 || true
if rc-service nearzero-runner status >/dev/null 2>&1; then rc-service nearzero-runner restart >/dev/null; else rc-service nearzero-runner start >/dev/null; fi`;
  } else {
    start = `if [ -f ${PATHS.runnerPid} ]; then
  old=$(cat ${PATHS.runnerPid})
  if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then kill "$old" 2>/dev/null || true; sleep 2; fi
fi
if nz_has setsid; then
  setsid nohup ${PATHS.runnerLauncher} >>${PATHS.runnerLog} 2>&1 </dev/null &
else
  nohup ${PATHS.runnerLauncher} >>${PATHS.runnerLog} 2>&1 </dev/null &
fi
printf '%s\\n' "$!" > ${PATHS.runnerPid}`;
  }
  return stepScript(`
nz_doing "Starting the runner"
${start}
nz_note "The runner started; it starts the router and keeps it running."
`);
}

/** The runner's recent log, for a failure's cause. */
export function runnerLogScript(init: InitSystem): string {
  return readOnlyScript(`
if [ "${init}" = systemd ] && nz_has journalctl; then
  journalctl -u nearzero-runner -n 30 --no-pager 2>/dev/null || true
elif [ -f ${PATHS.runnerLog} ]; then
  tail -n 30 ${PATHS.runnerLog}
fi
`);
}

/** Step 10: web ports in the host firewall, when one is active; never the monitoring port. */
export function firewallScript(): string {
  return stepScript(`
nz_doing "Checking the host firewall"
ufw_status=$(nz_has ufw && ufw status 2>/dev/null || true)
input_rules=$(nz_has iptables && iptables -S INPUT 2>/dev/null || true)
if grep -qi '^status: active' <<<"$ufw_status"; then
  nz_doing "Opening 80/tcp, 443/tcp and 443/udp in ufw"
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow 443/udp >/dev/null
  nz_note "Opened 80/tcp, 443/tcp and 443/udp in ufw."
elif nz_has firewall-cmd && firewall-cmd --state >/dev/null 2>&1; then
  nz_doing "Opening 80/tcp, 443/tcp and 443/udp in firewalld"
  firewall-cmd --permanent --add-port=80/tcp --add-port=443/tcp --add-port=443/udp >/dev/null
  firewall-cmd --reload >/dev/null
  nz_note "Opened 80/tcp, 443/tcp and 443/udp in firewalld."
elif grep -Eq '^-P INPUT (DROP|REJECT)|^-A INPUT .*-j (DROP|REJECT)' <<<"$input_rules"; then
  nz_doing "Opening 80/tcp, 443/tcp and 443/udp in iptables"
  for rule in "-p tcp --dport 80" "-p tcp --dport 443" "-p udp --dport 443"; do
    # shellcheck disable=SC2086
    iptables -C INPUT $rule -j ACCEPT 2>/dev/null || iptables -I INPUT 1 $rule -j ACCEPT
  done
  nz_note "Opened 80/tcp, 443/tcp and 443/udp in iptables. Save the rules with your distribution's tool to keep them after a reboot."
else
  nz_skip "No host firewall is active, so nothing needed opening."
fi
`);
}

/** Step 11: the builder tools at the versions in runner/tools/pins.ts. */
export function buildersScript(inputs: ScriptInputs): string {
  const arch = architecture(inputs);
  const linked = new Set<string>();
  const calls: string[] = [];
  for (const release of inputs.builders) {
    const asset = release.assets[arch];
    calls.push(
      `nz_tool ${release.tool} ${release.version} ${release.binary} ${shellQuote(asset.url)} ${asset.sha256}`,
    );
    if (!linked.has(release.tool)) {
      linked.add(release.tool);
      calls.push(
        `ln -sfn ../${release.tool}/${release.version}/${release.binary} "$dir/bin/${release.binary}"`,
      );
    }
  }
  return stepScript(`
dir=${PATHS.buildersDir}
install -d -m 0755 "$dir" "$dir/bin"
nz_tool() {
  local folder="$dir/$1/$2"
  if [ -x "$folder/$3" ] && [ "$(cat "$folder/.archive-sha256" 2>/dev/null || true)" = "$5" ]; then
    nz_note "$1 $2 is already installed."
    return 0
  fi
  nz_doing "Downloading $1 $2"
  local tmp
  tmp=$(mktemp -d ${PATHS.scratchDir}/tool.XXXXXX)
  nz_fetch "$4" "$tmp/archive.tar.gz"
  nz_doing "Checking the checksum of $1 $2"
  nz_verify "$tmp/archive.tar.gz" "$5"
  nz_doing "Unpacking $1 $2"
  rm -rf "$folder"
  install -d -m 0755 "$folder"
  tar -xzf "$tmp/archive.tar.gz" -C "$folder"
  if [ ! -f "$folder/$3" ]; then echo "$3 isn't in $4." >&2; return 1; fi
  chmod 0755 "$folder/$3"
  printf '%s\\n' "$5" > "$folder/.archive-sha256"
  rm -rf "$tmp"
  nz_note "Installed $1 $2."
}
${calls.join("\n")}
`);
}

/** Step 13: a non-root SSH user joins the docker group. */
export function dockerGroupScript(user: string): string {
  return stepScript(`
user=${shellQuote(user)}
if [ "$user" = root ]; then
  nz_skip "root doesn't need the Docker group."
  exit 0
fi
nz_doing "Adding $user to the Docker group"
if ! grep -q '^docker:' /etc/group; then
  if nz_has groupadd; then groupadd docker; else addgroup -S docker; fi
fi
groups=$(id -nG "$user" | tr ' ' '\\n')
if grep -qx docker <<<"$groups"; then
  nz_note "$user is already in the Docker group."
  exit 0
fi
if nz_has usermod; then
  usermod -aG docker "$user"
elif nz_has addgroup; then
  addgroup "$user" docker
else
  gpasswd -a "$user" docker >/dev/null
fi
nz_note "Added $user to the Docker group (it applies from the next sign-in)."
`);
}

function sshdReload(init: InitSystem): string {
  if (init === "systemd") {
    return `if systemctl is-active --quiet ssh 2>/dev/null; then systemctl reload ssh
elif systemctl is-active --quiet sshd 2>/dev/null; then systemctl reload sshd
else nz_note "SSH reads the new settings when it next starts."
fi`;
  }
  if (init === "openrc") {
    return `if rc-service sshd status >/dev/null 2>&1; then rc-service sshd reload >/dev/null; else nz_note "SSH reads the new settings when it next starts."; fi`;
  }
  return `pid=""
for file in /run/sshd.pid /var/run/sshd.pid; do
  if [ -z "$pid" ] && [ -s "$file" ]; then pid=$(cat "$file"); fi
done
if [ -z "$pid" ] && nz_has pgrep; then pid=$(pgrep -o sshd || true); fi
if [ -n "$pid" ]; then kill -HUP "$pid"; else nz_note "SSH reads the new settings when it next starts."; fi`;
}

/**
 * Step 14 (spec 9.3, G3-02): a managed block at the top of the SSH settings, so its values come
 * first and win over later lines and included files: key-only sign-in (passwords and keyboard
 * sign-in off, `AuthenticationMethods publickey`), root only with a key (never loosening a
 * stricter setting), `MaxAuthTries 3`, `LoginGraceTime 30`, agent and X11 forwarding off, TCP
 * forwarding local only, and no gateway ports, tunnels or user environment. The new file must
 * pass `sshd -t`; older OpenSSH that lacks a keyword gets the same block without it. Then the
 * settings that apply to the setup user are read (`sshd -T -C user=…`), so a later Match block
 * that turns passwords back on for that user is caught: the step fails and the old
 * configuration is kept. Only then does the new file replace the old one, which is kept for the
 * rollback.
 */
export function sshHardeningScript(init: InitSystem, user: string): string {
  return stepScript(`
nz_doing "Reading the SSH configuration"
sshd_bin=$(command -v sshd 2>/dev/null || true)
if [ -z "$sshd_bin" ] && [ -x /usr/sbin/sshd ]; then sshd_bin=/usr/sbin/sshd; fi
cfg=${PATHS.sshdConfig}
# openSUSE Tumbleweed ships only the vendor file; sshd reads /etc's copy once there is one, so
# setup writes the hardened copy there (B2-38).
source_cfg=$cfg
if [ ! -f "$cfg" ] && [ -f ${VENDOR_SSHD_CONFIG} ]; then source_cfg=${VENDOR_SSHD_CONFIG}; fi
if [ -z "$sshd_bin" ] || [ ! -f "$source_cfg" ]; then
  nz_skip "OpenSSH's server isn't installed here, so SSH was left as it is."
  exit 0
fi
setup_user=${shellQuote(user)}
current=$("$sshd_bin" -T 2>/dev/null || true)
root_now=$(printf '%s\\n' "$current" | awk '$1 == "permitrootlogin" {print $2}')
case "$root_now" in
  no) root_line="PermitRootLogin no" ;;
  forced-commands-only) root_line="PermitRootLogin forced-commands-only" ;;
  *) root_line="PermitRootLogin prohibit-password" ;;
esac
cp -p "$source_cfg" "$cfg.nearzero-backup"
new="$cfg.nearzero-new"
# $1: KbdInteractiveAuthentication (OpenSSH 8.7 and later), $2: ChallengeResponseAuthentication
# (its older name), $3: what AllowTcpForwarding takes ("local" from OpenSSH 7.4).
nz_write_config() {
  {
    echo "# Nearzero: begin (server setup: key-only sign-in, root only with a key)"
    echo "PasswordAuthentication no"
    if [ "$1" = yes ]; then echo "KbdInteractiveAuthentication no"; fi
    if [ "$2" = yes ]; then echo "ChallengeResponseAuthentication no"; fi
    echo "PubkeyAuthentication yes"
    echo "AuthenticationMethods publickey"
    echo "$root_line"
    echo "MaxAuthTries 3"
    echo "LoginGraceTime 30"
    echo "AllowAgentForwarding no"
    echo "X11Forwarding no"
    echo "AllowTcpForwarding $3"
    echo "GatewayPorts no"
    echo "PermitTunnel no"
    echo "PermitUserEnvironment no"
    echo "# Nearzero: end"
    awk '/^# Nearzero: begin/ {skip = 1} !skip {print} /^# Nearzero: end/ {skip = 0}' "$source_cfg"
  } > "$new"
  chmod 0644 "$new"
}
nz_doing "Checking the new SSH configuration"
problem=""
passed=no
for variant in "yes yes local" "yes no local" "no yes local" "no yes no"; do
  # shellcheck disable=SC2086
  nz_write_config $variant
  if attempt=$("$sshd_bin" -t -f "$new" 2>&1); then
    passed=yes
    break
  fi
  if [ -z "$problem" ]; then problem=$attempt; fi
done
if [ "$passed" != yes ]; then
  rm -f "$new"
  echo "The new SSH configuration didn't pass sshd -t, so the old one was kept: $problem" >&2
  exit 1
fi
nz_doing "Checking the SSH settings that apply to $setup_user"
effective=$("$sshd_bin" -T -f "$new" -C "user=$setup_user,host=localhost,addr=127.0.0.1" 2>/dev/null || true)
nz_setting() { printf '%s\\n' "$effective" | awk -v key="$1" '$1 == key {print $2; exit}'; }
if [ -z "$effective" ]; then
  rm -f "$new"
  echo "sshd couldn't report the settings that apply to $setup_user, so the old SSH configuration was kept." >&2
  exit 1
fi
open=""
if [ "$(nz_setting passwordauthentication)" != no ]; then open="$open PasswordAuthentication"; fi
kbd=$(nz_setting kbdinteractiveauthentication)
if [ -n "$kbd" ] && [ "$kbd" != no ]; then open="$open KbdInteractiveAuthentication"; fi
challenge=$(nz_setting challengeresponseauthentication)
if [ -n "$challenge" ] && [ "$challenge" != no ]; then open="$open ChallengeResponseAuthentication"; fi
if [ "$(nz_setting pubkeyauthentication)" != yes ]; then open="$open PubkeyAuthentication"; fi
if [ "$(nz_setting authenticationmethods)" != publickey ]; then open="$open AuthenticationMethods"; fi
if [ -n "$open" ]; then
  rm -f "$new"
  echo "SSH would still let $setup_user sign in without a key: a later part of the SSH configuration (often a Match block) sets$open for $setup_user. The old configuration was kept. Remove that setting, then run setup again." >&2
  exit 1
fi
mv -f "$new" "$cfg"
nz_doing "Reloading SSH"
if ! ( ${sshdReload(init).replace(/\n/g, "\n  ")} ); then
  cp -p "$cfg.nearzero-backup" "$cfg"
  echo "SSH didn't reload with the new configuration, so the old one was put back." >&2
  exit 1
fi
nz_note "SSH now accepts keys only, and root only with a key."
`);
}

/** Puts the SSH configuration from before step 14 back (when a new sign-in failed after it). */
export function sshRollbackScript(init: InitSystem): string {
  return stepScript(`
cfg=${PATHS.sshdConfig}
if [ -f "$cfg.nearzero-backup" ]; then
  cp -p "$cfg.nearzero-backup" "$cfg"
  ${sshdReload(init).replace(/\n/g, "\n  ")}
  nz_note "The SSH configuration from before setup was put back."
fi
`);
}

// ---- Validation and removal

/** Read-only checks after setup (spec 9.4); validation.ts reads the answer. */
export function validationScript(inputs: Pick<ScriptInputs, "user" | "builders">): string {
  const tools = inputs.builders
    .map(
      (release) =>
        `if [ -x ${PATHS.buildersDir}/${release.tool}/${release.version}/${release.binary} ]; then echo "tool_${release.tool}_${release.version.replace(/\W/g, "_")}=${release.version}"; else echo "tool_${release.tool}_${release.version.replace(/\W/g, "_")}="; fi`,
    )
    .join("\n");
  return readOnlyScript(`
set +e
trap - ERR
echo "docker_version=$(docker version --format '{{.Server.Version}}' 2>/dev/null)"
echo "compose_version=$(docker compose version --short 2>/dev/null)"
echo "buildx_version=$(docker buildx version 2>/dev/null | awk '{print $2}')"
echo "docker_security=$(docker info --format '{{.SecurityOptions}}' 2>/dev/null)"
echo "swarm=$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null)"
missing=""
for folder in ${PATHS.configDir} ${PATHS.routerDir} ${PATHS.stateDir} ${PATHS.buildersDir}; do
  [ -d "$folder" ] || missing="$missing $folder"
done
echo "folders_missing=$missing"
echo "router_dir_owner=$(stat -c %U ${PATHS.routerDir} 2>/dev/null)"
${tools}
echo "rclone_version=$(rclone version 2>/dev/null | head -n 1 | awk '{print $2}')"
echo "network=$(docker network inspect ${NETWORK_NAME} --format '{{.Name}}' 2>/dev/null)"
echo "router=$(docker inspect nearzero-router --format '{{.State.Running}}|{{.Config.User}}|{{.Config.Image}}' 2>/dev/null)"
echo "runner_installed=$([ -x ${PATHS.runnerBinary} ] && echo yes)"
echo "credential=$([ -s ${PATHS.stateDir}/credential ] && echo yes)"
echo "swap_kb=$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo)"
user=${shellQuote(inputs.user)}
if [ "$user" != root ]; then
  groups=$(id -nG "$user" 2>/dev/null | tr ' ' '\\n' || true)
  echo "docker_group=$(grep -qx docker <<<"$groups" && echo yes)"
fi
exit 0
`);
}

/** Stops and removes the runner's service and its credential (server deleted, spec 9.6). */
export function uninstallRunnerScript(init: InitSystem | "unknown"): string {
  return stepScript(`
set +e
trap - ERR
if nz_has systemctl && [ -d /run/systemd/system ]; then
  systemctl disable --now nearzero-runner >/dev/null 2>&1
  rm -f ${PATHS.systemdUnit}
  systemctl daemon-reload >/dev/null 2>&1
fi
if nz_has rc-service; then
  rc-service nearzero-runner stop >/dev/null 2>&1
  rc-update del nearzero-runner default >/dev/null 2>&1
  rm -f ${PATHS.openrcService}
fi
if [ -f ${PATHS.runnerPid} ]; then
  pid=$(cat ${PATHS.runnerPid})
  [ -n "$pid" ] && kill "$pid" >/dev/null 2>&1
  rm -f ${PATHS.runnerPid}
fi
rm -f ${PATHS.stateDir}/credential ${PATHS.runnerEnv} ${PATHS.runnerLauncher} ${PATHS.runnerBinary}
nz_note "Removed the runner (${init}) and its credential."
exit 0
`);
}

/** Every script setup can send for these facts, for the rule checks in the tests. */
export function allScripts(inputs: ScriptInputs, environment: RunnerEnvironment): string[] {
  return [
    FACTS_PROBE,
    bashBootstrap(family(inputs)),
    cleanupScript(),
    basicToolsScript(inputs),
    portsScript(),
    rcloneScript(inputs),
    dockerScript(inputs),
    runtimeScript(),
    installRunnerScript("/tmp/nearzero-runner.upload.abc123", "0".repeat(64)),
    registerRunnerScript({
      init: inputs.facts.init,
      environment,
      joinToken: "nzj1.00000000-0000-0000-0000-000000000000.example-token-for-tests",
    }),
    swapScript(2048),
    foldersScript(inputs),
    startRunnerScript(inputs.facts.init),
    runnerLogScript(inputs.facts.init),
    firewallScript(),
    buildersScript(inputs),
    dockerGroupScript(inputs.user),
    sshHardeningScript(inputs.facts.init, inputs.user),
    sshRollbackScript(inputs.facts.init),
    validationScript(inputs),
    uninstallRunnerScript(inputs.facts.init),
  ];
}
