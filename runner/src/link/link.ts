import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import { linkRequest } from "./http.ts";
import { LinkSocket, type Verify } from "./socket.ts";

/**
 * Where the runner reaches the control plane, and how it knows it is the real one (spec 25 D1,
 * spec 31 "Remote runners are always encrypted"). A remote runner uses only:
 *
 * - `https://<console hostname>`: a certificate a public authority issued for that very name,
 *   checked before anything is sent; never an IP address this way;
 * - `https://<address>:<port>` with a fingerprint: the control plane's own certificate, made at
 *   install; only a certificate with exactly that SHA-256 (or the next one, while the pair is
 *   being replaced) is accepted, on every connection, before anything is sent.
 *
 * Plain `http://` is only for the Nearzero host's own runner, on the host's private network
 * (`http://nearzero-control:3000`). A remote runner never uses it, never falls back to it and
 * never follows a move to it.
 *
 * The control plane can move a runner to a better address (welcome.link) and gives it a pinned
 * fallback (welcome.fallback). The runner keeps both, and a next fingerprint, beside its
 * credential.
 */

export interface ControlLink {
  /** An origin: scheme, host and port. */
  url: string;
  /** SHA-256 of the control plane's certificate (DER), 64 lowercase hex characters, or null. */
  fingerprint: string | null;
  /** The fingerprint of the pair that will replace it (rotation), accepted too; or null. */
  nextFingerprint?: string | null;
}

/** "sha256:AB:CD…", "AB:CD…" or "abcd…": the 64 hex digits in lowercase, or null. */
export function normalizeFingerprint(value: string | null | undefined): string | null {
  if (!value) return null;
  const hex = value
    .trim()
    .replace(/^sha-?256[:=]?/i, "")
    .replace(/[:\s]/g, "")
    .toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

export function sameLink(a: ControlLink | null, b: ControlLink | null): boolean {
  return a !== null && b !== null && a.url === b.url && a.fingerprint === b.fingerprint;
}

export function isEncrypted(link: ControlLink): boolean {
  return link.url.startsWith("https:");
}

function hostOf(url: string): string {
  return new URL(url).hostname.replace(/^\[|\]$/g, "");
}

/**
 * How an address is checked: "pinned" (https with a fingerprint), "authority" (https to a host
 * name, a public authority and the name), "plain" (http), or why it can't be used at all.
 */
export function linkKind(
  link: ControlLink,
): { kind: "pinned" | "authority" | "plain" } | { kind: "refused"; reason: string } {
  let url: URL;
  try {
    url = new URL(link.url);
  } catch {
    return { kind: "refused", reason: `${link.url} isn't an address.` };
  }
  if (url.protocol === "http:") return { kind: "plain" };
  if (url.protocol !== "https:") {
    return { kind: "refused", reason: `${link.url} isn't an https:// address.` };
  }
  if (link.fingerprint) return { kind: "pinned" };
  if (net.isIP(hostOf(link.url))) {
    // Bun's TLS client checks no IP address against the certificate (C4-03).
    return {
      kind: "refused",
      reason: `${url.host} is an IP address, which a runner reaches only with Nearzero's certificate fingerprint.`,
    };
  }
  return { kind: "authority" };
}

/** Why a remote runner may not use an address (be moved to it, fall back to it), or null. */
export function remoteLinkProblem(link: ControlLink): string | null {
  const kind = linkKind(link);
  if (kind.kind === "refused") return kind.reason;
  if (kind.kind === "plain") {
    return `${link.url} is a plain http:// address. A server's runner reaches Nearzero only over https://; run setup again on the server to give it Nearzero's encrypted address.`;
  }
  return null;
}

/**
 * The Nearzero host's own internal address: plain HTTP to a single-label name, the control
 * plane's container on the host's private network (`http://nearzero-control:3000`). Loopback
 * isn't one: only tests run a runner that way, and they say so to the session themselves (C4-16).
 */
export function isHostInternalLink(link: ControlLink): boolean {
  if (linkKind(link).kind !== "plain") return false;
  const host = hostOf(link.url);
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(host) && host.toLowerCase() !== "localhost";
}

/** The fingerprints a link accepts: its own and, while the pair is replaced, the next one. */
export function linkPins(link: ControlLink | null): string[] {
  if (!link) return [];
  return [link.fingerprint, link.nextFingerprint].filter((pin): pin is string => Boolean(pin));
}

const pins = linkPins;

function verifyFor(link: ControlLink): Verify {
  const kind = linkKind(link);
  if (kind.kind === "refused") throw new Error(kind.reason);
  if (kind.kind === "plain") return { kind: "plain" };
  return kind.kind === "pinned"
    ? { kind: "pinned", fingerprints: pins(link) }
    : { kind: "authority" };
}

/** Opens the WebSocket at `path` on the link, checking the certificate before sending anything. */
export function openLinkSocket(
  link: ControlLink,
  path: string,
  headers: Record<string, string>,
): LinkSocket {
  const url = new URL(path, link.url);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return new LinkSocket(url.toString(), { headers, verify: verifyFor(link) });
}

/**
 * `fetch` for the link, over the runner's own TLS socket, which writes nothing before the
 * certificate on that same connection is accepted (C4-01, C4-03): the pinned fingerprint, or a
 * public authority's certificate for the host name. Plain: the Nearzero host's runner only.
 */
export function linkFetch(link: ControlLink, base: typeof fetch = fetch): typeof fetch {
  const kind = linkKind(link);
  if (kind.kind === "refused") {
    return (async () => {
      throw new Error(kind.reason);
    }) as unknown as typeof fetch;
  }
  if (kind.kind === "plain") return base;
  const verify = verifyFor(link) as Exclude<Verify, { kind: "plain" }>;
  const target = { url: new URL(link.url).origin, verify };
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    linkRequest(
      target,
      input instanceof Request ? input.url : (input as string | URL),
      init,
    )) as unknown as typeof fetch;
}

