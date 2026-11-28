/**
 * The runner's own log: one JSON line per event on standard output, which systemd or Docker
 * keeps. Fields whose names look like secrets are never written.
 */

export type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_FIELD = /pass(word)?|secret|token|credential|auth|private/i;

export interface Log {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export function createLog(
  level: Level = "info",
  write: (line: string) => void = (line) => console.log(line),
): Log {
  const emit = (at: Level, message: string, fields: Record<string, unknown> = {}) => {
    if (ORDER[at] < ORDER[level]) return;
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      safe[key] = SECRET_FIELD.test(key) ? "[redacted]" : value;
    }
    write(JSON.stringify({ time: new Date().toISOString(), level: at, message, ...safe }));
  };
  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}

export const silentLog: Log = { debug() {}, info() {}, warn() {}, error() {} };
