import { isIP } from "node:net";
import { AppError, branchProblem, parseGitUrl } from "@nearzero/shared";
import { Hono } from "hono";
import { z } from "zod";
import { workspaceActorFor } from "../http/actor.ts";
import type { AppEnv } from "../http/context.ts";
import { readBody } from "../http/validate.ts";
import {
  checkOutboundHost,
  OutboundRefused,
  type ResolveHost,
  systemResolve,
} from "../security/outbound.ts";
import type { ControlServices, HttpFetch } from "../services.ts";

/**
 * The default branch of a public repository (spec 6.1, Provider step "Public repository URL"):
 * looked up where the host allows it, otherwise "main". Over HTTPS, Git's smart HTTP protocol
 * answers `GET <repo>/info/refs?service=git-upload-pack` with the refs it advertises; the first
 * line's capabilities name what HEAD points at (`symref=HEAD:refs/heads/<branch>`). SSH URLs
 * need a key before anything is advertised, so they start at "main" (the branch stays editable).
 *
 * The request goes to the address a person typed, so it is kept narrow: HTTPS only, no
 * addresses on this machine or in private ranges, a short timeout, a capped answer, and at most
 * three redirects, each checked the same way.
 */

export const BRANCH_UNRESOLVED = "Could not resolve repository branch.";
export const FALLBACK_BRANCH = "main";
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 3;

export interface DefaultBranch {
  branch: string;
  /** False when the host can't be asked (SSH) and the branch is the "main" fallback. */
  lookedUp: boolean;
}

/** Hosts a lookup never goes to: this machine, private and link-local ranges. */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal"))
    return true;
  const kind = isIP(host);
  if (kind === 4) {
    const [a = 0, b = 0] = host.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (kind === 6) {
    return (
      host === "::" ||
      host === "::1" ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      host.startsWith("fe80") ||
      host.startsWith("::ffff:")
    );
  }
  return false;
}

/**
 * Reads the branch HEAD points at from a smart HTTP ref advertisement (pkt-lines: four hex
 * digits of length, then the line). The first line's symref capability says it, so a body cut at
 * the size cap (a repository with a huge ref list, C1-14) is read up to the cut. Without a symref
 * capability (very old servers), the branch whose commit equals HEAD's wins, preferring main and
 * master.
 */
export function advertisedDefaultBranch(body: Uint8Array): string | null {
  // One character per byte, so pkt-line lengths (in bytes) index the text directly.
  const text = Buffer.from(body).toString("latin1");
  const refs: { sha: string; name: string; capabilities: string }[] = [];
  let at = 0;
  while (at + 4 <= text.length) {
    const length = Number.parseInt(text.slice(at, at + 4), 16);
    if (Number.isNaN(length)) break;
    if (length === 0) {
      at += 4;
      continue;
    }
    // A line cut by the size cap ends the reading; what came before still counts.
    if (length < 4 || at + length > text.length) break;
    const line = text.slice(at + 4, at + length).replace(/\n$/, "");
    at += length;
    if (line.startsWith("#")) continue;
    const [head = "", capabilities = ""] = line.split("\0");
    const match = /^([0-9a-f]{40}|[0-9a-f]{64}) (\S+)$/.exec(head);
    if (!match) continue;
    const symref = /(?:^| )symref=HEAD:refs\/heads\/(\S+)/.exec(capabilities);
    if (symref?.[1]) return symref[1];
    refs.push({ sha: match[1] as string, name: match[2] as string, capabilities });
  }
  const head = refs.find((ref) => ref.name === "HEAD");
  if (!head) return null;
  const same = refs
    .filter((ref) => ref.name.startsWith("refs/heads/") && ref.sha === head.sha)
    .map((ref) => ref.name.slice("refs/heads/".length));
  return (
    same.find((name) => name === "main") ??
    same.find((name) => name === "master") ??
    same[0] ??
    null
  );
}

async function readCapped(response: Response): Promise<Uint8Array | null> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) {
      await reader.cancel().catch(() => {});
      // The first lines are enough: HEAD and its capabilities come first.
      break;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(Math.min(size, MAX_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk.subarray(0, out.length - offset), offset);
    offset += chunk.length;
    if (offset >= out.length) break;
  }
  return out;
}

/**
 * The request for one hop, sent to an address checked beforehand: the URL names that IP, while
 * the Host header and the TLS server name keep the hostname, so the certificate is still checked
 * for it and a name that resolves elsewhere a moment later (DNS rebinding) changes nothing.
 */
export function pinnedRequest(url: URL, address: string): { input: string; host: string } {
  const pinned = new URL(url.toString());
  pinned.hostname = address.includes(":") ? `[${address}]` : address;
  return { input: pinned.toString(), host: url.host };
}

/** The repository's default branch, or an AppError with "Could not resolve repository branch." */
export async function lookUpDefaultBranch(
  http: HttpFetch,
  input: string,
  resolve: ResolveHost = systemResolve,
): Promise<DefaultBranch> {
  const parsed = parseGitUrl(input);
  if ("problem" in parsed) {
    throw new AppError("invalid_request", parsed.problem, { fields: { url: parsed.problem } });
  }
  if (parsed.transport !== "https") return { branch: FALLBACK_BRANCH, lookedUp: false };
  const unresolved = () =>
    new AppError("invalid_request", BRANCH_UNRESOLVED, { fields: { url: BRANCH_UNRESOLVED } });

  let address = `${parsed.url}/info/refs?service=git-upload-pack`;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = new URL(address);
    if (url.protocol !== "https:" || isBlockedHost(url.hostname)) throw unresolved();
    // A name is looked up and every address it gives checked, then the request goes to the
    // checked address (spec 23.9): names like 169.254.169.254.nip.io are refused (B1-35).
    let checked: string;
    try {
      [checked] = (await checkOutboundHost(url.hostname, resolve, false)) as [string];
    } catch (error) {
      if (error instanceof OutboundRefused) throw unresolved();
      throw error;
    }
    const pinned = pinnedRequest(url, checked);
    let response: Response;
    try {
      response = await http(pinned.input, {
        method: "GET",
        redirect: "manual",
        headers: { host: pinned.host, "user-agent": "git/2.47.0 (nearzero)", accept: "*/*" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        // Bun checks the certificate against this name, not the IP in the URL.
        tls: { serverName: url.hostname },
      } as RequestInit);
    } catch {
      throw unresolved();
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      if (!location) throw unresolved();
      address = new URL(location, address).toString();
      continue;
    }
    const type = response.headers.get("content-type") ?? "";
    if (!response.ok || !type.includes("application/x-git-upload-pack-advertisement")) {
      await response.body?.cancel().catch(() => {});
      throw unresolved();
    }
    const body = await readCapped(response);
    const branch = body ? advertisedDefaultBranch(body) : null;
    if (!branch || branchProblem(branch) !== null) throw unresolved();
    return { branch, lookedUp: true };
  }
  throw unresolved();
}

/**
 * `POST /git/default-branch` `{ url }` → `{ branch, lookedUp }` for anyone signed in to a
 * workspace (the new-application page's Continue). Nothing is stored.
 */
export function publicGitRoutes(services: ControlServices): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.post("/git/default-branch", async (c) => {
    await workspaceActorFor(c, services);
    const input = await readBody(c, z.object({ url: z.string().max(1000) }));
    return c.json(await lookUpDefaultBranch(services.http, input.url));
  });
  return app;
}
