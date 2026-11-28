/**
 * A minimal tar writer (POSIX ustar, from the format's public description) for putting a few
 * files into a container before it starts: file mounts and key files. Directories listed are
 * created with their mode and owner; files are written whole.
 */

export interface TarEntry {
  /** Relative path inside the archive, with "/" separators, no "..". */
  path: string;
  type: "file" | "directory";
  content?: Uint8Array;
  mode: number;
  uid: number;
  gid: number;
}

const BLOCK = 512;

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function header(entry: TarEntry, size: number): Uint8Array {
  const block = new Uint8Array(BLOCK);
  const encoder = new TextEncoder();
  let name =
    entry.type === "directory" && !entry.path.endsWith("/") ? `${entry.path}/` : entry.path;
  let prefix = "";
  if (encoder.encode(name).length > 100) {
    const split = name.lastIndexOf("/", name.length - 2);
    prefix = name.slice(0, split);
    name = name.slice(split + 1);
    if (encoder.encode(name).length > 100 || encoder.encode(prefix).length > 155) {
      throw new Error(`The path ${entry.path} is too long for a file mount.`);
    }
  }
  const put = (text: string, offset: number) => block.set(encoder.encode(text), offset);
  put(name, 0);
  put(octal(entry.mode & 0o7777, 8), 100);
  put(octal(entry.uid, 8), 108);
  put(octal(entry.gid, 8), 116);
  put(octal(size, 12), 124);
  put(octal(Math.floor(Date.now() / 1000), 12), 136);
  put("        ", 148);
  put(entry.type === "directory" ? "5" : "0", 156);
  put("ustar\u000000", 257);
  put(prefix, 345);
  let sum = 0;
  for (const byte of block) sum += byte;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return block;
}

export function createTar(entries: readonly TarEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    const content = entry.type === "file" ? (entry.content ?? new Uint8Array()) : new Uint8Array();
    parts.push(header(entry, content.length));
    if (content.length > 0) {
      parts.push(content);
      const padding = (BLOCK - (content.length % BLOCK)) % BLOCK;
      if (padding) parts.push(new Uint8Array(padding));
    }
  }
  parts.push(new Uint8Array(BLOCK * 2));
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
