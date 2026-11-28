import { mkdir } from "node:fs/promises";
import {
  type CommandKind,
  type ContainerState,
  type ControlMessage,
  commandParamsSchemas,
  decodeChunk,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  isCommandKind,
  type MetricsSample,
  parseControlMessage,
  RUNNER_CLOSE,
  RUNNER_CONNECT_PATH,
  RUNNER_PROTOCOL_MIN_SUPPORTED,
  RUNNER_PROTOCOL_VERSION,
  type RunnerChecks,
  type RunnerMessage,
  STREAMING_COMMANDS,
  VERSION,
} from "@nearzero/shared";
import { DEFAULT_BUILDERS_DIR } from "../tools/pins.ts";
import { type CommandContext, CommandError, handlerFor, toRunnerError } from "./commands.ts";
import type { DockerClient } from "./docker/client.ts";
import {
  type ConfiguredLinks,
  type ControlLink,
  forgetSavedLinks,
  linkFetch,
  linkKind,
  linkPins,
  openLinkSocket,
  readSavedLinks,
  remoteLinkProblem,
  sameLink,
  saveLinks,
} from "./link/link.ts";
import { LINK_HIGH_WATER_BYTES } from "./link/socket.ts";
import type { Log } from "./log.ts";
import { MetricsCollector, metricsIntervalMs, systemInfo } from "./metrics.ts";
import { CHECK_EVERY_MS, FIRST_CHECK_AFTER_MS } from "./router/holds.ts";
import type { Router } from "./router/router.ts";
import { RunnerStream, type StreamMessage } from "./streams/stream.ts";

/**
 * The runner's link to the control plane (docs/runner-protocol.md): one WebSocket it opens and
 * keeps open, reconnecting with backoff. Work outlives the link: commands keep running, stream
 * output collects in buffers, results wait in an outbox, and metrics are kept for an hour, so a
 * reconnect (or a control-plane restart) loses nothing the runner still holds.
 */

/** Reconnect delays: 1 s doubling to 30 s, with jitter so servers don't all return at once. */
export function reconnectDelay(attempt: number, random = Math.random): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.75 + random() * 0.5));
}

/** After a refusal for versions, wait this long before asking again. */
const REFUSED_RETRY_MS = 5 * 60_000;
/** Samples kept while the link is down: an hour at one per 5 seconds. */
const METRICS_KEPT = 720;
/** How often the full state is sent even when nothing changed. */
const STATE_EVERY_MS = 30_000;
/** Ended streams the control plane never acknowledged are dropped after this. */
const ENDED_STREAM_TTL_MS = 15 * 60_000;
/** Results the control plane never confirmed are dropped after this. */
const RESULT_TTL_MS = 60 * 60_000;
/** How often the router is checked (and restarted when it stopped). */
const ROUTER_CHECK_MS = 60_000;
/**
 * An address the runner was moved to and couldn't use is checked again this often, with a check
 * request alone, and the runner moves once it answers (C4-09); until then it isn't tried.
 */
export const DECLINE_RECHECK_MS = 5 * 60_000;
/** The address in use failing this many times in a row gives way to the pinned fallback. */
const SAVED_LINK_FAILURES = 5;

export interface SessionOptions {
  /** The address the runner's settings give (setup's runner.env, or the join command). */
  controlUrl: string;
  /** The pinned certificate fingerprint for that address, when it has one. */
  controlFingerprint?: string | null;
  /**
   * The control plane's own TLS port with its fingerprint, tried when the address in use stops
   * answering (setup's NEARZERO_CONTROL_FALLBACK_URL; C4-06). The welcome gives it too.
   */
  controlFallback?: ControlLink | null;
  /**
   * True only for the Nearzero host's own runner on the host's private network. Any other runner
   * refuses a plain http:// address (spec 31 "Remote runners are always encrypted").
   */
  allowPlain?: boolean;
  /** For tests: how often declined addresses are checked again (DECLINE_RECHECK_MS). */
  declineRecheckMs?: number;
  /** For tests: the wait before the next connection attempt (reconnectDelay). */
  retryDelay?: (attempt: number) => number;
  /**
   * Where the address the control plane moved this runner to is kept (beside the credential);
   * without it a move lasts until the runner stops.
   */
  stateDirectory?: string;
  credential: () => Promise<string | null>;
  /** Called when the control plane refuses the credential; may return a fresh one (re-enroll). */
  onCredentialRefused: (message: string, link: ControlLink) => Promise<string | null>;
  docker: DockerClient;
  router: Router;
  manageRouter: boolean;
  log: Log;
  workDirectory: string;
  dockerSocket: string;
  containerized: boolean;
  /** Where the pinned builder tools live; defaults to /usr/local/lib/nearzero/builders. */
  buildersDir?: string;
  /** For tests: the WebSocket constructor and the credential check. */
  connect?: (url: string, credential: string, link: ControlLink) => WebSocket;
  check?: (
    credential: string,
    link: ControlLink,
  ) => Promise<{ result: "accepted" | "refused" | "unreachable"; message: string }>;
}

