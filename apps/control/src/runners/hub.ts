import {
  AppError,
  agreeProtocol,
  type CommandKind,
  type CommandParams,
  type ContainerState,
  type ControlMessage,
  decodeChunk,
  encodeChunk,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  type HelloMessage,
  type MetricsSample,
  NEARZERO_LABELS,
  parseRunnerMessage,
  type RouterState,
  RUNNER_CLOSE,
  type RunnerChecks,
  type RunnerError,
  type RunnerLinkAddress,
  type RunnerMessage,
  runnerMoveTarget,
  STREAMING_COMMANDS,
  VERSION,
} from "@nearzero/shared";
import type { Db } from "../db/database.ts";
import type { Logger } from "../log.ts";
import { HubStream } from "./streams.ts";

/**
 * The runner hub: the control plane's end of every runner's WebSocket (docs/runner-protocol.md).
 * It tracks which runner serves which server, sends commands and waits for their results, follows
 * streams for any number of viewers, and keeps the latest state and metrics each runner reports.
 *
 * A target is a server id, or "host" for the Nearzero host. Commands and streams survive a runner
 * reconnecting: a command the runner never received is sent again (the same runner ignores
 * repeats), one it acknowledged is followed on in the same runner process and never started again
 * in a new one (C2-01), and streams resume from the last offset received.
 *
 * Remote runners are moved to the encrypted address they should use (welcome.link, spec 31
 * "Remote runners are always encrypted"); nothing but the welcome goes to a runner that is moving.
 *
 * One control-plane process holds the runner connections (the install runs one).
 */

export const HOST_TARGET = "host";

export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface RunnerIdentity {
  runnerId: string;
  /** null for the Nearzero host. */
  serverId: string | null;
  /**
   * Whether the connection reached the control plane encrypted: on the runner link's own TLS
   * port, or through the router over HTTPS. Unknown (undefined) counts as encrypted.
   */
  encrypted?: boolean;
}

/** Commands that read and change nothing, so sending one again to a restarted runner is safe. */
const REPEATABLE = new Set<CommandKind>([
  "system.info",
  "container.inspect",
  "container.list",
  "volume.list",
  "image.list",
  "router.files",
  "certificates.status",
  "certificates.uploads",
  "dns.status",
  "access-log.status",
]);

/** What a command waiting on a runner that restarted is told (C2-01). */
export const LOST_TO_RUNNER_RESTART =
  "The server's runner restarted while this was running, so it stopped there. Nearzero doesn't start it again by itself.";

export function targetOf(serverId: string | null): string {
  return serverId ?? HOST_TARGET;
}

/** A command the runner couldn't carry out; the message is the runner's, in plain words. */
export class RunnerCommandError extends AppError {
  readonly runnerCode: RunnerError["code"];
  constructor(error: RunnerError) {
    const code =
      error.code === "not_found"
        ? "not_found"
        : error.code === "invalid"
          ? "invalid_request"
          : error.code === "docker_unavailable"
            ? "unavailable"
            : error.code === "timeout"
              ? "timeout"
              : "conflict";
    super(code, error.message);
    this.runnerCode = error.code;
  }
}

/**
 * Long work a control-plane restart must not stop (B2-20, spec 23.1): a command started with a
 * key gets ids made from that key, so after a restart the job that started it can follow it
 * again by the same key instead of the runner being told to cancel it.
 */
const WORK_PREFIX = "w:";
const WORK_KEY = /^[A-Za-z0-9._:-]{1,100}$/;
/** How long work found on a runner after a restart waits for its job to follow it again. */
export const ORPHAN_GRACE_MS = 10 * 60_000;

export function workIds(key: string): { commandId: string; streamId: string } {
  if (!WORK_KEY.test(key)) throw new Error(`Not a work key: ${key}`);
  return { commandId: `${WORK_PREFIX}${key}`, streamId: `${WORK_PREFIX}${key}.out` };
}

function isWorkId(id: string): boolean {
  return id.startsWith(WORK_PREFIX);
}

/** The hub is stopping (the control plane restarts); work started with a key goes on. */
export class HubStopping extends AppError {
  constructor() {
    super("unavailable", "Nearzero is restarting. Try again in a moment.");
  }
}

type ResultMessage = Extract<RunnerMessage, { type: "result" }>;

/** Keyed work a runner reported after a restart that no job follows yet. */
interface Orphan {
  target: string;
  commandId: string;
  /** Its result, when it finished before its job came back. */
  result: ResultMessage | null;
  timer: ReturnType<typeof setTimeout>;
}

interface Connection {
  socket: SocketLike;
  identity: RunnerIdentity;
  target: string;
  protocol: number;
  runnerVersion: string;
  connectedAt: number;
  lastHeard: number;
  welcomed: boolean;
  /** When this runner process started (its hello), which tells a reconnect from a restart. */
  startedAt: number | null;
  /** The address the runner says it uses; null for runners that can't be moved (older ones). */
  link: string | null;
  /**
   * Addresses the runner said it couldn't use, as of its hello. It checks them again in the
   * background and moves by itself once one answers (C4-09), so it isn't moved there meanwhile.
   */
  declined: Set<string>;
  /** Welcomed with a new address to move to: no work goes to it, it leaves by itself. */
  moving: boolean;
  /** The next link fingerprint the runner holds (its hello and heartbeats; C4-10), or null. */
  next: string | null;
  /** This connection's welcome gave the runner the next fingerprint. */
  nextGiven: boolean;
}

