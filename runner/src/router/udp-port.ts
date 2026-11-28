import { readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { NEARZERO_LABELS, ROUTER_CONTAINER } from "@nearzero/shared";
import type { DockerClient } from "../docker/client.ts";

/**
 * Who holds a UDP port on this server (R3-22): the router serves HTTP/3 on the server's UDP
 * HTTPS port, and when something else already has it the router starts without HTTP/3 and the
 * server's details name that program.
 *
 * - Another container publishing the port: Docker's list of containers says so.
 * - A program on the server: its socket is in /proc/net/udp (or udp6) with the port, and the
 *   process holding that socket has it among its file descriptors. A runner set up on a server
 *   reads the server's /proc itself; the Nearzero host's runner, which runs in a container, asks
 *   a short-lived helper container that sees the host's network and processes and only reads.
 */

/** The socket inodes bound to `port` in a /proc/net/udp or udp6 table. */
export function socketsOnPort(table: string, port: number): string[] {
  const wanted = port.toString(16).toUpperCase().padStart(4, "0");
  const out: string[] = [];
  for (const line of table.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    const local = fields[1];
    const inode = fields[9];
    if (!local || !inode) continue;
    if (local.slice(local.lastIndexOf(":") + 1).toUpperCase() === wanted) out.push(inode);
  }
  return out;
}

/** What a holder is called when the socket's process can't be found (a kernel socket). */
export const UNKNOWN_HOLDER = "another program";

/** The program holding the UDP port, read from a /proc (the server's own, or a test's). */
export async function procUdpHolder(procRoot: string, port: number): Promise<string | null> {
  const inodes = new Set<string>();
  for (const table of ["udp", "udp6"]) {
    const text = await readFile(join(procRoot, "net", table), "utf8").catch(() => "");
    for (const inode of socketsOnPort(text, port)) inodes.add(inode);
  }
  if (inodes.size === 0) return null;
  const wanted = new Set([...inodes].filter((inode) => inode !== "0").map((i) => `socket:[${i}]`));
  const pids = (await readdir(procRoot).catch(() => [] as string[])).filter((name) =>
    /^\d+$/.test(name),
  );
  for (const pid of pids) {
    const fds = await readdir(join(procRoot, pid, "fd")).catch(() => [] as string[]);
    for (const fd of fds) {
      const target = await readlink(join(procRoot, pid, "fd", fd)).catch(() => "");
      if (wanted.has(target)) {
        const comm = (await readFile(join(procRoot, pid, "comm"), "utf8").catch(() => "")).trim();
        return comm || UNKNOWN_HOLDER;
      }
    }
  }
  return UNKNOWN_HOLDER;
}

/**
 * The same search as a POSIX shell script for the helper container: $1 is the port, $2 a /proc
 * to read instead of the real one (tests). It prints the program's name, "?" when only the
 * socket was found, and nothing when the port is free.
 */
export const UDP_HOLDER_SCRIPT = `proc=/proc
[ -z "$2" ] || proc=$2
port=$(printf '%04X' "$1")
inodes=$(cat "$proc/net/udp" "$proc/net/udp6" 2>/dev/null | awk -v p=":$port" 'toupper($2) ~ (p "$") { print $10 }')
[ -n "$inodes" ] || exit 0
for inode in $inodes; do
  [ "$inode" = 0 ] && continue
  for d in "$proc"/[0-9]*; do
    if ls -l "$d/fd" 2>/dev/null | grep -qF "socket:[$inode]"; then
      cat "$d/comm" 2>/dev/null || echo "?"
      exit 0
    fi
  done
done
echo "?"`;

export const UDP_HOLDER_CONTAINER = `${ROUTER_CONTAINER}-udp-check`;

/**
 * The helper container: the router's image (Alpine's shell and awk), in the host's network and
 * process namespaces so it sees their sockets and processes, as root with only the right to read
 * other processes' descriptors, a read-only root filesystem and nothing mounted.
 */
export function udpHolderHelperConfig(image: string, port: number): Record<string, unknown> {
  return {
    Image: image,
    User: "0:0",
    Entrypoint: ["/bin/sh", "-c", UDP_HOLDER_SCRIPT, "sh", String(port)],
    Cmd: [],
    Labels: { [NEARZERO_LABELS.managed]: "true" },
    AttachStdin: false,
    OpenStdin: false,
    Tty: false,
    HostConfig: {
      NetworkMode: "host",
      PidMode: "host",
      CapDrop: ["ALL"],
      CapAdd: ["SYS_PTRACE", "DAC_READ_SEARCH"],
      // Reading another program's descriptors is a ptrace read, which AppArmor's default
      // container profile refuses for processes outside the container.
      SecurityOpt: ["no-new-privileges:true", "apparmor=unconfined"],
      ReadonlyRootfs: true,
      LogConfig: { Type: "json-file", Config: { "max-size": "1m", "max-file": "1" } },
    },
  };
}

interface PortSummary {
  PublicPort?: number;
  Type?: string;
}

/** Another container (not the router) that publishes the UDP port, by name. */
async function containerOnPort(docker: DockerClient, port: number): Promise<string | null> {
  const running = await docker.listContainers({ all: false });
  for (const container of running) {
    const name = (container.Names[0] ?? container.Id).replace(/^\//, "");
    if (name === ROUTER_CONTAINER || name.startsWith(`${ROUTER_CONTAINER}-`)) continue;
    const ports = (container as unknown as { Ports?: PortSummary[] }).Ports ?? [];
    if (ports.some((item) => item.Type === "udp" && item.PublicPort === port)) {
      return `the container ${name}`;
    }
  }
  return null;
}

async function helperUdpHolder(
  docker: DockerClient,
  image: string,
  port: number,
): Promise<string | null> {
  const name = UDP_HOLDER_CONTAINER;
  await docker.removeContainer(name, { force: true }).catch(() => {});
  await docker.createContainer(name, udpHolderHelperConfig(image, port));
  try {
    await docker.startContainer(name);
    await docker.waitContainer(name, "not-running");
    let text = "";
    for await (const chunk of await docker.logs(name, {
      follow: false,
      tail: "all",
      timestamps: false,
    })) {
      text += new TextDecoder().decode(chunk);
    }
    const answer = text.trim().split("\n").at(-1)?.trim() ?? "";
    if (answer === "") return null;
    return answer === "?" ? UNKNOWN_HOLDER : answer;
  } finally {
    await docker.removeContainer(name, { force: true }).catch(() => {});
  }
}

/**
 * Who holds the UDP port, or null when it is free. Docker's own proxy for a container that
 * publishes it is named by that container; Docker's proxy with no such container is the router's
 * own (on its way out) and doesn't count.
 */
export async function udpPortHolder(
  docker: DockerClient,
  options: { port: number; containerized: boolean; image: string; procRoot?: string },
): Promise<string | null> {
  const container = await containerOnPort(docker, options.port).catch(() => null);
  if (container) return container;
  const program = options.containerized
    ? await helperUdpHolder(docker, options.image, options.port)
    : await procUdpHolder(options.procRoot ?? "/proc", options.port);
  if (program === "docker-proxy") return null;
  return program;
}