// ---- What the control plane told this runner, kept beside its credential.

export const SAVED_LINK_FILE = "control-link.json";
/** Replaced fingerprints kept, newest last. */
const RETIRED_KEPT = 20;

/** What the runner's settings give (setup's runner.env, or the join command). */
export interface ConfiguredLinks {
  link: ControlLink;
  /** NEARZERO_CONTROL_FALLBACK_URL and _FINGERPRINT, or null. */
  fallback: ControlLink | null;
}

export interface SavedLinks {
  /**
   * The address in use: the one the control plane moved this runner to, or the configured one.
   * Null when the settings changed since this was saved (setup ran again): then the settings,
   * being newer, win, and only `retired` still counts.
   */
  link: ControlLink | null;
  /** The pinned TLS port, tried when the address in use stops answering (C4-06). */
  fallback: ControlLink | null;
  /**
   * Fingerprints the control plane replaced (C4-12): never accepted again from anywhere, the
   * settings included, so a key retired by `nearzero runner-link switch` stays retired.
   */
  retired: string[];
}

interface SavedFile {
  url: string;
  fingerprint: string | null;
  nextFingerprint?: string | null;
  fallback?: { url: string; fingerprint: string; nextFingerprint?: string } | null;
  retired?: string[];
  /**
   * The settings when this was saved: the configured address, fingerprint and fallback. When
   * any of them differs now, setup ran again and its settings win (C4-12).
   */
  from: string;
  fromFingerprint?: string | null;
  fromFallback?: { url: string; fingerprint: string | null } | null;
}

function readLink(value: unknown, pinnedOnly: boolean): ControlLink | null {
  if (!value || typeof value !== "object") return null;
  const item = value as { url?: unknown; fingerprint?: unknown; nextFingerprint?: unknown };
  if (typeof item.url !== "string" || !/^https:\/\/[^/?#@\s]+$/.test(item.url)) return null;
  const fingerprint =
    item.fingerprint === null ? null : normalizeFingerprint(String(item.fingerprint ?? ""));
  if (item.fingerprint !== null && fingerprint === null) return null;
  const next =
    typeof item.nextFingerprint === "string" ? normalizeFingerprint(item.nextFingerprint) : null;
  const link: ControlLink = {
    url: item.url,
    fingerprint,
    ...(next ? { nextFingerprint: next } : {}),
  };
  if (remoteLinkProblem(link) !== null) return null;
  if (pinnedOnly && !fingerprint) return null;
  return link;
}

function sameSettings(saved: Partial<SavedFile>, configured: ConfiguredLinks): boolean {
  const fallback = saved.fromFallback ?? null;
  const wanted = configured.fallback;
  return (
    saved.from === configured.link.url &&
    (saved.fromFingerprint ?? null) === configured.link.fingerprint &&
    (fallback?.url ?? null) === (wanted?.url ?? null) &&
    (fallback?.fingerprint ?? null) === (wanted?.fingerprint ?? null)
  );
}

export async function readSavedLinks(
  stateDirectory: string,
  configured: ConfiguredLinks,
): Promise<SavedLinks | null> {
  const text = await readFile(join(stateDirectory, SAVED_LINK_FILE), "utf8").catch(() => null);
  if (!text) return null;
  try {
    const saved = JSON.parse(text) as Partial<SavedFile>;
    const retired = (Array.isArray(saved.retired) ? saved.retired : [])
      .map((item) => normalizeFingerprint(String(item)))
      .filter((item): item is string => item !== null)
      .slice(-RETIRED_KEPT);
    if (!sameSettings(saved, configured)) {
      // Setup ran again: its settings are newer than anything kept here, and what it wrote
      // wins over a fingerprint retired before it (C4-12).
      const given = new Set([...linkPins(configured.link), ...linkPins(configured.fallback)]);
      return { link: null, fallback: null, retired: retired.filter((pin) => !given.has(pin)) };
    }
    const link = readLink(saved, false);
    if (!link) return { link: null, fallback: null, retired };
    return { link, fallback: readLink(saved.fallback, true), retired };
  } catch {
    return null;
  }
}

export async function saveLinks(
  stateDirectory: string,
  links: SavedLinks & { link: ControlLink },
  configured: ConfiguredLinks,
): Promise<void> {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const path = join(stateDirectory, SAVED_LINK_FILE);
  const temporary = `${path}.tmp`;
  const body: SavedFile = {
    url: links.link.url,
    fingerprint: links.link.fingerprint,
    ...(links.link.nextFingerprint ? { nextFingerprint: links.link.nextFingerprint } : {}),
    fallback: links.fallback?.fingerprint
      ? {
          url: links.fallback.url,
          fingerprint: links.fallback.fingerprint,
          ...(links.fallback.nextFingerprint
            ? { nextFingerprint: links.fallback.nextFingerprint }
            : {}),
        }
      : null,
    ...(links.retired.length > 0 ? { retired: links.retired.slice(-RETIRED_KEPT) } : {}),
    from: configured.link.url,
    fromFingerprint: configured.link.fingerprint,
    fromFallback: configured.fallback
      ? { url: configured.fallback.url, fingerprint: configured.fallback.fingerprint }
      : null,
  };
  await writeFile(temporary, `${JSON.stringify(body)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

export async function forgetSavedLinks(stateDirectory: string): Promise<void> {
  await rm(join(stateDirectory, SAVED_LINK_FILE), { force: true });
}
