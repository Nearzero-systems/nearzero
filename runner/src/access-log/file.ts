import { open, stat } from "node:fs/promises";
import type { AccessLogPiece } from "@nearzero/shared";

/**
 * The router's request log as a file (spec 13): Traefik appends one JSON line per request. The
 * runner reads it in whole lines, keeps its newest lines on the cleanup schedule, and empties it
 * on "Delete all request logs". Traefik keeps the file open in append mode, so cutting it in
 * place (truncate, then write back the kept lines) leaves the router writing to its end.
 */

const NEWLINE = 0x0a;
const SCAN_BYTES = 1024 * 1024;

function missing(): AccessLogPiece {
  return { exists: false, size: 0, fileId: "", start: 0, end: 0, data: "" };
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** Whole lines from `fromOffset` (or from `tailBytes` before the end), at most `maxBytes`. */
export async function readPiece(
  path: string,
  fromOffset: number | null,
  maxBytes: number,
  tailBytes: number,
): Promise<AccessLogPiece> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (isMissing(error)) return missing();
    throw error;
  }
  try {
    const info = await handle.stat();
    const size = info.size;
    const fileId = `${info.dev}:${info.ino}`;
    let start: number;
    if (fromOffset === null || fromOffset > size) {
      start = Math.max(0, size - tailBytes);
      if (start > 0) {
        // Start at the beginning of the next whole line.
        const probe = Buffer.alloc(Math.min(SCAN_BYTES, size - start + 1));
        const { bytesRead } = await handle.read(probe, 0, probe.length, start - 1);
        const at = probe.subarray(0, bytesRead).indexOf(NEWLINE);
        start = at < 0 ? size : start - 1 + at + 1;
      }
    } else {
      start = fromOffset;
    }
    const length = Math.min(maxBytes, size - start);
    if (length <= 0) return { exists: true, size, fileId, start, end: start, data: "" };
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    const bytes = buffer.subarray(0, bytesRead);
    const last = bytes.lastIndexOf(NEWLINE);
    let end: number;
    if (last >= 0) end = start + last + 1;
    else if (bytesRead === maxBytes)
      end = start + bytesRead; // One line longer than a piece.
    else end = start; // A line still being written.
    return {
      exists: true,
      size,
      fileId,
      start,
      end,
      data: bytes.subarray(0, end - start).toString("base64"),
    };
  } finally {
    await handle.close();
  }
}

/** Keeps the newest `keepLines` lines. Returns how many lines were kept and removed (roughly). */
export async function trimToNewest(
  path: string,
  keepLines: number,
): Promise<{ kept: number; removedBytes: number }> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "r+");
  } catch (error) {
    if (isMissing(error)) return { kept: 0, removedBytes: 0 };
    throw error;
  }
  try {
    const size = (await handle.stat()).size;
    if (size === 0) return { kept: 0, removedBytes: 0 };
    // Walk back from the end counting newlines; the last byte is the final line's newline.
    let position = size;
    let newlines = 0;
    let cut = 0;
    const buffer = Buffer.alloc(SCAN_BYTES);
    scan: while (position > 0) {
      const length = Math.min(SCAN_BYTES, position);
      position -= length;
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      for (let index = bytesRead - 1; index >= 0; index--) {
        if (buffer[index] !== NEWLINE) continue;
        newlines++;
        if (newlines > keepLines) {
          cut = position + index + 1;
          break scan;
        }
      }
    }
    if (cut === 0) return { kept: newlines, removedBytes: 0 };
    const tail = Buffer.alloc(size - cut);
    const { bytesRead } = await handle.read(tail, 0, tail.length, cut);
    await handle.truncate(0);
    if (bytesRead > 0) await handle.write(tail, 0, bytesRead, 0);
    return { kept: keepLines, removedBytes: cut };
  } finally {
    await handle.close();
  }
}

export async function clearFile(path: string): Promise<void> {
  try {
    const handle = await open(path, "r+");
    try {
      await handle.truncate(0);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

export async function fileSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}