interface RunningCommand {
  kind: CommandKind;
  abort: AbortController;
}

export class RunnerSession {
  readonly #options: SessionOptions;
  readonly #log: Log;
  #socket: WebSocket | null = null;
  #welcomed = false;
  #stopped = false;
  #attempt = 0;
  #lastHeard = 0;
  #heartbeatSeq = 0;
  readonly #commands = new Map<string, RunningCommand>();
  /** Every command handler still running, clean-up included. */
  readonly #handlers = new Set<Promise<unknown>>();
  readonly #outbox = new Map<string, { message: RunnerMessage; at: number }>();
  readonly #streams = new Map<string, RunnerStream>();
  /** Which stream each running streaming command writes to. */
  readonly #streamOf = new Map<string, string>();
  readonly #metrics: MetricsSample[] = [];
  readonly #collector = new MetricsCollector();
  readonly #timers: ReturnType<typeof setInterval>[] = [];
  #containers: ContainerState[] = [];
  #stateTimer: ReturnType<typeof setTimeout> | null = null;
  #eventsAbort: AbortController | null = null;
  #wake: (() => void) | null = null;
  /** The address from the settings. */
  readonly #configured: ControlLink;
  /** The address in use: the one the control plane moved this runner to, or the configured one. */
  #current: ControlLink;
  /** The fallback the settings give (NEARZERO_CONTROL_FALLBACK_*), or null. */
  readonly #configuredFallback: ControlLink | null;
  /** The pinned TLS port, tried when the address in use stops answering (C4-06). */
  #fallback: ControlLink | null;
  /**
   * Fingerprints the control plane replaced (C4-12), never accepted again from anywhere: the
   * settings, the saved file, a move. Kept beside the credential.
   */
  readonly #retired = new Set<string>();
  /** An address the control plane moved this runner to (or its fallback), being tried. */
  #trying: ControlLink | null = null;
  /** Addresses this runner was moved to and couldn't use, with why and when. */
  readonly #declined = new Map<string, { link: ControlLink; reason: string; at: number }>();
  /** The declined addresses as the last hello listed them, which the welcome is read against. */
  #helloDeclined = new Set<string>();
  /** Failed connections in a row to the current address. */
  #failures = 0;
  readonly startedAt = Date.now();
  /** Exposed for tests and the e2e suite. */
  serverId: string | null = null;
  connections = 0;

  constructor(options: SessionOptions) {
    this.#options = options;
    this.#log = options.log;
    this.#configured = { url: options.controlUrl, fingerprint: options.controlFingerprint ?? null };
    this.#current = this.#configured;
    // The host's own runner, on the host's private network, has no fallback (C4-16).
    this.#configuredFallback =
      !options.allowPlain && options.controlFallback?.fingerprint ? options.controlFallback : null;
    this.#fallback = this.#configuredFallback;
  }

  /** What the settings give, which the saved file is read against. */
  get #settings(): ConfiguredLinks {
    return { link: this.#configured, fallback: this.#configuredFallback };
  }

