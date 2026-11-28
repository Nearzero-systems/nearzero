/**
 * The tar archive inside an export bundle (spec 29.3), read and written from the POSIX ustar
 * description: 512-byte headers, octal sizes, names split into a prefix and a name, and pax
 * extended headers for longer names. Only regular files matter; directories and links are
 * skipped, and a path that could leave the archive's root is refused.
 */

const BLOCK = 512;

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

function field(header: Uint8Array, start: number, length: number): string {
  const slice = header.subarray(start, start + length);
  const end = slice.indexOf(0);
  return new TextDecoder().decode(end === -1 ? slice : slice.subarray(0, end));
}

function octalNumber(header: Uint8Array, start: number, length: number): number {
  const text = field(header, start, length).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new ArchiveError("The archive inside the bundle is damaged.");
  return Number.parseInt(text, 8);
}

function checksumOk(header: Uint8Array): boolean {
  const stored = octalNumber(header, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : (header[i] ?? 0);
  return sum === stored;
}

/** A relative path with "/" separators and no "." or ".." parts; anything else is refused. */
export function safeArchivePath(path: string): string | null {
  const trimmed = path.replace(/^\.\//, "").replace(/\/+$/, "");
  if (trimmed === "" || trimmed.startsWith("/") || trimmed.includes("\\")) return null;
  const parts = trimmed.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
  return trimmed;
}

/** Reads the "path" record of a pax extended header ("<length> path=<value>\n" lines). */
function paxPath(body: Uint8Array): string | null {
  const text = new TextDecoder().decode(body);
  let at = 0;
  while (at < text.length) {
    const space = text.indexOf(" ", at);
    if (space === -1) break;
    const length = Number.parseInt(text.slice(at, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = text.slice(space + 1, at + length - 1);
    const equals = record.indexOf("=");
    if (equals !== -1 && record.slice(0, equals) === "path") return record.slice(equals + 1);
    at += length;
  }
  return null;
}

/** The regular files in a tar archive, by path. Two files with one path are refused. */
export function readArchive(bytes: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  let longName: string | null = null;
  while (offset + BLOCK <= bytes.length) {
    const header = bytes.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    if (!checksumOk(header)) throw new ArchiveError("The archive inside the bundle is damaged.");
    const size = octalNumber(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0);
    const start = offset + BLOCK;
    const end = start + size;
    if (end > bytes.length) throw new ArchiveError("The archive inside the bundle is cut short.");
    const body = bytes.subarray(start, end);
    offset = start + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "x") {
      longName = paxPath(body);
      continue;
    }
    if (type === "L") {
      longName = new TextDecoder().decode(body).replace(/\0+$/, "");
      continue;
    }
    if (type === "g") continue;
    const prefix = field(header, 345, 155);
    const name =
      longName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    longName = null;
    if (type !== "0" && type !== "\0") continue;
    const path = safeArchivePath(name);
    if (path === null) {
      throw new ArchiveError(`The bundle holds a file with an unsafe path (${name}).`);
    }
    if (files.has(path)) throw new ArchiveError(`The bundle holds ${path} twice.`);
    files.set(path, body);
  }
  return files;
}

function octalField(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function headerFor(path: string, size: number, mtime: number): Uint8Array {
  const block = new Uint8Array(BLOCK);
  const encoder = new TextEncoder();
  const write = (text: string, at: number) => block.set(encoder.encode(text), at);
  let name = path;
  let prefix = "";
  if (encoder.encode(name).length > 100) {
    const cut = name.lastIndexOf("/", name.length - 1);
    prefix = cut > 0 ? name.slice(0, cut) : "";
    name = cut > 0 ? name.slice(cut + 1) : name;
    if (encoder.encode(name).length > 100 || encoder.encode(prefix).length > 155) {
      throw new ArchiveError(`The path ${path} is too long for the archive.`);
    }
  }
  write(name, 0);
  write(octalField(0o600, 8), 100);
  write(octalField(0, 8), 108);
  write(octalField(0, 8), 116);
  write(octalField(size, 12), 124);
  write(octalField(mtime, 12), 136);
  write("        ", 148);
  write("0", 156);
  write("ustar\u000000", 257);
  write(prefix, 345);
  let sum = 0;
  for (const byte of block) sum += byte;
  write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return block;
}

/** A tar archive of the given files, in the given order. */
export function writeArchive(
  files: Iterable<[string, Uint8Array]>,
  mtime = Math.floor(Date.now() / 1000),
): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [path, content] of files) {
    const safe = safeArchivePath(path);
    if (safe === null || safe !== path) throw new ArchiveError(`Unsafe path ${path}.`);
    parts.push(headerFor(path, content.length, mtime), content);
    const padding = (BLOCK - (content.length % BLOCK)) % BLOCK;
    if (padding > 0) parts.push(new Uint8Array(padding));
  }
  parts.push(new Uint8Array(BLOCK * 2));
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
