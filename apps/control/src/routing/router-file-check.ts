import { ROUTER_FILE_MAX_BYTES } from "@nearzero/shared";
import { isMap, isScalar, isSeq, LineCounter, type Node, type Pair, parseDocument } from "yaml";

/**
 * Checks a router file before it is saved (Settings → Router files, spec 18.3): first that it is
 * YAML, then that it follows the router's dynamic configuration (Traefik v3's file provider):
 * the sections, the kinds of routers, services and middlewares, and the fields each needs. The
 * first problem comes back with its line and reason, so nothing invalid reaches the router.
 *
 * The check covers the structure Traefik itself refuses or silently ignores (an unknown section,
 * a misspelled field, a router without a rule, a service of no known kind, a middleware of an
 * unknown type). Values inside a middleware's own settings are left to the router.
 */

export interface RouterFileProblem {
  /** 1-based; null only when the problem is the file as a whole. */
  line: number | null;
  reason: string;
}

/** "Line 4: …", or the reason alone. */
export function describeRouterFileProblem(problem: RouterFileProblem): string {
  return problem.line === null ? problem.reason : `Line ${problem.line}: ${problem.reason}`;
}

const HTTP_MIDDLEWARES = [
  "addPrefix",
  "basicAuth",
  "buffering",
  "chain",
  "circuitBreaker",
  "compress",
  "contentType",
  "digestAuth",
  "errors",
  "forwardAuth",
  "grpcWeb",
  "headers",
  "ipAllowList",
  "ipWhiteList",
  "inFlightReq",
  "passTLSClientCert",
  "plugin",
  "rateLimit",
  "redirectRegex",
  "redirectScheme",
  "replacePath",
  "replacePathRegex",
  "retry",
  "stripPrefix",
  "stripPrefixRegex",
];
const TCP_MIDDLEWARES = ["ipAllowList", "ipWhiteList", "inFlightConn"];

type Shape =
  | { kind: "string" }
  | { kind: "number" }
  | { kind: "boolean" }
  | { kind: "any" }
  | { kind: "strings" }
  | { kind: "list"; item: Shape }
  | { kind: "object"; fields: Record<string, Shape>; required?: string[]; oneOf?: string[] }
  /** A map from names people choose to entries of one shape. */
  | { kind: "named"; entry: Shape }
  /** A map with exactly one key from `types` (a middleware), whose value is any settings. */
  | { kind: "typed"; types: string[]; what: string };

const S = { kind: "string" } as const;
const N = { kind: "number" } as const;
const B = { kind: "boolean" } as const;
const ANY = { kind: "any" } as const;
const STRINGS = { kind: "strings" } as const;
const object = (
  fields: Record<string, Shape>,
  extra: { required?: string[]; oneOf?: string[] } = {},
): Shape => ({ kind: "object", fields, ...extra });
const named = (entry: Shape): Shape => ({ kind: "named", entry });

const TLS_ROUTER = object({ certResolver: S, domains: ANY, options: S, passthrough: B });

const HTTP = object({
  routers: named(
    object(
      {
        rule: S,
        ruleSyntax: S,
        service: S,
        entryPoints: STRINGS,
        middlewares: STRINGS,
        priority: N,
        tls: TLS_ROUTER,
        observability: ANY,
      },
      { required: ["rule", "service"] },
    ),
  ),
  services: named(
    object(
      {
        loadBalancer: object({
          servers: {
            kind: "list",
            item: object({ url: S, weight: N, preservePath: B }, { required: ["url"] }),
          },
          sticky: ANY,
          healthCheck: ANY,
          passHostHeader: B,
          responseForwarding: ANY,
          serversTransport: S,
          strategy: S,
        }),
        weighted: ANY,
        mirroring: ANY,
        failover: ANY,
      },
      { oneOf: ["loadBalancer", "weighted", "mirroring", "failover"] },
    ),
  ),
  middlewares: named({ kind: "typed", types: HTTP_MIDDLEWARES, what: "middleware" }),
  serversTransports: named(ANY),
});

const TCP = object({
  routers: named(
    object(
      {
        rule: S,
        ruleSyntax: S,
        service: S,
        entryPoints: STRINGS,
        middlewares: STRINGS,
        priority: N,
        tls: TLS_ROUTER,
      },
      { required: ["rule", "service"] },
    ),
  ),
  services: named(
    object(
      {
        loadBalancer: object({
          servers: {
            kind: "list",
            item: object({ address: S, tls: B, weight: N }, { required: ["address"] }),
          },
          proxyProtocol: ANY,
          serversTransport: S,
          terminationDelay: N,
        }),
        weighted: ANY,
      },
      { oneOf: ["loadBalancer", "weighted"] },
    ),
  ),
  middlewares: named({ kind: "typed", types: TCP_MIDDLEWARES, what: "TCP middleware" }),
  serversTransports: named(ANY),
});

const UDP = object({
  routers: named(object({ service: S, entryPoints: STRINGS }, { required: ["service"] })),
  services: named(
    object(
      {
        loadBalancer: object({
          servers: {
            kind: "list",
            item: object({ address: S, weight: N }, { required: ["address"] }),
          },
        }),
        weighted: ANY,
      },
      { oneOf: ["loadBalancer", "weighted"] },
    ),
  ),
});

const TLS = object({
  certificates: {
    kind: "list",
    item: object(
      { certFile: S, keyFile: S, stores: STRINGS },
      { required: ["certFile", "keyFile"] },
    ),
  },
  options: named(ANY),
  stores: named(ANY),
});

