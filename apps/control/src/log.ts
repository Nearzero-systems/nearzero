import type { LogLevel } from "@nearzero/shared";

/**
 * Structured logs: one JSON object per line on standard output, so `sudo nearzero logs` and any
 * log shipper can read them (spec 23.8). Fields whose names look like secrets are redacted before
 * anything is written (spec 23.4).
 */

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger that adds these fields to every line. */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  level: LogLevel;
  fields?: LogFields;
  /** Where lines go; standard output by default. */
  write?: (line: string) => void;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEY =
  /pass(word|phrase)?|secret|token|authorization|cookie|api[-_]?key|private[-_]?key|credential/i;

const REDACTED = "[redacted]";
const MAX_DEPTH = 6;

function serializeError(error: Error): LogFields {
  const fields: LogFields = { name: error.name, message: error.message };
  if (error.stack) fields.stack = error.stack;
  if ("code" in error && error.code !== undefined) fields.code = error.code;
  if (error.cause !== undefined) fields.cause = clean(error.cause, 1);
  return fields;
}

function clean(value: unknown, depth: number): unknown {
  if (value instanceof Error) return serializeError(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.map((item) => clean(item, depth + 1));
  const out: LogFields = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) ? REDACTED : clean(inner, depth + 1);
  }
  return out;
}

export function createLogger(options: LoggerOptions): Logger {
  const threshold = LEVEL_ORDER[options.level];
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const base = options.fields ?? {};

  const emit = (level: LogLevel, message: string, fields?: LogFields) => {
    if (LEVEL_ORDER[level] < threshold) return;
    const entry = clean({ ...base, ...fields }, 0) as LogFields;
    write(JSON.stringify({ time: new Date().toISOString(), level, msg: message, ...entry }));
  };

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (fields) => createLogger({ ...options, fields: { ...base, ...fields } }),
  };
}

/** A logger that drops everything, for tests that don't look at logs. */
export const silentLogger: Logger = createLogger({ level: "error", write: () => {} });
