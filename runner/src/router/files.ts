import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { type HoldReason, type RouteSpec, routerFileNameProblem } from "@nearzero/shared";

/**
 * The router's configuration as files (spec 25 D5: Traefik v3 with its file provider, written by
 * the runner). Each route is one file, `route-<key>.yml`, in the router's folder; Traefik watches
 * the folder and picks up a change within a second or two. Files are written atomically (a
 * temporary file in the same folder, flushed, then renamed over the old one), so the router never
 * reads half a file.
 *
 * Only files named route-*.yml and the shared middlewares file are the runner's. Anything else in
 * the folder (the installer's console route, a person's own file) is left alone.
 */

export const ROUTE_FILE_PREFIX = "route-";
export const MIDDLEWARES_FILE = "nearzero-middlewares.yml";
export const REDIRECT_MIDDLEWARE = "nearzero-redirect-https";
const HEADER = "# Written by the Nearzero runner. Changes here are replaced on the next sync.\n";

/**
 * How each hostname of a route gets HTTPS, after the hold check (spec 10.7). "custom": an
 * uploaded certificate covers it, so the router serves that one and redirects HTTP to HTTPS;
 * "backoff": held after failed validations or a rate limit.
 */
export type EffectiveCertificate =
  | { mode: "letsencrypt" }
  | { mode: "custom" }
  | { mode: "hold"; reason: HoldReason | "requested" | "backoff" }
  | { mode: "none" };

export function routeFileName(key: string): string {
  return `${ROUTE_FILE_PREFIX}${key}.yml`;
}

/** A YAML string. JSON's quoting is valid YAML, and it escapes everything that needs it. */
function q(value: string): string {
  return JSON.stringify(value);
}

/** The Traefik rule for some hostnames and a path. Inputs are checked by the route schema. */
export function routeRule(hostnames: readonly string[], path: string): string {
  const hosts = hostnames.map((host) => `Host(\`${host}\`)`).join(" || ");
  const withParens = hostnames.length > 1 ? `(${hosts})` : hosts;
  return path === "/" ? withParens : `${withParens} && PathPrefix(\`${path}\`)`;
}

/**
 * The file for one route. Hostnames that get Let's Encrypt certificates and hostnames held on
 * the placeholder certificate get separate routers:
 * - issued: HTTPS with the "letsencrypt" resolver; plain HTTP redirects to HTTPS. Let's Encrypt's
 *   HTTP challenge is answered by the router before any of these rules.
 * - held: HTTPS with the router's own placeholder certificate, and plain HTTP served as is, so
 *   the app is reachable while DNS isn't ready; nothing asks Let's Encrypt.
 * - none: plain HTTP only.
 */
export function routeFileContents(
  route: RouteSpec,
  certificates: ReadonlyMap<string, EffectiveCertificate>,
): string {
  const service = `nz-${route.key}`;
  const issued = route.hostnames.filter((h) => certificates.get(h)?.mode === "letsencrypt");
  const custom = route.hostnames.filter((h) => certificates.get(h)?.mode === "custom");
  const held = route.hostnames.filter((h) => certificates.get(h)?.mode === "hold");
  const plain = route.hostnames.filter((h) => (certificates.get(h)?.mode ?? "none") === "none");

  const lines: string[] = [HEADER.trimEnd(), "http:", "  routers:"];
  // Routes that keep out of the request log (the console's own, spec 13.1).
  const quiet =
    route.accessLog === false ? ["      observability:", "        accessLogs: false"] : [];
  const router = (name: string, hosts: string[], entryPoint: string, extra: string[]) => {
    lines.push(
      `    ${q(name)}:`,
      `      rule: ${q(routeRule(hosts, route.path))}`,
      `      entryPoints: [${q(entryPoint)}]`,
      `      service: ${q(service)}`,
      ...extra,
      ...quiet,
    );
  };
  if (issued.length > 0) {
    router(`${service}-https`, issued, "websecure", [
      "      tls:",
      `        certResolver: ${q("letsencrypt")}`,
    ]);
    router(`${service}-http`, issued, "web", [`      middlewares: [${q(REDIRECT_MIDDLEWARE)}]`]);
  }
  if (custom.length > 0) {
    router(`${service}-custom-https`, custom, "websecure", ["      tls: {}"]);
    router(`${service}-custom-http`, custom, "web", [
      `      middlewares: [${q(REDIRECT_MIDDLEWARE)}]`,
    ]);
  }
  if (held.length > 0) {
    router(`${service}-held-https`, held, "websecure", ["      tls: {}"]);
    router(`${service}-held-http`, held, "web", []);
  }
  if (plain.length > 0) router(`${service}-plain-http`, plain, "web", []);
  lines.push(
    "  services:",
    `    ${q(service)}:`,
    "      loadBalancer:",
    "        passHostHeader: true",
    "        servers:",
    `          - url: ${q(`${route.upstream.scheme}://${route.upstream.host}:${route.upstream.port}`)}`,
  );
  return `${lines.join("\n")}\n`;
}

