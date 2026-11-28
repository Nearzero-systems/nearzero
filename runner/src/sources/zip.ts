import { lstat, mkdir, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import { linkStaysInside } from "./links.ts";

/**
 * Unpacking an uploaded .zip safely (spec 6.3, Upload). Written from the ZIP format's public
 * description (PKWARE APPNOTE): the central directory at the end lists every entry, each pointing
 * at a local header followed by its data, stored or deflated.
 *
 * Refused, so nothing lands outside the folder: absolute paths, drive letters, any ".." part,
 * NUL bytes, links pointing outside the folder (or anywhere absolute), encrypted entries and
 * compression methods other than stored and deflate. Links are made after every file, so no
 * file can be written through one, and once they are all made each is followed the way the
 * system would (through the other links), so a chain of links can't lead out either. Sizes are
 * capped so a small archive can't fill the disk.
 */

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

export interface UnzipLimits {
  /** Everything unpacked together. */
  maxTotalBytes: number;
  maxEntries: number;
}

export const DEFAULT_UNZIP_LIMITS: UnzipLimits = {
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
  maxEntries: 100_000,
};

export interface UnzipResult {
  files: number;
  directories: number;
  links: number;
  bytes: number;
  /** The single top folder whose contents became the root, when the archive had one. */
  strippedFolder: string | null;
}

interface Entry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  unixMode: number | null;
}

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFDIR = 0o040000;

function readEntries(data: Buffer, limits: UnzipLimits): Entry[] {
  const searchFrom = Math.max(0, data.length - (0xffff + 22));
  let eocd = -1;
  for (let at = data.length - 22; at >= searchFrom; at--) {
    if (data.readUInt32LE(at) === EOCD) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw new ArchiveError("This file isn't a .zip archive (or it is damaged).");
  let count = data.readUInt16LE(eocd + 10);
  let directorySize = data.readUInt32LE(eocd + 12);
  let directoryOffset = data.readUInt32LE(eocd + 16);
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || data.readUInt32LE(locator) !== ZIP64_LOCATOR) {
      throw new ArchiveError("This .zip archive is damaged: its directory can't be found.");
    }
    const record = Number(data.readBigUInt64LE(locator + 8));
    if (record < 0 || record + 56 > data.length || data.readUInt32LE(record) !== ZIP64_EOCD) {
      throw new ArchiveError("This .zip archive is damaged: its directory can't be found.");
    }
    count = Number(data.readBigUInt64LE(record + 32));
    directorySize = Number(data.readBigUInt64LE(record + 40));
    directoryOffset = Number(data.readBigUInt64LE(record + 48));
  }
  if (count > limits.maxEntries) {
    throw new ArchiveError(`The archive has more than ${limits.maxEntries} entries.`);
  }
  if (directoryOffset + directorySize > data.length) {
    throw new ArchiveError("This .zip archive is damaged or cut short.");
  }
  const entries: Entry[] = [];
  let at = directoryOffset;
  for (let index = 0; index < count; index++) {
    if (at + 46 > data.length || data.readUInt32LE(at) !== CENTRAL) {
      throw new ArchiveError("This .zip archive is damaged: an entry can't be read.");
    }
    const madeBy = data.readUInt16LE(at + 4);
    const flags = data.readUInt16LE(at + 8);
    const method = data.readUInt16LE(at + 10);
    const crc = data.readUInt32LE(at + 16);
    let compressedSize = data.readUInt32LE(at + 20);
    let size = data.readUInt32LE(at + 24);
    const nameLength = data.readUInt16LE(at + 28);
    const extraLength = data.readUInt16LE(at + 30);
    const commentLength = data.readUInt16LE(at + 32);
    const external = data.readUInt32LE(at + 38);
    let localOffset = data.readUInt32LE(at + 42);
    const nameBytes = data.subarray(at + 46, at + 46 + nameLength);
    const name = flags & 0x800 ? nameBytes.toString("utf8") : nameBytes.toString("latin1");
    // Zip64 sizes and offset live in an extra field when the 32-bit ones are full.
    let extra = at + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra + 4 <= extraEnd) {
      const tag = data.readUInt16LE(extra);
      const length = data.readUInt16LE(extra + 2);
      if (tag === 0x0001) {
        let field = extra + 4;
        if (size === 0xffffffff) {
          size = Number(data.readBigUInt64LE(field));
          field += 8;
        }
        if (compressedSize === 0xffffffff) {
          compressedSize = Number(data.readBigUInt64LE(field));
          field += 8;
        }
        if (localOffset === 0xffffffff) localOffset = Number(data.readBigUInt64LE(field));
      }
      extra += 4 + length;
    }
    const unix = madeBy >> 8 === 3 ? external >>> 16 : null;
    entries.push({
      name,
      method,
      flags,
      crc,
      compressedSize,
      size,
      localOffset,
      unixMode: unix || null,
    });
    at = extraEnd + commentLength;
  }
  return entries;
}