interface Pending {
  id: string;
  target: string;
  kind: CommandKind;
  params: unknown;
  streamId?: string;
  resumeOnly?: boolean;
  timeoutMs: number;
  acked: boolean;
  /** The runner process (its startedAt) it was last delivered to, or null when never sent. */
  sentTo: number | null;
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  ackTimer: ReturnType<typeof setTimeout> | null;
}

export interface TargetState {
  at: number;
  containers: ContainerState[];
  router: RouterState;
  checks: RunnerChecks;
}

export interface HubHooks {
  /** A runner finished its hello and was welcomed (route sync, readiness). */
  onReady?: (target: string, hello: HelloMessage) => Promise<void>;
  /** A runner reported its checks (in a state message). */
  onChecks?: (target: string, checks: RunnerChecks) => Promise<void>;
  /** Plain words for "this target's runner isn't connected". */
  offlineMessage?: (target: string) => Promise<string>;
  /** A runner reported metrics samples, after they were stored (server alerts, spec 14.3). */
  onMetrics?: (target: string, samples: MetricsSample[]) => Promise<void>;
  /**
   * The target's public IPv4 for the certificate hold (spec 10.7): the one set for it, its
   * address, or what its hostname resolves to. Without it, only a literal address counts.
   */
  publicIPv4?: (target: string) => Promise<string | null>;
  /**
   * The address remote runners should use (spec 31 "Remote runners are always encrypted"): the
   * console's hostname once its certificate is valid, else the runner link's own TLS address
   * with its fingerprint. Null when there is none; runners then stay where they are.
   */
  preferredLink?: () => Promise<RunnerLinkAddress | null>;
  /**
   * The runner link's own TLS address with its fingerprint, which every remote runner keeps as
   * its fallback (C4-06). Null without one.
   */
  fallbackLink?: () => Promise<RunnerLinkAddress | null>;
  /** The fingerprint of the pair that will replace the link certificate (C4-10), or null. */
  nextFingerprint?: () => string | null;
}

/** How long a command waits for the runner's acknowledgement. */
const ACK_TIMEOUT_MS = 15_000;
/** Streams nobody watches are stopped after this. */
const IDLE_STREAM_MS = 30_000;
/** Ended streams stay this long for viewers who reconnect. */
const ENDED_STREAM_KEPT_MS = 5 * 60_000;
/** last_seen_at is written at most this often per runner. */
const SEEN_WRITE_MS = 30_000;

export class RunnerHub {
  readonly #db: Db;
  readonly #log: Logger;
  readonly #hooks: HubHooks;
  readonly #connections = new Map<string, Connection>();
  readonly #pending = new Map<string, Pending>();
  readonly #streams = new Map<string, HubStream>();
  readonly #states = new Map<string, TargetState>();
  readonly #orphans = new Map<string, Orphan>();
  #stopping = false;
  /** Results already received, so a runner resending one after a reconnect is told so. */
  readonly #completed = new Set<string>();
  readonly #seenWrites = new Map<string, number>();
  readonly #sweeper: ReturnType<typeof setInterval>;

  readonly #orphanGraceMs: number;

  constructor(db: Db, log: Logger, hooks: HubHooks = {}, options: { orphanGraceMs?: number } = {}) {
    this.#db = db;
    this.#log = log;
    this.#hooks = hooks;
    this.#orphanGraceMs = options.orphanGraceMs ?? ORPHAN_GRACE_MS;
    this.#sweeper = setInterval(() => this.#sweep(), 5_000);
    this.#sweeper.unref?.();
  }

  // ---- Connections

  isOnline(target: string): boolean {
    return this.#served(target) !== null;
  }