const ROOT = object({ http: HTTP, tcp: TCP, udp: UDP, tls: TLS });

class Problem extends Error {
  readonly node: Node | null;
  constructor(node: Node | null | undefined, reason: string) {
    super(reason);
    this.node = node ?? null;
  }
}

function keyName(pair: Pair): string {
  return isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
}

function list(words: string[]): string {
  return words.length <= 1
    ? (words[0] ?? "")
    : `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`;
}

function check(node: Node | null, shape: Shape, path: string, holder: Node | null): void {
  const where = path || "the file";
  const at = node ?? holder;
  switch (shape.kind) {
    case "any":
      return;
    case "string":
      if (!isScalar(node) || node.value === null || typeof node.value === "object")
        throw new Problem(at, `"${where}" must be text.`);
      return;
    case "number":
      if (!isScalar(node) || typeof node.value !== "number")
        throw new Problem(at, `"${where}" must be a number.`);
      return;
    case "boolean":
      if (!isScalar(node) || typeof node.value !== "boolean")
        throw new Problem(at, `"${where}" must be true or false.`);
      return;
    case "strings":
      if (!isSeq(node)) throw new Problem(at, `"${where}" must be a list of names.`);
      for (const item of node.items) {
        if (!isScalar(item) || typeof item.value !== "string" || item.value === "")
          throw new Problem((item as Node) ?? node, `"${where}" must be a list of names.`);
      }
      return;
    case "list":
      if (!isSeq(node)) throw new Problem(at, `"${where}" must be a list.`);
      node.items.forEach((item, index) => {
        check(item as Node, shape.item, `${where}[${index}]`, node);
      });
      return;
    case "named":
      if (node === null || (isScalar(node) && node.value === null)) return;
      if (!isMap(node)) throw new Problem(at, `"${where}" must map names to their settings.`);
      for (const pair of node.items) {
        const name = keyName(pair);
        if (pair.value === null || (isScalar(pair.value) && pair.value.value === null)) {
          throw new Problem(pair.key as Node, `"${where}.${name}" has no settings.`);
        }
        check(pair.value as Node, shape.entry, `${where}.${name}`, pair.key as Node);
      }
      return;
    case "typed": {
      if (!isMap(node) || node.items.length !== 1) {
        throw new Problem(
          at,
          `"${where}" needs exactly one ${shape.what} type, like ${list(shape.types.slice(0, 3))}.`,
        );
      }
      const pair = node.items[0] as Pair;
      const type = keyName(pair);
      if (!shape.types.includes(type)) {
        throw new Problem(
          pair.key as Node,
          `"${where}" uses an unknown ${shape.what} type "${type}".`,
        );
      }
      return;
    }
    case "object": {
      if (!isMap(node)) throw new Problem(at, `"${where}" must be a map of settings.`);
      const seen = new Set<string>();
      for (const pair of node.items) {
        const name = keyName(pair);
        seen.add(name);
        const field = shape.fields[name];
        if (!field) {
          const known = Object.keys(shape.fields);
          throw new Problem(
            pair.key as Node,
            path === ""
              ? `Unknown section "${name}". A router file has ${list(known)}.`
              : `Unknown setting "${name}" in "${where}". Expected ${list(known)}.`,
          );
        }
        check(
          (pair.value as Node) ?? null,
          field,
          path === "" ? name : `${where}.${name}`,
          pair.key as Node,
        );
      }
      for (const name of shape.required ?? []) {
        if (!seen.has(name))
          throw new Problem(
            holder ?? node,
            `"${where}" needs ${name === "rule" ? "a" : "its"} ${name}.`,
          );
      }
      if (shape.oneOf) {
        const kinds = shape.oneOf.filter((name) => seen.has(name));
        if (kinds.length !== 1) {
          throw new Problem(
            holder ?? node,
            `"${where}" needs exactly one of ${list(shape.oneOf)}.`,
          );
        }
      }
      return;
    }
  }
}

/** The first problem in `contents`, or null when the router can load it. */
export function checkRouterFile(contents: string): RouterFileProblem | null {
  if (new TextEncoder().encode(contents).length > ROUTER_FILE_MAX_BYTES) {
    return { line: null, reason: "The file is larger than 256 KB." };
  }
  const lines = new LineCounter();
  const document = parseDocument(contents, {
    lineCounter: lines,
    uniqueKeys: true,
    prettyErrors: false,
  });
  // A problem at the very end (an unclosed bracket) points at the last line that has text.
  const lastLine = Math.max(1, contents.replace(/\s+$/, "").split("\n").length);
  const lineOf = (offset: number) => Math.min(lines.linePos(offset).line, lastLine);
  const error = document.errors[0];
  if (error) {
    const reason = error.message.replace(/ at line \d+, column \d+:?[\s\S]*$/, "").trim();
    return {
      line: lineOf(error.pos[0]),
      reason: `This isn't valid YAML: ${reason}.`.replace(/\.\.$/, "."),
    };
  }
  const root = document.contents as Node | null;
  if (root === null || (isScalar(root) && root.value === null)) return null;
  try {
    check(root, ROOT, "", null);
    return null;
  } catch (problem) {
    if (!(problem instanceof Problem)) throw problem;
    const range = problem.node?.range;
    return { line: range ? lineOf(range[0]) : 1, reason: problem.message };
  }
}