/** The entry's path inside the folder, or a refusal naming it. */
export function safeEntryPath(name: string): string {
  const normalized = name.replace(/\\/g, "/");
  if (normalized.includes("\0")) throw new ArchiveError(`"${name}" has a NUL byte in its name.`);
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new ArchiveError(`"${name}" is an absolute path. Archives may only hold relative paths.`);
  }
  const parts = normalized.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.includes("..")) {
    throw new ArchiveError(`"${name}" points outside the archive's folder ("..").`);
  }
  return parts.join("/");
}

function entryData(data: Buffer, entry: Entry, budget: number): Buffer {
  const at = entry.localOffset;
  if (at + 30 > data.length || data.readUInt32LE(at) !== LOCAL) {
    throw new ArchiveError(`"${entry.name}" is damaged in the archive.`);
  }
  const start = at + 30 + data.readUInt16LE(at + 26) + data.readUInt16LE(at + 28);
  const end = start + entry.compressedSize;
  if (end > data.length) throw new ArchiveError(`"${entry.name}" is cut short in the archive.`);
  const raw = data.subarray(start, end);
  if (entry.size > budget) {
    throw new ArchiveError("The archive unpacks to more than 2 GB. Leave out build output.");
  }
  let out: Buffer;
  if (entry.method === 0) out = Buffer.from(raw);
  else if (entry.method === 8) {
    try {
      out = inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) });
    } catch {
      throw new ArchiveError(`"${entry.name}" can't be unpacked: the archive is damaged.`);
    }
  } else {
    throw new ArchiveError(
      `"${entry.name}" uses a compression method Nearzero can't unpack (${entry.method}). Make the archive with standard zip compression.`,
    );
  }
  if (out.length !== entry.size || Bun.hash.crc32(out) >>> 0 !== entry.crc >>> 0) {
    throw new ArchiveError(`"${entry.name}" doesn't match its checksum: the archive is damaged.`);
  }
  return out;
}

/** The common top folder of every path, when all of them sit inside exactly one. */
function singleTopFolder(paths: { path: string; directory: boolean }[]): string | null {
  let top: string | null = null;
  for (const { path, directory } of paths) {
    const slash = path.indexOf("/");
    if (slash < 0) {
      if (!directory) return null;
      if (top === null) top = path;
      else if (top !== path) return null;
      continue;
    }
    const first = path.slice(0, slash);
    if (top === null) top = first;
    else if (top !== first) return null;
  }
  return top;
}