  /** Fingerprints this runner no longer accepts (exposed for tests). */
  get retired(): string[] {
    return [...this.#retired];
  }

  /**
   * The link without its retired fingerprints: the next one stands in when only the current one
   * was replaced; null when nothing is left to accept. Links without a pin are as they are.
   */
  #withoutRetired(link: ControlLink | null): ControlLink | null {
    if (!link?.fingerprint) return link;
    const left = linkPins(link).filter((pin) => !this.#retired.has(pin));
    const [fingerprint, next] = left;
    if (!fingerprint) return null;
    return { url: link.url, fingerprint, ...(next ? { nextFingerprint: next } : {}) };
  }

  /**
   * Retires every fingerprint known for `url` except `keep` (C4-12): the control plane gave a
   * newer pin for that address, so an older one, whether from the settings, the saved file or the
   * address in use, is never accepted again.
   */
  #retireOthers(url: string, keep: readonly string[]): boolean {
    let changed = false;
    for (const known of [
      this.#current,
      this.#fallback,
      this.#configured,
      this.#configuredFallback,
    ]) {
      if (!known || known.url !== url) continue;
      for (const pin of linkPins(known)) {
        if (keep.includes(pin) || this.#retired.has(pin)) continue;
        this.#retired.add(pin);
        changed = true;
      }
    }
    return changed;
  }

  #retryDelay(attempt: number): number {
    return (this.#options.retryDelay ?? reconnectDelay)(attempt);
  }

  /** The pinned fallback this runner knows (exposed for tests). */
  get fallback(): ControlLink | null {
    return this.#fallback;
  }

  get connected(): boolean {
    return this.#welcomed;
  }

  /** The address the runner reaches the control plane at now. */
  get link(): ControlLink {
    return this.#current;
  }

  // ---- Lifecycle

  async run(): Promise<void> {
    await mkdir(this.#options.workDirectory, { recursive: true, mode: 0o700 }).catch(() => {});
    // The host's own runner keeps nothing: it is never moved and has no fallback (C4-16).
    if (this.#options.stateDirectory && !this.#options.allowPlain) {
      const saved = await readSavedLinks(this.#options.stateDirectory, this.#settings);
      for (const pin of saved?.retired ?? []) this.#retired.add(pin);
      if (saved?.link) {
        // Saved for these very settings, so newer than them: what the control plane said last.
        this.#current = saved.link;
        this.#fallback = saved.fallback ?? this.#configuredFallback;
        // A newer pin for an address the settings pin too retires the settings' one (C4-12): the
        // control plane replaced it (`nearzero runner-link switch`).
        for (const newer of [saved.link, saved.fallback]) {
          if (newer?.fingerprint) this.#retireOthers(newer.url, linkPins(newer));
        }
        if (!sameLink(saved.link, this.#configured)) {
          this.#log.info("using the address Nearzero moved this runner to", {
            control: saved.link.url,
          });
        }
      }
      this.#fallback = this.#withoutRetired(this.#fallback);
      const current = this.#withoutRetired(this.#current);
      if (!current) {
        this.#log.error(
          "The runner won't connect: every certificate fingerprint it has for Nearzero was replaced. Run setup again on the server.",
          { control: this.#current.url },
        );
        this.#stopped = true;
        return;
      }
      this.#current = current;
    }
    // A remote runner never uses a plain or unpinned address (spec 31, C4-02, C4-04): it doesn't
    // connect at all, so its credential never crosses the network unencrypted.
    const problem = this.#options.allowPlain ? null : remoteLinkProblem(this.#current);
    if (problem) {
      this.#log.error(`The runner won't connect: ${problem}`, { control: this.#current.url });
      this.#stopped = true;
      return;
    }
    this.#startBackground();
    while (!this.#stopped) {
      const delay = await this.#connectOnce();
      if (this.#stopped) break;
      await this.#sleep(delay);
    }
  }

  stop(): void {
    this.#stopped = true;
    for (const timer of this.#timers) clearInterval(timer);
    this.#eventsAbort?.abort();
    for (const command of this.#commands.values()) command.abort.abort();
    this.#socket?.close(1000, "runner stopping");
    this.#wake?.();
  }

  /**
   * After stop(): waits, at most `ms`, for the stopped commands' own clean-up, so a backup that
   * stopped a service starts it again before the process ends (C2-02).
   */
  async drain(ms: number): Promise<void> {
    if (this.#handlers.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...this.#handlers]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
    clearTimeout(timer);
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#wake = null;
        resolve();
      }, ms);
      this.#wake = () => {
        clearTimeout(timer);
        this.#wake = null;
        resolve();
      };
    });
  }

  /** One connection, from the credential check to the close. Returns the delay before the next. */
  /** The control plane moved this runner somewhere it couldn't connect: go back, say why. */
  #decline(link: ControlLink, reason: string): number {
    this.#trying = null;
    this.#declined.set(link.url, { link, reason: reason.slice(0, 500), at: Date.now() });
    while (this.#declined.size > 5) {
      const oldest = this.#declined.keys().next().value;
      if (oldest === undefined) break;
      this.#declined.delete(oldest);
    }
    this.#log.warn("couldn't use the address Nearzero moved this runner to; staying where it was", {
      tried: link.url,
      reason,
      control: this.#current.url,
    });
    return 0;
  }

  /**
   * A connection to the address in use failed before its welcome. After a few in a row the runner
   * tries its pinned fallback, or the address its settings give when that is encrypted; never a
   * plain one (C4-02, C4-06).
   */
  #failed(): void {
    this.#failures++;
    // The host's own runner stays on its internal address (C4-16).
    if (this.#failures < SAVED_LINK_FAILURES || this.#trying || this.#options.allowPlain) return;
    // Never a replaced fingerprint (C4-12): a settings pin the control plane replaced is left out.
    const candidates = [this.#fallback, this.#configured, this.#configuredFallback]
      .map((candidate) => this.#withoutRetired(candidate))
      .filter(
        (candidate): candidate is ControlLink =>
          candidate !== null &&
          !sameLink(candidate, this.#current) &&
          remoteLinkProblem(candidate) === null,
      );
    const next = candidates[0];
    if (!next) return;
    this.#log.warn("the address this runner uses isn't answering; trying its fallback", {
      control: this.#current.url,
      fallback: next.url,
    });
    this.#trying = next;
    this.#failures = 0;
  }

  /**
   * Addresses this runner declined are asked again in the background, with a check request alone,
   * so the link in use isn't dropped to find out (C4-09); one that answers is moved to.
   */
  async #recheckDeclined(): Promise<void> {
    if (!this.#welcomed || this.#trying || this.#declined.size === 0 || !this.#options.check)
      return;
    const credential = await this.#options.credential();
    if (!credential) return;
    for (const [url, entry] of [...this.#declined]) {
      const answer = await this.#options.check(credential, entry.link).catch((error: unknown) => ({
        result: "unreachable" as const,
        message: (error as Error).message,
      }));
      if (answer.result !== "accepted") {
        entry.reason = answer.message.slice(0, 500);
        entry.at = Date.now();
        continue;
      }
      this.#declined.delete(url);
      if (!this.#welcomed || this.#trying) return;
      this.#log.info("an address this runner couldn't use answers now; moving there", {
        to: url,
      });
      this.#trying = entry.link;
      this.#socket?.close(RUNNER_CLOSE.reconnect, "moving");
      return;
    }
  }

  /** One connection, from the credential check to the close. Returns the delay before the next. */
  async #connectOnce(): Promise<number> {
    const link = this.#trying ?? this.#current;
    const trying = this.#trying !== null;
    let credential = await this.#options.credential();
    if (!credential) {
      this.#log.warn("no credential yet; waiting for a join token");
      return this.#retryDelay(this.#attempt++);
    }
    const check = this.#options.check
      ? await this.#options.check(credential, link)
      : { result: "accepted" as const, message: "" };
    if (check.result === "refused") {
      if (trying) return this.#decline(link, check.message);
      this.#log.warn("the control plane refused this runner's credential", {
        reason: check.message,
      });
      credential = await this.#options.onCredentialRefused(check.message, link);
      if (!credential) return Math.max(this.#retryDelay(this.#attempt++), 15_000);
    } else if (check.result === "unreachable") {
      if (trying) return this.#decline(link, check.message);
      this.#log.warn("can't reach the control plane", { reason: check.message, control: link.url });
      this.#failed();
      return this.#retryDelay(this.#attempt++);
    }

    const headers = { authorization: `Bearer ${credential}` };
    let socket: WebSocket;
    try {
      socket = this.#options.connect
        ? this.#options.connect(new URL(RUNNER_CONNECT_PATH, link.url).toString(), credential, link)
        : (openLinkSocket(link, RUNNER_CONNECT_PATH, headers) as unknown as WebSocket);
    } catch (error) {
      if (trying) return this.#decline(link, (error as Error).message);
      this.#log.warn("can't reach the control plane", { reason: (error as Error).message });
      return this.#retryDelay(this.#attempt++);
    }
    this.#socket = socket;
    this.#lastHeard = Date.now();
    let nextDelay = 0;
    let closeReason = "";
    let welcomedHere = false;
    let leaving = false;

    await new Promise<void>((resolve) => {
      socket.addEventListener("open", () => {
        void this.#sendHello(link);
      });
      socket.addEventListener("message", (event) => {
        this.#lastHeard = Date.now();
        const message = parseControlMessage(String(event.data));
        if (!message) {
          this.#log.warn("closing: a message from the control plane didn't follow the protocol");
          socket.close(RUNNER_CLOSE.protocolError, "protocol error");
          return;
        }
        if (message.type === "refused") {
          this.#log.error(message.message);
          closeReason = message.message;
          nextDelay = message.reason === "revoked" ? 15_000 : REFUSED_RETRY_MS;
          return;
        }
        if (message.type === "welcome") {
          welcomedHere = this.#welcome(message, link, socket);
          if (!welcomedHere) {
            leaving = true;
            return;
          }
        }
        void this.#handle(message).catch((error: unknown) =>
          this.#log.warn("couldn't handle a message", { reason: (error as Error).message }),
        );
      });
      socket.addEventListener("close", (event) => {
        const wasWelcomed = this.#welcomed;
        this.#detach();
        if (this.#socket === socket) this.#socket = null;
        if (!closeReason) closeReason = (event as CloseEvent).reason || `closed (${event.code})`;
        if (wasWelcomed)
          this.#log.info("disconnected from the control plane", { code: event.code });
        resolve();
      });
      socket.addEventListener("error", (event) => {
        // A close event follows.
        const message = (event as unknown as { message?: string }).message;
        if (message) closeReason = message;
      });
    });

    if (this.#stopped) return 0;
    if (!welcomedHere && !leaving) {
      if (trying && this.#trying === link) return this.#decline(link, closeReason);
      if (!trying) this.#failed();
    }
    // Moving on to another address: at once.
    if (this.#trying && !sameLink(this.#trying, link)) return 0;
    if (nextDelay > 0) return nextDelay;
    return this.#retryDelay(this.#attempt++);
  }

  /**
   * A welcome on `link`. With a new address in it that this runner hasn't declined, nothing else
   * in the welcome is acted on: the runner leaves and tries the new address (spec 31 "Remote
   * runners are always encrypted"), and comes back here if it can't use it. Only a pinned address
   * or an https:// host name is followed, never a plain one, an IP address without its pin
   * (C4-04) or a replaced fingerprint (C4-12). The pinned fallback and a next fingerprint in it
   * are kept, and every other fingerprint for that address is retired. The host's own runner
   * takes none of this (C4-16). Returns whether the welcome is for this connection.
   */
  #welcome(
    message: Extract<ControlMessage, { type: "welcome" }>,
    link: ControlLink,
    socket: WebSocket,
  ): boolean {
    this.#failures = 0;
    if (this.#options.allowPlain) {
      // The control plane never moves the host's runner or gives it pins: whatever answered on
      // the private network and says otherwise isn't followed.
      if (message.link || message.fallback || message.nextFingerprint) {
        this.#log.warn("ignoring an address offered to the Nearzero host's own runner", {
          control: link.url,
        });
      }
      return true;
    }
    const offered = message.link ?? null;
    if (offered && !sameLink(offered, link) && !this.#helloDeclined.has(offered.url)) {
      const usable = this.#withoutRetired(offered);
      const problem =
        remoteLinkProblem(offered) ??
        (usable && sameLink(usable, offered)
          ? null
          : `${offered.url}'s certificate fingerprint was replaced, so this runner no longer accepts it.`);
      if (problem) {
        this.#log.error(`Nearzero offered an address this runner won't use: ${problem}`);
        socket.close(RUNNER_CLOSE.protocolError, "refused move");
        return false;
      }
      this.#log.info("Nearzero moved this runner to another address", {
        from: link.url,
        to: offered.url,
      });
      this.#trying = offered;
      socket.close(RUNNER_CLOSE.reconnect, "moving");
      return false;
    }
    let changed = false;
    if (this.#trying && sameLink(this.#trying, link)) {
      // Welcomed at the address it was moved to (or fell back to): that's where it stays.
      this.#trying = null;
      this.#current = link;
      this.#declined.delete(link.url);
      changed = true;
      this.#log.info("now reaching Nearzero at its new address", { control: link.url });
    }
    // The pinned fallback, and the pins of the address in use (C4-06, C4-10, C4-12).
    const fallback = message.fallback
      ? { url: message.fallback.url, fingerprint: message.fallback.fingerprint }
      : null;
    if (fallback && remoteLinkProblem(fallback) === null) {
      const keep = [fallback.fingerprint, message.nextFingerprint].filter((pin): pin is string =>
        Boolean(pin),
      );
      // The newest pins the control plane gave for that address: any other is retired, also the
      // one setup wrote into the settings, so it is never tried again after five failures.
      if (this.#retireOthers(fallback.url, keep)) changed = true;
      for (const pin of keep) this.#retired.delete(pin);
      const pinned: ControlLink = {
        url: fallback.url,
        fingerprint: fallback.fingerprint,
        ...(message.nextFingerprint ? { nextFingerprint: message.nextFingerprint } : {}),
      };
      const nextCurrent =
        this.#current.url === fallback.url && linkKind(this.#current).kind === "pinned"
          ? pinned
          : this.#current;
      if (
        !sameLink(pinned, this.#fallback) ||
        (pinned.nextFingerprint ?? null) !== (this.#fallback?.nextFingerprint ?? null) ||
        !sameLink(nextCurrent, this.#current) ||
        (nextCurrent.nextFingerprint ?? null) !== (this.#current.nextFingerprint ?? null)
      ) {
        this.#fallback = pinned;
        this.#current = nextCurrent;
        changed = true;
      }
    }
    if (changed) this.#persist();
    return true;
  }

  /** Keeps the address in use, the fallback and the retired fingerprints beside the credential. */
  #persist(): void {
    const directory = this.#options.stateDirectory;
    if (!directory || this.#options.allowPlain) return;
    const retired = [...this.#retired];
    const store =
      sameLink(this.#current, this.#configured) &&
      !this.#current.nextFingerprint &&
      !this.#fallback &&
      retired.length === 0
        ? forgetSavedLinks(directory)
        : saveLinks(
            directory,
            { link: this.#current, fallback: this.#fallback, retired },
            this.#settings,
          );
    void store.catch((error: unknown) =>
      this.#log.warn("couldn't save the addresses this runner was given", {
        reason: (error as Error).message,
      }),
    );
  }

  #detach(): void {
    this.#welcomed = false;
    for (const stream of this.#streams.values()) stream.detach();
  }

  /** Forces a reconnect (used by tests and the e2e suite). */
  dropConnection(): void {
    this.#socket?.close(RUNNER_CLOSE.reconnect, "reconnect");
  }

  // ---- Sending

  #send(message: RunnerMessage | StreamMessage): boolean {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    if (message.type !== "hello" && !this.#welcomed) return false;
    // Flow control (C4-07): while the link holds more than the high-water mark unsent, stream
    // output and metrics stay in their own bounded buffers (the oldest bytes go, as when the
    // link is down) and are pumped again once it drains.
    if (
      (message.type === "stream.data" || message.type === "metrics") &&
      socket.bufferedAmount > LINK_HIGH_WATER_BYTES
    ) {
      this.#waitForDrain(socket);
      return false;
    }
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  /** The socket a drain is awaited on, so streams are pumped once when it empties. */
  #drainWait: WebSocket | null = null;

  #waitForDrain(socket: WebSocket): void {
    if (this.#drainWait === socket) return;
    this.#drainWait = socket;
    let timer: ReturnType<typeof setInterval> | null = null;
    const onDrain = () => {
      if (this.#socket === socket && socket.bufferedAmount > LINK_HIGH_WATER_BYTES / 2) return;
      socket.removeEventListener("drain", onDrain);
      if (timer) clearInterval(timer);
      if (this.#drainWait === socket) this.#drainWait = null;
      if (this.#socket !== socket || !this.#welcomed) return;
      for (const stream of this.#streams.values()) stream.flush();
      this.#flushMetrics();
    };
    socket.addEventListener("drain", onDrain);
    // Sockets without a drain event (and a drain that came while above half the mark).
    timer = setInterval(onDrain, 250);
    timer.unref?.();
  }

  readonly #streamSender = (message: StreamMessage) => this.#send(message);

  /** A request to the control plane with this runner's credential (uploaded archives). */
  readonly #controlFetch = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const credential = await this.#options.credential();
    if (!credential) throw new CommandError("failed", "This runner has no credential yet.");
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${credential}`);
    return linkFetch(this.#current)(new URL(path, this.#current.url), { ...init, headers });
  };

  async #checks(): Promise<RunnerChecks> {
    const docker = await this.#options.docker
      .negotiate()
      .then(() => true)
      .catch(() => false);
    if (!docker) return { docker: false, network: false, router: false, routerDirectory: false };
    const network = await this.#options.docker
      .findNetwork(this.#options.router.settings.network)
      .then((found) => found !== null)
      .catch(() => false);
    const router = this.#options.manageRouter ? await this.#options.router.isRunning() : true;
    const routerDirectory = await Bun.file(`${this.#options.router.settings.directory}/.`)
      .exists()
      .catch(() => false);
    return { docker, network, router, routerDirectory: routerDirectory || router };
  }

  async #sendHello(link: ControlLink): Promise<void> {
    const system = await systemInfo(this.#options.docker, this.#options.containerized);
    const checks = await this.#checks();
    const declined = [...this.#declined.entries()]
      .slice(-5)
      .map(([url, entry]) => ({ url, reason: entry.reason }));
    this.#helloDeclined = new Set(declined.map((item) => item.url));
    this.#send({
      type: "hello",
      runnerVersion: VERSION,
      protocol: RUNNER_PROTOCOL_VERSION,
      minProtocol: RUNNER_PROTOCOL_MIN_SUPPORTED,
      startedAt: this.startedAt,
      system,
      checks,
      streams: [...this.#streams.values()].map((stream) => ({
        streamId: stream.id,
        firstOffset: stream.buffer.firstOffset,
        endOffset: stream.buffer.endOffset,
        ended: stream.ended,
      })),
      commands: [
        ...[...this.#commands.keys()].map((commandId) => ({ commandId, finished: false })),
        ...[...this.#outbox.keys()].map((commandId) => ({ commandId, finished: true })),
      ],
      link: {
        url: link.url,
        declined,
        ...((link.nextFingerprint ?? this.#fallback?.nextFingerprint)
          ? { next: (link.nextFingerprint ?? this.#fallback?.nextFingerprint) as string }
          : {}),
      },
    });
  }

  // ---- Receiving

  async #handle(message: ControlMessage): Promise<void> {
    switch (message.type) {
      case "welcome": {
        this.#welcomed = true;
        this.#attempt = 0;
        this.connections++;
        this.serverId = message.serverId;
        this.#options.router.setPublicIPv4(message.publicIPv4);
        this.#log.info("connected to the control plane", {
          server: message.serverName,
          protocol: message.protocol,
        });
        for (const commandId of message.received) this.#outbox.delete(commandId);
        const resume = new Map(message.resume.map((item) => [item.streamId, item.offset]));
        for (const stream of [...this.#streams.values()]) {
          const offset = resume.get(stream.id);
          if (offset === undefined) {
            // Nobody follows it any more.
            this.#dropStream(stream.id);
          } else {
            stream.resume(this.#streamSender, offset);
          }
        }
        for (const { message: result } of this.#outbox.values()) this.#send(result);
        this.#flushMetrics();
        void this.#sendState();
        return;
      }
      case "command":
        this.#startCommand(message);
        return;
      case "cancel":
        this.#commands
          .get(message.commandId)
          ?.abort.abort(new CommandError("cancelled", "cancelled"));
        return;
      case "result.received":
        this.#outbox.delete(message.commandId);
        return;
      case "stream.ack": {
        const stream = this.#streams.get(message.streamId);
        stream?.ack(message.offset);
        if (stream?.finished) this.#streams.delete(stream.id);
        return;
      }
      case "stream.input":
        this.#streams.get(message.streamId)?.input(decodeChunk(message.data));
        return;
      case "stream.resize":
        this.#streams.get(message.streamId)?.resize(message.cols, message.rows);
        return;
      case "stream.close":
        this.#dropStream(message.streamId);
        return;
      case "heartbeat.ack":
        return;
      case "refused":
        return;
    }
  }

  #dropStream(streamId: string): void {
    const stream = this.#streams.get(streamId);
    if (!stream) return;
    this.#streams.delete(streamId);
    stream.close();
    for (const [commandId, ofStream] of this.#streamOf) {
      if (ofStream !== streamId) continue;
      this.#commands.get(commandId)?.abort.abort(new CommandError("cancelled", "stream closed"));
    }
  }

  #startCommand(message: Extract<ControlMessage, { type: "command" }>): void {
    const { commandId } = message;
    this.#send({ type: "ack", commandId });
    // Sent again after a reconnect: it is already running or done.
    if (this.#commands.has(commandId)) return;
    const done = this.#outbox.get(commandId);
    if (done) {
      this.#send(done.message);
      return;
    }
    const finish = (result: RunnerMessage) => {
      this.#commands.delete(commandId);
      this.#streamOf.delete(commandId);
      this.#outbox.set(commandId, { message: result, at: Date.now() });
      this.#send(result);
    };
    // Followed again after a control-plane restart: never started here if it isn't (B2-20).
    if (message.resumeOnly) {
      finish({
        type: "result",
        commandId,
        ok: false,
        error: {
          code: "not_found",
          message: "This work isn't running on the server any more, so it wasn't started again.",
        },
      });
      return;
    }
    if (!isCommandKind(message.kind)) {
      finish({
        type: "result",
        commandId,
        ok: false,
        error: {
          code: "unsupported",
          message: `This runner (version ${VERSION}) doesn't know the command "${message.kind}". Update the runner.`,
        },
      });
      return;
    }
    const kind = message.kind;
    const parsed = commandParamsSchemas[kind].safeParse(message.params ?? {});
    if (!parsed.success) {
      finish({
        type: "result",
        commandId,
        ok: false,
        error: {
          code: "invalid",
          message: parsed.error.issues[0]?.message ?? "Invalid parameters.",
        },
      });
      return;
    }
    let stream: RunnerStream | null = null;
    if (STREAMING_COMMANDS.has(kind)) {
      if (!message.streamId) {
        finish({
          type: "result",
          commandId,
          ok: false,
          error: { code: "invalid", message: `${kind} needs a stream id.` },
        });
        return;
      }
      stream =
        this.#streams.get(message.streamId) ??
        new RunnerStream(message.streamId, this.#welcomed ? this.#streamSender : null);
      this.#streams.set(stream.id, stream);
      this.#streamOf.set(commandId, stream.id);
    }
    const abort = new AbortController();
    this.#commands.set(commandId, { kind, abort });
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (message.timeoutMs) {
      timer = setTimeout(
        () => abort.abort(new CommandError("timeout", "timeout")),
        message.timeoutMs,
      );
    }
    const context: CommandContext = {
      docker: this.#options.docker,
      router: this.#options.router,
      log: this.#log,
      workDirectory: this.#options.workDirectory,
      dockerSocket: this.#options.dockerSocket,
      containerized: this.#options.containerized,
      buildersDir: this.#options.buildersDir ?? DEFAULT_BUILDERS_DIR,
      controlFetch: this.#controlFetch,
      signal: abort.signal,
      stream,
    };
    const handler = handlerFor(kind) as (
      params: unknown,
      context: CommandContext,
    ) => Promise<unknown>;
    const running: Promise<unknown> = handler(parsed.data, context)
      .then((data) => {
        const exitCode =
          data && typeof data === "object" && "exitCode" in data
            ? ((data as { exitCode: number | null }).exitCode ?? null)
            : null;
        stream?.end(exitCode);
        finish({ type: "result", commandId, ok: true, data: data ?? {} });
        if (kind.startsWith("router.") || kind.startsWith("container.")) this.#scheduleState();
      })
      .catch((error: unknown) => {
        const failure = toRunnerError(error, abort.signal);
        stream?.end(null, failure);
        finish({ type: "result", commandId, ok: false, error: failure });
      })
      .finally(() => {
        clearTimeout(timer);
        this.#handlers.delete(running);
      });
    this.#handlers.add(running);
  }

  // ---- Background work: heartbeats, metrics, container state, router checks

  #startBackground(): void {
    this.#timers.push(
      setInterval(() => {
        if (!this.#socket) return;
        if (this.#welcomed) {
          const next = this.#current.nextFingerprint ?? this.#fallback?.nextFingerprint ?? null;
          this.#send({
            type: "heartbeat",
            seq: this.#heartbeatSeq++,
            at: Date.now(),
            ...(next ? { next } : {}),
          });
        }
        if (Date.now() - this.#lastHeard > HEARTBEAT_TIMEOUT_MS) {
          this.#log.warn("the control plane went quiet; reconnecting");
          this.#socket.close(RUNNER_CLOSE.silent, "silent");
        }
      }, HEARTBEAT_INTERVAL_MS),
    );
    this.#timers.push(
      setInterval(() => {
        void this.#collector.sample().then((sample) => {
          this.#metrics.push(sample);
          if (this.#metrics.length > METRICS_KEPT)
            this.#metrics.splice(0, this.#metrics.length - METRICS_KEPT);
          this.#flushMetrics();
        });
      }, metricsIntervalMs(process.env)),
    );
    this.#timers.push(setInterval(() => void this.#sendState(), STATE_EVERY_MS));
    this.#timers.push(setInterval(() => this.#expire(), 60_000));
    this.#timers.push(
      setInterval(() => {
        void this.#recheckDeclined().catch(() => {});
      }, this.#options.declineRecheckMs ?? DECLINE_RECHECK_MS),
    );
    if (this.#options.manageRouter) {
      void this.#options.router
        .ensure()
        .catch(() => {})
        .finally(() => this.#scheduleState());
      this.#timers.push(
        setInterval(() => {
          void this.#options.router.ensure().catch(() => {});
        }, ROUTER_CHECK_MS),
      );
    }
    const holds = () =>
      void this.#options.router
        .checkHolds()
        .then(({ released }) => {
          if (released.length > 0) {
            this.#log.info("DNS points here now; certificates can be requested", { released });
            this.#scheduleState();
          }
        })
        .catch(() => {});
    setTimeout(() => {
      holds();
      this.#timers.push(setInterval(holds, CHECK_EVERY_MS));
    }, FIRST_CHECK_AFTER_MS);
    void this.#watchContainers();
  }

  #expire(): void {
    const now = Date.now();
    for (const [id, stream] of this.#streams) {
      if (stream.endedAt !== null && now - stream.endedAt > ENDED_STREAM_TTL_MS)
        this.#streams.delete(id);
    }
    for (const [id, entry] of this.#outbox) {
      if (now - entry.at > RESULT_TTL_MS) this.#outbox.delete(id);
    }
  }

  #flushMetrics(): void {
    if (!this.#welcomed || this.#metrics.length === 0) return;
    const samples = this.#metrics.splice(0, this.#metrics.length);
    if (!this.#send({ type: "metrics", samples })) this.#metrics.unshift(...samples);
  }

  #scheduleState(): void {
    if (this.#stateTimer) return;
    this.#stateTimer = setTimeout(() => {
      this.#stateTimer = null;
      void this.#sendState();
    }, 1000);
  }

  async #readContainers(): Promise<ContainerState[]> {
    const list = await this.#options.docker.listContainers({ all: true });
    return list.map((item) => {
      const labels: Record<string, string> = {};
      for (const [key, value] of Object.entries(item.Labels ?? {})) {
        if (key.startsWith("dev.nearzero.")) labels[key] = value;
      }
      return {
        id: item.Id,
        name: (item.Names[0] ?? "").replace(/^\//, ""),
        image: item.Image,
        state: item.State,
        status: item.Status,
        labels,
        createdAt: item.Created,
      };
    });
  }

  async #sendState(): Promise<void> {
    if (!this.#welcomed) return;
    try {
      this.#containers = await this.#readContainers();
    } catch {
      // Docker away: report what we last saw, with the checks saying so.
    }
    this.#send({
      type: "state",
      at: Date.now(),
      containers: this.#containers,
      router: this.#options.router.state(),
      checks: await this.#checks(),
    });
  }

  async #watchContainers(): Promise<void> {
    while (!this.#stopped) {
      this.#eventsAbort = new AbortController();
      try {
        for await (const event of this.#options.docker.events(this.#eventsAbort.signal)) {
          if (event.Type === "container") this.#scheduleState();
        }
      } catch {
        // Docker restarted or the socket went away; try again shortly.
      }
      if (this.#stopped) return;
      await Bun.sleep(5000);
    }
  }
}
