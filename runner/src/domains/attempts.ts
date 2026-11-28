import { readFile } from "node:fs/promises";
import {
  type AttemptRecord,
  HOUR_MS,
  pausedUntil,
  RATE_LIMIT_DEFAULT_MS,
  retryAfterIn,
} from "@nearzero/shared";
import { writeFileAtomically } from "../router/files.ts";
import type { AcmeFailure } from "./acme.ts";

/**
 * The back-off of spec 10.7, kept on the server so it acts the moment a failure is logged: after
 * 3 failed validations in an hour a hostname is held until an hour after the first of them, and a
 * Let's Encrypt rate limit holds it until its retry-after time (or an hour). Kept in a file in
 * the runner's state folder, so a restart doesn't forget it.
 */

export type BackoffReason = "paused" | "rate_limited";

interface Entry {
  /** Failed validations: these count toward the pause. */
  failures: number[];
  lastError: string | null;
  /** When the last error happened, counted or not (R3-18). */
  lastErrorAt?: number | null;
  rateLimitedUntil: number | null;
  requestedAt: number | null;
  retriedAt: number | null;
}

/** Failures this old are forgotten (two hours covers every rule). */
const KEEP_MS = 2 * HOUR_MS;

export class AttemptTracker {
  readonly #file: string | null;
  readonly #entries = new Map<string, Entry>();
  readonly #now: () => number;
  #saving: ReturnType<typeof setTimeout> | null = null;
  /** The newest log time read, so a restart reads the router's log from there. */
  lastLogAt = 0;
  /**
   * Log entries already counted, by time and text. The router logs whole seconds, so two
   * failures in one second share a time; their errors differ (each names its own challenge), while
   * an entry read again after a reconnect is the same text.
   */
  readonly #counted: string[] = [];

  constructor(file: string | null, now: () => number = Date.now) {
    this.#file = file;
    this.#now = now;
  }

  async load(): Promise<void> {
    if (!this.#file) return;
    const text = await readFile(this.#file, "utf8").catch(() => null);
    if (!text) return;
    try {
      const data = JSON.parse(text) as { lastLogAt?: number; entries?: Record<string, Entry> };
      this.lastLogAt = data.lastLogAt ?? 0;
      for (const [hostname, entry] of Object.entries(data.entries ?? {}))
        this.#entries.set(hostname, entry);
    } catch {
      // A damaged file starts over.
    }
  }

  #entry(hostname: string): Entry {
    let entry = this.#entries.get(hostname);
    if (!entry) {
      entry = {
        failures: [],
        lastError: null,
        rateLimitedUntil: null,
        requestedAt: null,
        retriedAt: null,
      };
      this.#entries.set(hostname, entry);
    }
    return entry;
  }

  #changed(): void {
    if (!this.#file || this.#saving) return;
    this.#saving = setTimeout(() => {
      this.#saving = null;
      const now = this.#now();
      const entries: Record<string, Entry> = {};
      for (const [hostname, entry] of this.#entries) {
        entry.failures = entry.failures.filter((at) => at > now - KEEP_MS);
        entries[hostname] = entry;
      }
      void writeFileAtomically(
        this.#file as string,
        JSON.stringify({ lastLogAt: this.lastLogAt, entries }),
        0o600,
      ).catch(() => {});
    }, 500);
  }

  /** Records a failed attempt. Returns the hostnames that are backed off because of it. */
  failure(event: AcmeFailure): string[] {
    const key = `${event.at} ${event.hostnames.join(",")} ${event.raw || event.message}`;
    const repeated = this.#counted.includes(key);
    if (!repeated) {
      this.#counted.push(key);
      if (this.#counted.length > 500) this.#counted.shift();
    }
    const held: string[] = [];
    for (const hostname of event.hostnames) {
      const entry = this.#entry(hostname);
      entry.lastError = event.message;
      entry.lastErrorAt = Math.max(entry.lastErrorAt ?? 0, event.at);
      if (event.rateLimited) {
        entry.rateLimitedUntil = retryAfterIn(event.raw) ?? event.at + RATE_LIMIT_DEFAULT_MS;
      } else if (!repeated && event.counts !== false) {
        // Only checks Let's Encrypt made of the name pause it (spec 10.7, R3-18).
        entry.failures.push(event.at);
      }
      if (this.backoff(hostname)) held.push(hostname);
    }
    this.lastLogAt = Math.max(this.lastLogAt, event.at);
    this.#changed();
    return held;
  }

  /** The router started asking Let's Encrypt for a hostname (its hold was released). */
  requested(hostname: string): void {
    this.#entry(hostname).requestedAt = this.#now();
    this.#changed();
  }

  /** A Retry the control plane allowed: earlier failures no longer pause it. */
  retried(hostname: string): void {
    const entry = this.#entry(hostname);
    entry.retriedAt = this.#now();
    entry.requestedAt = this.#now();
    this.#changed();
  }

  /** Why a hostname must not ask Let's Encrypt now, or null. */
  backoff(hostname: string, now = this.#now()): BackoffReason | null {
    const entry = this.#entries.get(hostname);
    if (!entry) return null;
    if (entry.rateLimitedUntil !== null && entry.rateLimitedUntil > now) return "rate_limited";
    return pausedUntil(entry.failures, now, entry.retriedAt) === null ? null : "paused";
  }

  records(): AttemptRecord[] {
    const now = this.#now();
    return [...this.#entries].map(([hostname, entry]) => ({
      hostname,
      failures: entry.failures.filter((at) => at > now - KEEP_MS),
      lastError: entry.lastError,
      lastErrorAt: entry.lastErrorAt ?? null,
      rateLimitedUntil: entry.rateLimitedUntil,
      requestedAt: entry.requestedAt,
      retriedAt: entry.retriedAt,
    }));
  }

  /** Forgets hostnames that have no route any more. */
  keepOnly(hostnames: ReadonlySet<string>): void {
    let removed = false;
    for (const hostname of [...this.#entries.keys()]) {
      if (!hostnames.has(hostname)) {
        this.#entries.delete(hostname);
        removed = true;
      }
    }
    if (removed) this.#changed();
  }
}
