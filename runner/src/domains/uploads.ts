import { createHash, X509Certificate } from "node:crypto";
import { chown, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { certificateCovers } from "@nearzero/shared";
import { writeFileAtomically } from "../router/files.ts";

/**
 * Uploaded certificates on this server's router (spec 10.7): PEM files in the router folder and
 * one file that tells the router to use them. The router picks a certificate by the name a
 * visitor asks for, so a hostname an upload covers is served with it, and Let's Encrypt isn't
 * asked for that hostname.
 */

export const CERTIFICATES_FILE = "nearzero-certificates.yml";
const SUBDIRECTORY = "certificates";
/** Where the router sees its folder. */
const ROUTER_SIDE = "/etc/nearzero/router";

export interface UploadInput {
  id: string;
  certificatePem: string;
  keyPem: string;
}

interface Held {
  id: string;
  file: string;
  names: string[];
  notAfter: number;
}

function namesOf(pem: string): { names: string[]; notAfter: number } {
  const leaf = new X509Certificate(
    pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0] ?? pem,
  );
  const names = new Set<string>();
  for (const part of (leaf.subjectAltName ?? "").split(",")) {
    const match = /^\s*DNS:(.+)$/.exec(part);
    if (match) names.add((match[1] as string).trim().toLowerCase());
  }
  if (names.size === 0) {
    const cn = /(?:^|\n)CN=([^\n]+)/.exec(leaf.subject);
    if (cn) names.add((cn[1] as string).trim().toLowerCase());
  }
  return { names: [...names], notAfter: Date.parse(leaf.validTo) };
}

export function certificatesFileContents(files: readonly string[]): string {
  const lines = [
    "# Written by the Nearzero runner: uploaded certificates. Changes here are replaced on the next sync.",
    "tls:",
    "  certificates:",
  ];
  for (const file of files) {
    lines.push(
      `    - certFile: ${JSON.stringify(`${ROUTER_SIDE}/${SUBDIRECTORY}/${file}.crt`)}`,
      `      keyFile: ${JSON.stringify(`${ROUTER_SIDE}/${SUBDIRECTORY}/${file}.key`)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export class UploadedCertificates {
  readonly #directory: string;
  #held: Held[] = [];

  constructor(routerDirectory: string) {
    this.#directory = routerDirectory;
  }

  get #folder(): string {
    return join(this.#directory, SUBDIRECTORY);
  }

  /** Reads what is already in the folder (after a restart, before the control plane says). */
  async load(): Promise<void> {
    const names = await readdir(this.#folder).catch(() => [] as string[]);
    const held: Held[] = [];
    for (const name of names.filter((item) => item.endsWith(".crt"))) {
      const file = name.slice(0, -4);
      const pem = await readFile(join(this.#folder, name), "utf8").catch(() => null);
      if (!pem) continue;
      try {
        held.push({
          id: file.replace(/^uploaded-/, "").replace(/-[0-9a-f]{12}$/, ""),
          file,
          ...namesOf(pem),
        });
      } catch {
        // Not a certificate any more; it is replaced on the next sync.
      }
    }
    this.#held = held;
  }

  /** Makes the router hold exactly these certificates. Returns whether anything changed. */
  async sync(certificates: readonly UploadInput[]): Promise<boolean> {
    await mkdir(this.#folder, { recursive: true, mode: 0o755 });
    const owner = await stat(this.#directory).catch(() => null);
    const wanted: Held[] = [];
    for (const certificate of certificates) {
      const fingerprint = createHash("sha256")
        .update(certificate.certificatePem)
        .update(certificate.keyPem)
        .digest("hex")
        .slice(0, 12);
      const file = `uploaded-${certificate.id}-${fingerprint}`;
      const crt = join(this.#folder, `${file}.crt`);
      const key = join(this.#folder, `${file}.key`);
      if ((await readFile(crt, "utf8").catch(() => null)) !== certificate.certificatePem) {
        await writeFileAtomically(crt, certificate.certificatePem, 0o644);
      }
      if ((await readFile(key, "utf8").catch(() => null)) !== certificate.keyPem) {
        await writeFileAtomically(key, certificate.keyPem, 0o600);
        // The router runs as the folder's owner and must read the key.
        if (owner) await chown(key, owner.uid, owner.gid).catch(() => {});
      }
      wanted.push({ id: certificate.id, file, ...namesOf(certificate.certificatePem) });
    }
    const keep = new Set(wanted.flatMap((item) => [`${item.file}.crt`, `${item.file}.key`]));
    for (const name of await readdir(this.#folder).catch(() => [] as string[])) {
      if (!keep.has(name)) await rm(join(this.#folder, name), { force: true });
    }
    const path = join(this.#directory, CERTIFICATES_FILE);
    const before = await readFile(path, "utf8").catch(() => null);
    if (wanted.length === 0) {
      await rm(path, { force: true });
    } else {
      const contents = certificatesFileContents(wanted.map((item) => item.file));
      if (before !== contents) await writeFileAtomically(path, contents);
    }
    const changed =
      JSON.stringify(this.#held.map((item) => item.file).sort()) !==
      JSON.stringify(wanted.map((item) => item.file).sort());
    this.#held = wanted;
    return changed;
  }

  covers(hostname: string, now = Date.now()): boolean {
    return this.#held.some(
      (item) => item.notAfter > now && certificateCovers(item.names, hostname),
    );
  }

  list(): { id: string; names: string[]; notAfter: number }[] {
    return this.#held.map(({ id, names, notAfter }) => ({ id, names, notAfter }));
  }
}