/** Unpacks `data` (a whole .zip) into `destination`, which must exist and be empty. */
export async function unzipInto(
  data: Buffer,
  destination: string,
  limits: UnzipLimits = DEFAULT_UNZIP_LIMITS,
): Promise<UnzipResult> {
  const root = resolve(destination);
  const entries = readEntries(data, limits).filter(
    (entry) => !/(^|\/)__MACOSX(\/|$)/.test(entry.name.replace(/\\/g, "/")),
  );
  const planned = entries.map((entry) => {
    if (entry.flags & 0x1) {
      throw new ArchiveError(`"${entry.name}" is encrypted. Upload an archive without a password.`);
    }
    const type = (entry.unixMode ?? 0) & S_IFMT;
    const directory = entry.name.endsWith("/") || type === S_IFDIR;
    return {
      entry,
      path: safeEntryPath(entry.name),
      directory,
      link: !directory && type === S_IFLNK,
    };
  });
  const strip = singleTopFolder(planned.filter((item) => item.path !== ""));
  const result: UnzipResult = {
    files: 0,
    directories: 0,
    links: 0,
    bytes: 0,
    strippedFolder: strip,
  };
  const inside = (relative: string) => {
    const full = resolve(root, relative);
    if (full !== root && !full.startsWith(`${root}/`)) {
      throw new ArchiveError(`"${relative}" points outside the archive's folder.`);
    }
    return full;
  };
  const links: { full: string; target: string; name: string; rel: string }[] = [];
  let budget = limits.maxTotalBytes;
  for (const item of planned) {
    let relative = item.path;
    if (strip !== null) relative = relative === strip ? "" : relative.slice(strip.length + 1);
    if (relative === "") continue;
    const full = inside(relative);
    if (item.directory) {
      await mkdir(full, { recursive: true, mode: 0o755 });
      result.directories++;
      continue;
    }
    const bytes = entryData(data, item.entry, budget);
    budget -= bytes.length;
    result.bytes += bytes.length;
    if (item.link) {
      const target = bytes.toString("utf8");
      if (target === "" || target.startsWith("/") || target.includes("\0")) {
        throw new ArchiveError(`The link "${item.path}" points outside the archive's folder.`);
      }
      const resolved = posix.normalize(posix.join(posix.dirname(relative), target));
      if (resolved === ".." || resolved.startsWith("../")) {
        throw new ArchiveError(`The link "${item.path}" points outside the archive's folder.`);
      }
      inside(resolved);
      links.push({ full, target, name: item.path, rel: relative });
      continue;
    }
    await mkdir(dirname(full), { recursive: true, mode: 0o755 });
    const mode = item.entry.unixMode ? item.entry.unixMode & 0o777 : 0o644;
    await writeFile(full, bytes, { mode: mode | 0o600 });
    result.files++;
  }
  const created: string[] = [];
  for (const link of links) {
    // A link is never made inside another link (which could put it anywhere on the server).
    let parent = root;
    for (const part of posix
      .dirname(link.rel)
      .split("/")
      .filter((item) => item !== ".")) {
      parent = join(parent, part);
      if ((await lstat(parent).catch(() => null))?.isSymbolicLink()) {
        for (const made of created) await unlink(made).catch(() => {});
        throw new ArchiveError(`The link "${link.name}" is inside another link.`);
      }
    }
    await mkdir(dirname(link.full), { recursive: true, mode: 0o755 });
    const existing = await lstat(link.full).catch(() => null);
    if (existing) throw new ArchiveError(`The archive holds "${link.name}" twice.`);
    await symlink(link.target, link.full);
    created.push(link.full);
    result.links++;
  }
  // Each link on its own looked fine; followed through the others, one may still lead out.
  const realRoot = await realpath(root);
  for (const link of links) {
    if (await linkStaysInside(realRoot, link.full)) continue;
    for (const made of created) await unlink(made).catch(() => {});
    throw new ArchiveError(
      `The link "${link.name}" points outside the archive's folder through another link.`,
    );
  }
  return result;
}

/** Joins a relative path to the folder, refusing anything outside it (for callers). */
export function within(root: string, relative: string): string {
  const full = resolve(root, relative);
  const base = resolve(root);
  if (full !== base && !full.startsWith(`${base}/`)) {
    throw new ArchiveError(`"${relative}" points outside the folder.`);
  }
  return join(full);
}