export function middlewaresFileContents(): string {
  return `${HEADER}http:
  middlewares:
    ${q(REDIRECT_MIDDLEWARE)}:
      redirectScheme:
        scheme: "https"
        permanent: true
`;
}

/** Writes a file so readers see the old version or the new one, never a mix. */
export async function writeFileAtomically(path: string, contents: string, mode = 0o644) {
  const directory = path.slice(0, path.lastIndexOf("/")) || ".";
  const temporary = join(
    directory,
    `.${path.slice(directory.length + 1)}.${randomBytes(4).toString("hex")}.tmp`,
  );
  const handle = await open(temporary, "w", mode);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  // Make the rename itself durable.
  const dir = await open(directory, "r").catch(() => null);
  if (dir) {
    await dir.sync().catch(() => {});
    await dir.close();
  }
}

export class RouteFiles {
  readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  async prepare(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const middlewares = join(this.directory, MIDDLEWARES_FILE);
    const current = await readFile(middlewares, "utf8").catch(() => null);
    const wanted = middlewaresFileContents();
    if (current !== wanted) await writeFileAtomically(middlewares, wanted);
  }

  /** Writes a route's file unless it already says exactly that. Returns whether it changed. */
  async write(route: RouteSpec, certificates: ReadonlyMap<string, EffectiveCertificate>) {
    const path = join(this.directory, routeFileName(route.key));
    const wanted = routeFileContents(route, certificates);
    const current = await readFile(path, "utf8").catch(() => null);
    if (current === wanted) return false;
    await writeFileAtomically(path, wanted);
    return true;
  }

  async remove(key: string): Promise<boolean> {
    const path = join(this.directory, routeFileName(key));
    const existed = await readFile(path, "utf8")
      .then(() => true)
      .catch(() => false);
    await rm(path, { force: true });
    return existed;
  }

  /** Keys of the route files in the folder. */
  async keys(): Promise<string[]> {
    const names = await readdir(this.directory).catch(() => [] as string[]);
    return names
      .filter((name) => name.startsWith(ROUTE_FILE_PREFIX) && name.endsWith(".yml"))
      .map((name) => name.slice(ROUTE_FILE_PREFIX.length, -".yml".length));
  }

  /**
   * Saves a file a person edited (Settings → Router files, spec 18.3). Only a plain YAML name
   * directly in this folder, never one of the runner's own files; the control plane checked the
   * contents against the router's schema before sending them.
   */
  async writeOwn(name: string, contents: string): Promise<{ name: string; contents: string }> {
    const problem = routerFileNameProblem(name);
    if (problem) throw new Error(problem);
    await mkdir(this.directory, { recursive: true });
    await writeFileAtomically(join(this.directory, name), contents);
    return { name, contents };
  }

  /** Every configuration file in the folder, for the read-only Router files view (spec 9.1). */
  async list(): Promise<{ name: string; contents: string }[]> {
    const names = (await readdir(this.directory).catch(() => [] as string[]))
      .filter((name) => /\.(ya?ml|toml)$/.test(name) && !name.startsWith("."))
      .sort();
    const files: { name: string; contents: string }[] = [];
    for (const name of names) {
      const contents = await readFile(join(this.directory, name), "utf8").catch(() => "");
      files.push({ name, contents: contents.slice(0, 256 * 1024) });
    }
    return files;
  }
}
