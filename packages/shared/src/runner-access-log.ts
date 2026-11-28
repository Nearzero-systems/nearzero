import { z } from "zod";

/**
 * Runner commands for the router's request log (spec 13): Traefik writes one JSON line per
 * request, without buffering, to `access-log/access.log` in the router folder; the control plane
 * reads it through these commands. New command kinds, so older runners answer "unsupported".
 *
 * Reading is in pieces of at most 2 MB (one WebSocket frame holds 4 MB), from an offset the
 * control plane remembers, so a page load reads only what is new; a first read starts at most
 * `tailBytes` from the end, at the start of a line.
 */

export const ACCESS_LOG_FILE = "access.log";
export const ACCESS_LOG_FOLDER = "access-log";
/** The most of the log that is ever read (spec 13.1). */
export const ACCESS_LOG_READ_LIMIT_BYTES = 32 * 1024 * 1024;
export const ACCESS_LOG_PIECE_BYTES = 2 * 1024 * 1024;
/** Each cleanup keeps the newest requests (spec 13.1). */
export const ACCESS_LOG_KEEP_LINES = 10_000;

export const accessLogCommandSchemas = {
  /** Turns the router's request log on or off; the router is recreated in the background. */
  "access-log.configure": z.object({ enabled: z.boolean() }),
  /** Whether it is on, the file's size and whether the router runs with it. */
  "access-log.status": z.object({}),
  /** A piece of the file: from `fromOffset`, or (null) from `tailBytes` before the end. */
  "access-log.read": z.object({
    fromOffset: z.number().int().min(0).nullable(),
    maxBytes: z.number().int().min(1).max(ACCESS_LOG_PIECE_BYTES).default(ACCESS_LOG_PIECE_BYTES),
    tailBytes: z
      .number()
      .int()
      .min(1)
      .max(ACCESS_LOG_READ_LIMIT_BYTES)
      .default(ACCESS_LOG_READ_LIMIT_BYTES),
  }),
  /** Keeps only the newest lines (the cleanup schedule). */
  "access-log.trim": z.object({
    keepLines: z.number().int().min(0).max(1_000_000).default(ACCESS_LOG_KEEP_LINES),
  }),
  /** Deletes every recorded request. */
  "access-log.clear": z.object({}),
} as const;

export type AccessLogCommandKind = keyof typeof accessLogCommandSchemas;

export interface AccessLogStatus {
  enabled: boolean;
  /** The router container runs with the request log as configured. */
  applied: boolean;
  exists: boolean;
  sizeBytes: number;
}

export interface AccessLogPiece {
  exists: boolean;
  /** The file's size when read. */
  size: number;
  /** The file's identity (inode); a new one means the file was replaced. */
  fileId: string;
  /** Where the piece starts and ends in the file; `end` is after the piece's last newline. */
  start: number;
  end: number;
  /** Base64 of the bytes from start to end (whole lines only). */
  data: string;
}