  /** The target's connection when it is welcomed and takes work (not moving elsewhere). */
  #served(target: string): Connection | null {
    const connection = this.#connections.get(target);
    return connection?.welcomed && !connection.moving ? connection : null;
  }

  /** Every target whose runner is connected right now (a server id, or "host"). */
  onlineTargets(): string[] {
    return [...this.#connections.entries()]
      .filter(([, connection]) => connection.welcomed && !connection.moving)
      .map(([target]) => target);
  }

  connection(
    target: string,
  ): { protocol: number; runnerVersion: string; connectedAt: number } | null {
    const found = this.#served(target);
    return found
      ? {
          protocol: found.protocol,
          runnerVersion: found.runnerVersion,
          connectedAt: found.connectedAt,
        }
      : null;
  }

  state(target: string): TargetState | null {
    return this.#states.get(target) ?? null;
  }

  /** Starts following a new connection; call `message` per frame and `closed` at the end. */
  attach(
    socket: SocketLike,
    identity: RunnerIdentity,
  ): { message: (frame: string) => void; closed: (code: number) => void } {
    const connection: Connection = {
      socket,
      identity,
      target: targetOf(identity.serverId),
      protocol: 0,
      runnerVersion: "",
      connectedAt: Date.now(),
      lastHeard: Date.now(),
      welcomed: false,
      startedAt: null,
      link: null,
      declined: new Set(),
      moving: false,
      next: null,
      nextGiven: false,
    };
    return {
      message: (frame) => {
        connection.lastHeard = Date.now();
        const message = parseRunnerMessage(frame);
        if (!message) {
          this.#log.warn("runner sent a message outside the protocol; closing", {
            target: connection.target,
          });
          socket.close(RUNNER_CLOSE.protocolError, "protocol error");
          return;
        }
        void this.#handle(connection, message).catch((error: unknown) =>
          this.#log.error("runner message failed", { target: connection.target, error }),
        );
      },
      closed: (code) => this.#closed(connection, code),
    };
  }

  /** Closes a target's connection (revocation, deletion, tests forcing a reconnect). */
  disconnect(target: string, code: number = RUNNER_CLOSE.reconnect, reason = "reconnect"): boolean {
    const connection = this.#connections.get(target);
    if (!connection) return false;
    connection.socket.close(code, reason);
    this.#closed(connection, code);
    return true;
  }

  /** True once the control plane stops: what waits on a runner gets {@link HubStopping}. */
  get stopping(): boolean {
    return this.#stopping;
  }

  stop(): void {
    this.#stopping = true;
    clearInterval(this.#sweeper);
    for (const connection of this.#connections.values()) {
      connection.socket.close(RUNNER_CLOSE.goingAway, "control plane stopping");
    }
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      if (pending.ackTimer) clearTimeout(pending.ackTimer);
      pending.reject(new HubStopping());
    }
    this.#pending.clear();
    for (const orphan of this.#orphans.values()) clearTimeout(orphan.timer);
    this.#orphans.clear();
  }

  #send(connection: Connection, message: ControlMessage): boolean {
    try {
      connection.socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  #closed(connection: Connection, code: number): void {
    if (this.#connections.get(connection.target) !== connection) return;
    this.#connections.delete(connection.target);
    for (const stream of this.#streams.values()) {
      if (stream.target === connection.target) stream.link(false);
    }
    // What happens to waiting commands is decided when the runner says hello again: one the
    // same runner process still has is followed on, one it never got goes again, and one a
    // restarted runner lost is reported, never started again (C2-01).
    for (const pending of this.#pending.values()) {
      if (pending.target !== connection.target) continue;
      if (pending.ackTimer) clearTimeout(pending.ackTimer);
      pending.ackTimer = null;
    }
    this.#log.info("runner disconnected", { target: connection.target, code });
    void this.#db
      .updateTable("runner")
      .set({ disconnected_at: new Date(), last_seen_at: new Date(connection.lastHeard) })
      .where("id", "=", connection.identity.runnerId)
      .execute()
      .catch(() => {});
  }

  async #handle(connection: Connection, message: RunnerMessage): Promise<void> {
    if (message.type === "hello") {
      await this.#hello(connection, message);
      return;
    }
    if (!connection.welcomed) return;
    // A runner moving elsewhere has nothing to say here but heartbeats.
    if (connection.moving && message.type !== "heartbeat") return;
    switch (message.type) {
      case "heartbeat":
        this.#send(connection, { type: "heartbeat.ack", seq: message.seq });
        this.#markSeen(connection);
        if ((message.next ?? null) !== connection.next && connection.target !== HOST_TARGET) {
          // The runner took the next fingerprint from its welcome (C4-10).
          connection.next = message.next ?? null;
          void this.#recordNext(connection);
        }
        return;
      case "ack": {
        const pending = this.#pending.get(message.commandId);
        if (pending) {
          pending.acked = true;
          if (pending.ackTimer) clearTimeout(pending.ackTimer);
          pending.ackTimer = null;
        }
        return;
      }
      case "result":
        this.#result(connection, message);
        return;
      case "stream.data": {
        const stream = this.#streams.get(message.streamId);
        if (!stream || stream.target !== connection.target) {
          this.#send(connection, { type: "stream.close", streamId: message.streamId });
          return;
        }
        stream.accept(message.offset, decodeChunk(message.data));
        this.#send(connection, {
          type: "stream.ack",
          streamId: stream.id,
          offset: stream.received,
        });
        return;
      }
      case "stream.end": {
        const stream = this.#streams.get(message.streamId);
        if (!stream || stream.target !== connection.target) return;
        stream.finish(message.offset, message.exitCode ?? null, message.error ?? null);
        this.#send(connection, { type: "stream.ack", streamId: stream.id, offset: message.offset });
        return;
      }
      case "state":
        this.#states.set(connection.target, {
          at: message.at,
          containers: message.containers,
          router: message.router,
          checks: message.checks,
        });
        await this.#db
          .updateTable("runner")
          .set({
            checks: JSON.stringify(message.checks),
            // What runs, for commands outside this process (`nearzero migrate status`).
            containers: JSON.stringify(
              message.containers.map((item) => ({
                id: item.id,
                state: item.state,
                service: item.labels[NEARZERO_LABELS.service] ?? null,
              })),
            ),
            containers_at: new Date(message.at),
            last_seen_at: new Date(),
          })
          .where("id", "=", connection.identity.runnerId)
          .execute();
        await this.#hooks.onChecks?.(connection.target, message.checks);
        return;
      case "metrics":
        await this.#db
          .insertInto("server_metric")
          .values(
            message.samples.map((sample) => ({
              target: connection.target,
              at: new Date(sample.at),
              cpu_percent: sample.cpuPercent,
              memory_used_bytes: Math.round(sample.memoryUsedBytes),
              memory_total_bytes: Math.round(sample.memoryTotalBytes),
              disk_used_bytes: Math.round(sample.diskUsedBytes),
              disk_total_bytes: Math.round(sample.diskTotalBytes),
              disk_available_bytes:
                sample.diskAvailableBytes === undefined
                  ? null
                  : Math.round(sample.diskAvailableBytes),
              uptime_seconds: Math.round(sample.uptimeSeconds),
            })),
          )
          .onConflict((conflict) => conflict.columns(["target", "at"]).doNothing())
          .execute();
        await this.#hooks.onMetrics?.(connection.target, message.samples);
        return;
    }
  }

  #markSeen(connection: Connection): void {
    const last = this.#seenWrites.get(connection.target) ?? 0;
    if (Date.now() - last < SEEN_WRITE_MS) return;
    this.#seenWrites.set(connection.target, Date.now());
    void this.#db
      .updateTable("runner")
      .set({ last_seen_at: new Date() })
      .where("id", "=", connection.identity.runnerId)
      .execute()
      .catch(() => {});
  }

  async #hello(connection: Connection, hello: HelloMessage): Promise<void> {
    const agreement = agreeProtocol({
      protocol: hello.protocol,
      minProtocol: hello.minProtocol,
      version: hello.runnerVersion,
    });
    await this.#db
      .updateTable("runner")
      .set({
        runner_version: hello.runnerVersion,
        protocol: hello.protocol,
        system: JSON.stringify(hello.system),
        checks: JSON.stringify(hello.checks),
        last_seen_at: new Date(),
        refusal: agreement.ok ? null : agreement.message,
        updated_at: new Date(),
      })
      .where("id", "=", connection.identity.runnerId)
      .execute();
    if (!agreement.ok) {
      this.#log.warn("runner refused for its protocol", {
        target: connection.target,
        runnerVersion: hello.runnerVersion,
        protocol: hello.protocol,
      });
      this.#send(connection, {
        type: "refused",
        reason: agreement.reason,
        message: agreement.message,
      });
      connection.socket.close(RUNNER_CLOSE.versionRefused, "protocol outside the supported window");
      return;
    }
    const { serverName, publicIPv4 } = await this.#describe(connection.target);
    // A newer connection replaces an older one for the same server.
    const previous = this.#connections.get(connection.target);
    if (previous && previous !== connection) {
      previous.socket.close(RUNNER_CLOSE.replaced, "replaced by a newer connection");
      this.#closed(previous, RUNNER_CLOSE.replaced);
    }
    connection.protocol = agreement.protocol;
    connection.runnerVersion = hello.runnerVersion;
    connection.startedAt = hello.startedAt;
    connection.link = hello.link?.url ?? null;
    connection.declined = new Set((hello.link?.declined ?? []).map((item) => item.url));
    connection.next = hello.link?.next ?? null;

    // Where a remote runner should be (spec 31 "Remote runners are always encrypted").
    const decision = await this.#linkDecision(connection, hello, serverName);
    if (decision.kind === "refuse") {
      this.#log.warn("runner refused: it reached Nearzero unencrypted", {
        target: connection.target,
      });
      await this.#recordLink(connection, decision.message);
      this.#send(connection, { type: "refused", reason: "unencrypted", message: decision.message });
      connection.socket.close(RUNNER_CLOSE.unencrypted, "encrypted link needed");
      return;
    }
    if (decision.kind === "move") {
      // Nothing but the welcome: no stream output, results or work cross this connection, and
      // the runner closes it to reconnect at the new address.
      connection.welcomed = true;
      connection.moving = true;
      this.#connections.set(connection.target, connection);
      this.#send(connection, {
        type: "welcome",
        protocol: agreement.protocol,
        controlVersion: VERSION,
        serverId: connection.target,
        serverName,
        publicIPv4,
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
        resume: [],
        close: [],
        received: [],
        link: decision.to,
      });
      this.#log.info("moving a runner to its encrypted address", {
        target: connection.target,
        from: connection.link,
        to: decision.to.url,
      });
      const timer = setTimeout(() => {
        if (this.#connections.get(connection.target) === connection && connection.moving) {
          this.disconnect(connection.target, RUNNER_CLOSE.reconnect, "move");
        }
      }, 30_000);
      timer.unref?.();
      return;
    }

    // The pinned fallback and the next fingerprint for remote runners' welcome (C4-06, C4-10),
    // read before the streams and commands below, which nothing may await after.
    const pins = connection.target === HOST_TARGET ? null : await this.#pins();
    // Keyed work this process doesn't follow (it started before a restart) waits for its job
    // to follow it again; anything else nobody waits for is stopped, as before (B2-20).
    const listed = new Map(hello.commands.map((command) => [command.commandId, command]));
    for (const orphan of [...this.#orphans.values()]) {
      // Gone from the runner (it restarted too): there is nothing left to follow.
      if (orphan.target === connection.target && !listed.has(orphan.commandId) && !orphan.result)
        this.#dropOrphan(orphan, false);
    }
    for (const command of hello.commands) {
      if (!this.#pending.has(command.commandId) && isWorkId(command.commandId)) {
        this.#keepOrphan(connection.target, command.commandId);
      }
    }
    const resume: { streamId: string; offset: number }[] = [];
    const close: string[] = [];
    for (const item of hello.streams) {
      let stream = this.#streams.get(item.streamId);
      if (!stream && this.#orphanOfStream(item.streamId, connection.target)) {
        // Its output is kept from what the runner still holds, for the job that follows it.
        stream = new HubStream(item.streamId, connection.target, "work", item.firstOffset);
        this.#streams.set(stream.id, stream);
      }
      if (stream && stream.target === connection.target && !stream.ended) {
        resume.push({ streamId: stream.id, offset: stream.received });
      } else if (stream && stream.target === connection.target && stream.ended) {
        // Ended here already; let the runner forget it.
        close.push(item.streamId);
      } else {
        close.push(item.streamId);
      }
    }
    const received = hello.commands
      .filter(
        (command) =>
          command.finished &&
          !this.#pending.has(command.commandId) &&
          !this.#orphans.has(command.commandId),
      )
      .map((command) => command.commandId);
    // From here to the welcome nothing awaits, so no command can overtake it.
    connection.welcomed = true;
    this.#connections.set(connection.target, connection);
    if (pins?.next) connection.nextGiven = true;
    this.#send(connection, {
      type: "welcome",
      protocol: agreement.protocol,
      controlVersion: VERSION,
      serverId: connection.target,
      serverName,
      publicIPv4,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      resume,
      close,
      received,
      ...(pins?.fallback?.fingerprint
        ? { fallback: { url: pins.fallback.url, fingerprint: pins.fallback.fingerprint } }
        : {}),
      ...(pins?.next ? { nextFingerprint: pins.next } : {}),
    });
    // Viewers hear the link is back before the resumed output, and waiting commands go out.
    for (const stream of this.#streams.values()) {
      if (stream.target === connection.target && !stream.ended) stream.link(true);
    }
    // C2-01: a command this runner process still has (running, or its result waiting) is
    // followed on; one it never received goes again; one it acknowledged and no longer has, or
    // that went to the runner before it restarted, is reported lost, never started again. Only
    // commands that change nothing, and resume-only ones, go again to a restarted runner.
    for (const pending of [...this.#pending.values()]) {
      if (pending.target !== connection.target) continue;
      if (listed.has(pending.id)) {
        pending.acked = true;
        continue;
      }
      const sameProcess = pending.sentTo === hello.startedAt;
      if (
        pending.sentTo === null ||
        (sameProcess && !pending.acked) ||
        pending.resumeOnly ||
        REPEATABLE.has(pending.kind)
      ) {
        this.#dispatch(connection, pending);
        continue;
      }
      this.#lose(
        pending,
        sameProcess
          ? "The server's runner no longer has this work or its result, so Nearzero stopped waiting. It wasn't started again."
          : LOST_TO_RUNNER_RESTART,
      );
    }
    // Running commands nobody waits for any more are stopped; keyed work waits (above).
    for (const command of hello.commands) {
      if (
        !command.finished &&
        !this.#pending.has(command.commandId) &&
        !this.#orphans.has(command.commandId)
      ) {
        this.#send(connection, { type: "cancel", commandId: command.commandId });
      }
    }
    this.#log.info("runner connected", {
      target: connection.target,
      runnerVersion: hello.runnerVersion,
      protocol: agreement.protocol,
      resumed: resume.length,
      waiting: [...this.#orphans.values()].filter((orphan) => orphan.target === connection.target)
        .length,
    });
    await this.#db
      .updateTable("runner")
      .set({ connected_at: new Date(), disconnected_at: null })
      .where("id", "=", connection.identity.runnerId)
      .execute();
    await this.#hooks.onReady?.(connection.target, hello);
  }

  /**
   * Where this runner should be: served where it is, moved to a better encrypted address, or
   * refused because it reached Nearzero unencrypted (spec 31 "Remote runners are always
   * encrypted"). A remote runner on plain HTTP is never given work and never moved from there
   * (C4-05): its credential already crossed the network in clear, and only setup run again gives
   * it an encrypted address. The Nearzero host's runner is never moved. Older runners, which
   * don't say where they are, are served where they are when that is encrypted.
   */
  async #linkDecision(
    connection: Connection,
    hello: HelloMessage,
    serverName: string,
  ): Promise<
    | { kind: "serve" }
    | { kind: "move"; to: RunnerLinkAddress }
    | { kind: "refuse"; message: string }
  > {
    if (connection.target === HOST_TARGET) return { kind: "serve" };
    const current = connection.link;
    const encryptedNow = current
      ? current.startsWith("https:")
      : connection.identity.encrypted !== false;
    if (!encryptedNow) {
      return {
        kind: "refuse",
        message: `${serverName}'s runner reaches Nearzero over plain HTTP, which Nearzero never uses for a server: its credential and work would cross the network unencrypted, so it gets no work. Run setup again on the server (or its join command from the server's page) to give it Nearzero's encrypted address.`,
      };
    }
    if (current === null) {
      await this.#recordLink(connection, null);
      return { kind: "serve" };
    }
    let preferred: RunnerLinkAddress | null = null;
    try {
      preferred = (await this.#hooks.preferredLink?.()) ?? null;
    } catch (error) {
      this.#log.warn("couldn't work out where runners should connect", { error });
    }
    // Only an encrypted address the runner itself would follow (C4-04).
    const target = preferred && runnerMoveTarget.safeParse(preferred).success ? preferred : null;
    if (target && target.url !== current && !connection.declined.has(target.url)) {
      return { kind: "move", to: target };
    }
    const why = target
      ? hello.link?.declined?.find((item) => item.url === target.url)?.reason
      : undefined;
    await this.#recordLink(
      connection,
      target && target.url !== current && connection.declined.has(target.url)
        ? `${serverName}'s runner can't use ${target.url}${why ? ` (${why})` : ""}, so it stays on ${current}, which is encrypted too. It checks again by itself every few minutes and moves once it can.`
        : null,
    );
    return { kind: "serve" };
  }

  /** The fallback and next fingerprint every remote runner's welcome carries. */
  async #pins(): Promise<{ fallback: RunnerLinkAddress | null; next: string | null }> {
    const fallback = await (this.#hooks.fallbackLink?.() ?? Promise.resolve(null)).catch(
      () => null,
    );
    const next = this.#hooks.nextFingerprint?.() ?? null;
    return { fallback, next: fallback && next !== fallback.fingerprint ? next : null };
  }

  /** Which next fingerprint a runner holds, for `nearzero runner-link status` (C4-10). */
  async #recordNext(connection: Connection): Promise<void> {
    await this.#db
      .updateTable("runner")
      .set({ link_next: connection.next })
      .where("id", "=", connection.identity.runnerId)
      .execute()
      .catch((error: unknown) => this.#log.warn("couldn't record a runner's next pin", { error }));
  }

  /** What people see about the link on the server's page (null: nothing wrong with it). */
  async #recordLink(connection: Connection, problem: string | null): Promise<void> {
    await this.#db
      .updateTable("runner")
      .set({ link_url: connection.link, link_problem: problem, link_next: connection.next })
      .where("id", "=", connection.identity.runnerId)
      .execute()
      .catch((error: unknown) => this.#log.warn("couldn't record a runner's link", { error }));
  }

  /** A waiting command the runner can't finish any more (C2-01): reported, never sent again. */
  #lose(pending: Pending, message: string): void {
    this.#pending.delete(pending.id);
    clearTimeout(pending.timer);
    if (pending.ackTimer) clearTimeout(pending.ackTimer);
    this.#log.warn("a command was lost on the runner", {
      target: pending.target,
      kind: pending.kind,
      commandId: pending.id,
    });
    pending.reject(new RunnerCommandError({ code: "failed", message }));
  }

  /**
   * Moves connected remote runners when the address they should use changed (the console's
   * domain got its certificate): each one not there yet is reconnected, and its welcome moves
   * it. A runner that said it can't use the address isn't: it checks again by itself, with a
   * check request alone, and moves once it answers (C4-09), so its link isn't cut to find out.
   * While the link certificate is being replaced (C4-10), each runner that doesn't hold the next
   * fingerprint yet is reconnected once, and its welcome gives it.
   */
  async refreshLinks(): Promise<number> {
    if (this.#stopping) return 0;
    const preferred = this.#hooks.preferredLink
      ? await this.#hooks.preferredLink().catch(() => null)
      : null;
    const target = preferred && runnerMoveTarget.safeParse(preferred).success ? preferred : null;
    const { next } = await this.#pins();
    let moved = 0;
    for (const connection of [...this.#connections.values()]) {
      if (connection.target === HOST_TARGET || !connection.welcomed || connection.moving) continue;
      const move =
        target !== null &&
        connection.link !== null &&
        connection.link !== target.url &&
        !connection.declined.has(target.url);
      const pin = next !== null && connection.next !== next && !connection.nextGiven;
      if (!move && !pin) continue;
      this.disconnect(connection.target, RUNNER_CLOSE.reconnect, move ? "move" : "new pin");
      moved++;
    }
    return moved;
  }

  async #describe(target: string): Promise<{ serverName: string; publicIPv4: string | null }> {
    const known = this.#hooks.publicIPv4
      ? await this.#hooks.publicIPv4(target).catch((error: unknown) => {
          this.#log.warn("couldn't work out a server's public IPv4", { target, error });
          return undefined;
        })
      : undefined;
    if (target === HOST_TARGET) {
      return { serverName: "Nearzero host", publicIPv4: known ?? this.hostPublicIPv4 };
    }
    const row = await this.#db
      .selectFrom("server")
      .select(["name", "address"])
      .where("id", "=", target)
      .executeTakeFirst();
    const address = row?.address ?? "";
    return {
      serverName: row?.name ?? "server",
      publicIPv4:
        known !== undefined ? known : /^\d{1,3}(\.\d{1,3}){3}$/.test(address) ? address : null,
    };
  }

  /** The host's public IPv4 (from the install settings), for the certificate hold. */
  hostPublicIPv4: string | null = null;

  #result(connection: Connection, message: ResultMessage): void {
    this.#send(connection, { type: "result.received", commandId: message.commandId });
    const pending = this.#pending.get(message.commandId);
    const orphan = this.#orphans.get(message.commandId);
    if (!pending && orphan && orphan.target === connection.target) {
      // Kept for the job that follows this work again.
      orphan.result = message;
      return;
    }
    if (!pending || pending.target !== connection.target) return;
    this.#pending.delete(message.commandId);
    this.#completed.add(message.commandId);
    if (this.#completed.size > 5_000) {
      const oldest = this.#completed.values().next().value;
      if (oldest !== undefined) this.#completed.delete(oldest);
    }
    clearTimeout(pending.timer);
    if (pending.ackTimer) clearTimeout(pending.ackTimer);
    if (message.ok) pending.resolve(message.data ?? {});
    else
      pending.reject(
        new RunnerCommandError(
          message.error ?? { code: "failed", message: "The runner reported a failure." },
        ),
      );
  }

  // ---- Commands

  async #offline(target: string): Promise<AppError> {
    const message = this.#hooks.offlineMessage
      ? await this.#hooks.offlineMessage(target)
      : "This server's runner isn't connected, so Nearzero can't reach it right now. It reconnects by itself once the server is back.";
    return new AppError("unavailable", message);
  }

  #dispatch(connection: Connection, pending: Pending): void {
    const sent = this.#send(connection, {
      type: "command",
      commandId: pending.id,
      kind: pending.kind,
      params: pending.params,
      timeoutMs: pending.timeoutMs,
      ...(pending.streamId ? { streamId: pending.streamId } : {}),
      ...(pending.resumeOnly ? { resumeOnly: true } : {}),
    });
    if (!sent) return;
    pending.sentTo = connection.startedAt;
    if (pending.ackTimer) clearTimeout(pending.ackTimer);
    pending.ackTimer = setTimeout(() => {
      if (pending.acked || !this.#pending.has(pending.id)) return;
      this.#pending.delete(pending.id);
      clearTimeout(pending.timer);
      pending.reject(
        new AppError(
          "timeout",
          "The server's runner didn't answer within 15 seconds. Check that the server isn't overloaded, then try again.",
        ),
      );
    }, ACK_TIMEOUT_MS);
  }

  /**
   * Sends a command and waits for its result. Refuses at once, in plain words, when the target's
   * runner isn't connected.
   */
  async command<K extends CommandKind>(
    target: string,
    kind: K,
    params: CommandParams<K>,
    options: {
      timeoutMs?: number;
      streamId?: string;
      signal?: AbortSignal;
      /** A command id of the caller's ({@link workIds}); a random one otherwise. */
      commandId?: string;
      resumeOnly?: boolean;
    } = {},
  ): Promise<unknown> {
    const connection = this.#served(target);
    if (!connection) throw await this.#offline(target);
    const timeoutMs = options.timeoutMs ?? 60_000;
    const id = options.commandId ?? crypto.randomUUID();
    if (this.#pending.has(id)) {
      throw new AppError("conflict", "This is already running on the server.");
    }
    return new Promise((resolve, reject) => {
      const pending: Pending = {
        id,
        target,
        kind,
        params,
        timeoutMs,
        acked: false,
        sentTo: null,
        resolve,
        reject,
        ackTimer: null,
        timer: setTimeout(() => {
          if (!this.#pending.delete(id)) return;
          if (pending.ackTimer) clearTimeout(pending.ackTimer);
          const live = this.#served(target);
          if (live) this.#send(live, { type: "cancel", commandId: id });
          reject(
            new AppError(
              "timeout",
              `The server didn't finish this within ${Math.round(timeoutMs / 1000)} seconds, so Nearzero stopped waiting.`,
            ),
          );
        }, timeoutMs + 2_000),
        ...(options.streamId ? { streamId: options.streamId } : {}),
        ...(options.resumeOnly ? { resumeOnly: true } : {}),
      };
      this.#pending.set(id, pending);
      options.signal?.addEventListener(
        "abort",
        () => {
          if (!this.#pending.delete(id)) return;
          clearTimeout(pending.timer);
          if (pending.ackTimer) clearTimeout(pending.ackTimer);
          const live = this.#served(target);
          if (live) this.#send(live, { type: "cancel", commandId: id });
          reject(new AppError("conflict", "Cancelled."));
        },
        { once: true },
      );
      this.#dispatch(connection, pending);
    });
  }

  /**
   * Starts a streaming command and returns its stream at once; `done` settles with the command's
   * result. The stream is stopped when nobody has watched it for 30 seconds.
   */
  async openStream<K extends CommandKind>(
    target: string,
    kind: K,
    params: CommandParams<K>,
    options: {
      timeoutMs?: number;
      /**
       * Long work that outlives a control-plane restart (B2-20): the ids come from the key, so
       * the job can follow it again after a restart, with {@link resumeStream} or by starting
       * it again with the same key (the runner never runs one id twice).
       */
      key?: string;
    } = {},
  ): Promise<{ stream: HubStream; done: Promise<unknown> }> {
    if (!STREAMING_COMMANDS.has(kind)) throw new Error(`${kind} doesn't stream.`);
    if (!this.isOnline(target)) throw await this.#offline(target);
    return this.#startStream(target, kind, params, options.timeoutMs, options.key, false);
  }

  /**
   * Follows keyed work started before a control-plane restart, once the target's runner is
   * back (it waits up to `waitMs` for it): the same stream and result as when it was started.
   * Null when the runner doesn't have it (never started, or the runner restarted too); it is
   * never started here.
   */
  async resumeStream<K extends CommandKind>(
    target: string,
    kind: K,
    key: string,
    options: { timeoutMs?: number; waitMs?: number } = {},
  ): Promise<{ stream: HubStream; done: Promise<unknown> } | null> {
    if (!STREAMING_COMMANDS.has(kind)) throw new Error(`${kind} doesn't stream.`);
    const ids = workIds(key);
    const until = Date.now() + (options.waitMs ?? 60_000);
    while (!this.isOnline(target) && Date.now() < until && !this.#stopping) await Bun.sleep(250);
    if (!this.isOnline(target) || !this.#orphans.has(ids.commandId)) return null;
    return this.#startStream(target, kind, {} as CommandParams<K>, options.timeoutMs, key, true);
  }

  #startStream<K extends CommandKind>(
    target: string,
    kind: K,
    params: CommandParams<K>,
    timeoutMs: number | undefined,
    key: string | undefined,
    resumeOnly: boolean,
  ): { stream: HubStream; done: Promise<unknown> } {
    const ids = key
      ? workIds(key)
      : { commandId: crypto.randomUUID(), streamId: crypto.randomUUID() };
    if (this.#pending.has(ids.commandId)) {
      throw new AppError("conflict", "This is already running on the server.");
    }
    // Work found after a restart keeps the output collected for it.
    let stream = this.#streams.get(ids.streamId);
    if (!stream || stream.target !== target) {
      stream = new HubStream(ids.streamId, target, kind);
      this.#streams.set(stream.id, stream);
    }
    const orphan = this.#orphans.get(ids.commandId);
    if (orphan) {
      clearTimeout(orphan.timer);
      this.#orphans.delete(ids.commandId);
    }
    const done = orphan?.result
      ? orphan.result.ok
        ? Promise.resolve(orphan.result.data ?? {})
        : Promise.reject(
            new RunnerCommandError(
              orphan.result.error ?? { code: "failed", message: "The runner reported a failure." },
            ),
          )
      : this.command(target, kind, params, {
          timeoutMs: timeoutMs ?? 24 * 3_600_000,
          streamId: stream.id,
          commandId: ids.commandId,
          resumeOnly,
        });
    done.then(
      () => {
        if (!stream.ended) stream.finish(stream.received, null, null);
      },
      (error: Error) => {
        if (!stream.ended) {
          stream.finish(stream.received, null, {
            code: error instanceof RunnerCommandError ? error.runnerCode : "failed",
            message: error.message,
          });
        }
      },
    );
    return { stream, done };
  }

  stream(streamId: string): HubStream | null {
    return this.#streams.get(streamId) ?? null;
  }

  /** Stops a stream on the runner and forgets it. */
  closeStream(streamId: string): void {
    const stream = this.#streams.get(streamId);
    if (!stream) return;
    this.#streams.delete(streamId);
    const connection = this.#served(stream.target);
    // While the control plane stops, work goes on on the runner (B2-20).
    if (connection && !this.#stopping) {
      this.#send(connection, { type: "stream.close", streamId });
    }
    if (!stream.ended) stream.finish(stream.received, null, null);
  }

  /** Terminal input. Dropped while the runner is away (a terminal can't type into the past). */
  input(streamId: string, bytes: Uint8Array): boolean {
    const stream = this.#streams.get(streamId);
    const connection = stream ? this.#served(stream.target) : null;
    if (!stream || !connection) return false;
    return this.#send(connection, { type: "stream.input", streamId, data: encodeChunk(bytes) });
  }

  resize(streamId: string, cols: number, rows: number): void {
    const stream = this.#streams.get(streamId);
    const connection = stream ? this.#served(stream.target) : null;
    if (stream && connection) {
      this.#send(connection, { type: "stream.resize", streamId, cols, rows });
    }
  }

  #orphanOfStream(streamId: string, target: string): Orphan | null {
    if (!isWorkId(streamId) || !streamId.endsWith(".out")) return null;
    const orphan = this.#orphans.get(streamId.slice(0, -".out".length));
    return orphan && orphan.target === target ? orphan : null;
  }

  #keepOrphan(target: string, commandId: string): void {
    if (this.#orphans.has(commandId)) return;
    const orphan: Orphan = {
      target,
      commandId,
      result: null,
      timer: setTimeout(() => this.#dropOrphan(orphan, true), this.#orphanGraceMs),
    };
    orphan.timer.unref?.();
    this.#orphans.set(commandId, orphan);
  }

  /** Work nobody followed again in time is stopped on the runner, with its stream. */
  #dropOrphan(orphan: Orphan, stopIt: boolean): void {
    if (this.#orphans.get(orphan.commandId) !== orphan) return;
    clearTimeout(orphan.timer);
    this.#orphans.delete(orphan.commandId);
    const connection = this.#served(orphan.target);
    if (stopIt && !orphan.result && connection) {
      this.#send(connection, { type: "cancel", commandId: orphan.commandId });
    }
    this.closeStream(`${orphan.commandId}.out`);
    if (stopIt) {
      this.#log.info("stopped work no job followed again after the control plane restarted", {
        target: orphan.target,
        commandId: orphan.commandId,
      });
    }
  }

  #sweep(): void {
    const now = Date.now();
    for (const stream of [...this.#streams.values()]) {
      if (stream.listeners > 0) continue;
      if (this.#orphanOfStream(stream.id, stream.target)) continue;
      const idle = now - stream.lastActivity;
      if (stream.ended ? idle > ENDED_STREAM_KEPT_MS : idle > IDLE_STREAM_MS) {
        this.closeStream(stream.id);
      }
    }
    for (const connection of [...this.#connections.values()]) {
      if (now - connection.lastHeard > HEARTBEAT_TIMEOUT_MS) {
        this.#log.warn("runner went quiet; closing its connection", { target: connection.target });
        this.disconnect(connection.target, RUNNER_CLOSE.silent, "silent");
      }
    }
  }
}
