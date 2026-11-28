import { http3OffMessage, type RouterHttp3 } from "@nearzero/shared";

/**
 * The router's main settings (R3-23, spec 18.3): Traefik's static configuration, which Nearzero
 * passes as command-line options when it starts the router. Router files shows them read-only as
 * YAML, in Traefik's own names, so people see the entry points, certificate resolvers and global
 * options exactly as the router got them.
 */

/** Traefik's option names, which its command line takes in lowercase. */
const NAMES = new Map(
  [
    "checkNewVersion",
    "sendAnonymousUsage",
    "entryPoints",
    "advertisedPort",
    "certificatesResolvers",
    "httpChallenge",
    "entryPoint",
    "caServer",
    "accessLog",
    "filePath",
    "bufferingSize",
    "defaultMode",
  ].map((name) => [name.toLowerCase(), name]),
);

interface Node {
  value: string | null;
  children: Map<string, Node>;
}

function scalar(value: string): string {
  if (value === "true" || value === "false" || /^\d+$/.test(value)) return value;
  return JSON.stringify(value);
}

function render(node: Node, depth: number, out: string[]): void {
  for (const [key, child] of node.children) {
    const indent = "  ".repeat(depth);
    if (child.children.size > 0) {
      // `--accesslog=true` turns a section on; its options say the rest.
      out.push(`${indent}${key}:`);
      render(child, depth + 1, out);
    } else {
      out.push(`${indent}${key}: ${child.value === null ? "{}" : scalar(child.value)}`);
    }
  }
}

/** The command-line options as Traefik's YAML static configuration. */
export function optionsAsYaml(options: readonly string[]): string {
  const root: Node = { value: null, children: new Map() };
  for (const option of options) {
    if (!option.startsWith("--")) continue;
    const at = option.indexOf("=");
    const path = (at < 0 ? option.slice(2) : option.slice(2, at)).split(".");
    const value = at < 0 ? null : option.slice(at + 1);
    let node = root;
    for (const part of path) {
      const key = NAMES.get(part) ?? part;
      let next = node.children.get(key);
      if (!next) {
        next = { value: null, children: new Map() };
        node.children.set(key, next);
      }
      node = next;
    }
    node.value = value;
  }
  const out: string[] = [];
  render(root, 0, out);
  return out.join("\n");
}

/** Router files' read-only "Main settings": a short header, then the options as YAML. */
export function mainSettingsText(
  options: readonly string[],
  ports: { httpPort: number; httpsPort: number },
  http3: RouterHttp3 | null,
): string {
  const udp =
    http3 === null
      ? ""
      : http3.enabled
        ? `, and UDP ${ports.httpsPort} for HTTP/3`
        : `. ${http3OffMessage(http3.port, http3.blockedBy ?? "another program")}`;
  return [
    "# The router's main settings, as Nearzero sets them when it starts the router.",
    `# Inside the router's container, web listens on :8080 and websecure on :8443. The server's TCP ports ${ports.httpPort} and ${ports.httpsPort} are published onto them${udp}.`,
    optionsAsYaml(options),
    "",
  ].join("\n");
}
