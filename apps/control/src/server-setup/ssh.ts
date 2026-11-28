import { createHash } from "node:crypto";
import { Client, type ClientChannel, type ConnectConfig } from "ssh2";

/**
 * The control plane's SSH client for setting servers up and repairing them (spec 09 9.2, 9.3,
 * 22.5; 25 D1 option C: SSH bootstraps, the runner does the rest).
 *
 * - The private key is opened from the database for one connection and held only in memory.
 * - The server's host key fingerprint (SHA256:…, as ssh-keygen shows it) is reported on every
 *   connection. A recorded fingerprint must match; with strict checking on, a server whose key
 *   was never recorded or trusted is refused before signing in.
 * - Connecting, every command and every upload have timeouts; nothing waits forever.
 * - Commands get standard input only when they are given some, and it is closed right after,
 *   so a stray reader sees the end of input instead of swallowing what follows.
 */

export interface SshTarget {
  address: string;
  port: number;
  user: string;
  /** OpenSSH or RSA PEM text. */
  privateKey: string;
}

export interface HostKeyPolicy {
  /** The fingerprint recorded or trusted for this server, if any. */
  expected: string | null;
  /** Refuse a server whose key isn't recorded yet (NEARZERO_SSH_STRICT_HOST_KEY_CHECKING). */
  strict: boolean;
}

export type SshFailureKind =
  | "key_rejected"
  | "unreachable"
  | "host_key_unknown"
  | "host_key_changed"
  | "timeout"
  | "closed";

export class SshFailure extends Error {
  readonly kind: SshFailureKind;
  /** The host key the server presented, when it got that far. */
  readonly fingerprint: string | null;
  /** The low-level reason in a few words ("connection refused"). */
  readonly detail: string;
  constructor(kind: SshFailureKind, detail: string, fingerprint: string | null = null) {
    super(`${kind}: ${detail}`);
    this.name = "SshFailure";
    this.kind = kind;
    this.detail = detail;
    this.fingerprint = fingerprint;
  }
}

export interface CommandResult {
  /** null when the command ended by a signal or the channel closed without a status. */
  code: number | null;
  signal: string | null;
  /** The last 256 KB of each, as text. */
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  /** Written to the command's standard input, which is then closed. */
  stdin?: string | Uint8Array;
  timeoutMs?: number;
  signal?: AbortSignal;
  onData?: (text: string, from: "out" | "err") => void;
}

/** A terminal size in character cells. */
export interface ShellSize {
  cols: number;
  rows: number;
}

/**
 * An interactive login shell on a pseudo-terminal (the server card's Terminal, spec 9.1).
 * Output arrives as raw bytes; the shell ends when the person closes it or the server does.
 */
export interface SshShell {
  write(data: Uint8Array): void;
  resize(size: ShellSize): void;
  /** Called with every piece of output, in order. */
  onData(listener: (bytes: Uint8Array) => void): void;
  /** Called once when the shell is gone, with its exit status when the server sent one. */
  onClose(listener: (exitCode: number | null) => void): void;
  close(): void;
}

export interface SshSession {
  /** The host key fingerprint the server presented: SHA256:<base64 without padding>. */
  readonly fingerprint: string;
  exec(command: string, options?: ExecOptions): Promise<CommandResult>;
  /** Opens the user's login shell on a pseudo-terminal of the given size. */
  shell(size: ShellSize): Promise<SshShell>;
  close(): void;
}

export interface ConnectOptions {
  readyTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface SshConnector {
  connect(target: SshTarget, policy: HostKeyPolicy, options?: ConnectOptions): Promise<SshSession>;
}

export const CONNECT_TIMEOUT_MS = 20_000;
export const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_KEPT = 256 * 1024;
const WRITE_CHUNK = 256 * 1024;

/** SHA256:<base64> of a host key blob, as OpenSSH prints it. */
export function fingerprintOfHostKey(blob: Uint8Array): string {
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

const NETWORK_WORDS: Record<string, string> = {
  ECONNREFUSED: "connection refused",
  EHOSTUNREACH: "host unreachable",
  ENETUNREACH: "network unreachable",
  ENOTFOUND: "name not found",
  EAI_AGAIN: "name lookup failed",
  ETIMEDOUT: "timed out",
  ECONNRESET: "connection reset",
  EPIPE: "connection closed",
};

/** Turns an ssh2 client error into one of the failures people get a message for. */
export function classifyClientError(error: unknown): SshFailure {
  const err = error as { level?: string; code?: string; message?: string };
  const message = err.message ?? String(error);
  if (err.level === "client-authentication") {
    return new SshFailure("key_rejected", "the server refused the key");
  }
  if (err.level === "client-timeout" || /timed out while waiting for handshake/i.test(message)) {
    return new SshFailure("unreachable", "no answer within 20 seconds");
  }
  if (err.code && NETWORK_WORDS[err.code]) {
    return new SshFailure("unreachable", NETWORK_WORDS[err.code] as string);
  }
  if (/connection lost before handshake|socket hang up|ECONNRESET/i.test(message)) {
    return new SshFailure("unreachable", "the connection closed before SSH started");
  }
  return new SshFailure("unreachable", message.slice(0, 200));
}

class Tail {
  #text = "";
  push(chunk: string): void {
    this.#text += chunk;
    if (this.#text.length > OUTPUT_KEPT * 2) this.#text = this.#text.slice(-OUTPUT_KEPT);
  }
  get value(): string {
    return this.#text.length > OUTPUT_KEPT ? this.#text.slice(-OUTPUT_KEPT) : this.#text;
  }
}

async function writeAll(channel: ClientChannel, data: Uint8Array): Promise<void> {
  for (let start = 0; start < data.length; start += WRITE_CHUNK) {
    const piece = data.subarray(start, Math.min(data.length, start + WRITE_CHUNK));
    if (!channel.write(Buffer.from(piece))) {
      await new Promise<void>((resolve) => channel.once("drain", () => resolve()));
    }
  }
}

class Ssh2Session implements SshSession {
  readonly fingerprint: string;
  readonly #client: Client;
  #closed = false;

  constructor(client: Client, fingerprint: string) {
    this.#client = client;
    this.fingerprint = fingerprint;
    client.on("close", () => {
      this.#closed = true;
    });
  }

  exec(command: string, options: ExecOptions = {}): Promise<CommandResult> {
    if (this.#closed) return Promise.reject(new SshFailure("closed", "the connection closed"));
    const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      this.#client.exec(command, (error, channel) => {
        if (error) {
          reject(new SshFailure("closed", error.message));
          return;
        }
        const out = new Tail();
        const err = new Tail();
        const outDecoder = new TextDecoder();
        const errDecoder = new TextDecoder();
        let code: number | null = null;
        let signal: string | null = null;
        let settled = false;
        const finish = (failure?: SshFailure) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          const outRest = outDecoder.decode();
          const errRest = errDecoder.decode();
          if (outRest) {
            out.push(outRest);
            options.onData?.(outRest, "out");
          }
          if (errRest) {
            err.push(errRest);
            options.onData?.(errRest, "err");
          }
          if (failure) reject(failure);
          else resolve({ code, signal, stdout: out.value, stderr: err.value });
        };
        const stop = (failure: SshFailure) => {
          try {
            channel.signal("KILL");
          } catch {
            // Not every server accepts signals; closing the channel is enough.
          }
          channel.close();
          finish(failure);
        };
        const timer = setTimeout(
          () =>
            stop(
              new SshFailure(
                "timeout",
                `the command didn't finish within ${Math.round(timeoutMs / 1000)} seconds`,
              ),
            ),
          timeoutMs,
        );
        const onAbort = () => stop(new SshFailure("closed", "stopped"));
        options.signal?.addEventListener("abort", onAbort, { once: true });
        channel.on("data", (chunk: Buffer) => {
          const text = outDecoder.decode(chunk, { stream: true });
          out.push(text);
          options.onData?.(text, "out");
        });
        channel.stderr.on("data", (chunk: Buffer) => {
          const text = errDecoder.decode(chunk, { stream: true });
          err.push(text);
          options.onData?.(text, "err");
        });
        channel.on("exit", (exitCode: number | null, exitSignal?: string) => {
          if (typeof exitCode === "number") code = exitCode;
          if (exitSignal) signal = exitSignal;
        });
        channel.on("close", () => finish());
        channel.on("error", (channelError: Error) =>
          finish(new SshFailure("closed", channelError.message)),
        );
        const input = options.stdin;
        if (input === undefined) {
          channel.end();
          return;
        }
        const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
        writeAll(channel, bytes)
          .then(() => channel.end())
          .catch((writeError: Error) => stop(new SshFailure("closed", writeError.message)));
      });
    });
  }

  shell(size: ShellSize): Promise<SshShell> {
    if (this.#closed) return Promise.reject(new SshFailure("closed", "the connection closed"));
    return new Promise((resolve, reject) => {
      this.#client.shell(
        { term: "xterm-256color", cols: size.cols, rows: size.rows },
        (error, channel) => {
          if (error) {
            reject(new SshFailure("closed", error.message));
            return;
          }
          resolve(new Ssh2Shell(channel));
        },
      );
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#client.end();
  }
}

class Ssh2Shell implements SshShell {
  readonly #channel: ClientChannel;
  readonly #data: ((bytes: Uint8Array) => void)[] = [];
  readonly #closers: ((exitCode: number | null) => void)[] = [];
  #exitCode: number | null = null;
  #closed = false;

  constructor(channel: ClientChannel) {
    this.#channel = channel;
    const forward = (chunk: Buffer) => {
      const bytes = new Uint8Array(chunk);
      for (const listener of this.#data) listener(bytes);
    };
    channel.on("data", forward);
    channel.stderr.on("data", forward);
    channel.on("exit", (code: number | null) => {
      if (typeof code === "number") this.#exitCode = code;
    });
    const finish = () => {
      if (this.#closed) return;
      this.#closed = true;
      for (const listener of this.#closers) listener(this.#exitCode);
    };
    channel.on("close", finish);
    channel.on("error", finish);
  }

  write(data: Uint8Array): void {
    if (!this.#closed) this.#channel.write(Buffer.from(data));
  }

  resize(size: ShellSize): void {
    if (!this.#closed) this.#channel.setWindow(size.rows, size.cols, 0, 0);
  }

  onData(listener: (bytes: Uint8Array) => void): void {
    this.#data.push(listener);
  }

  onClose(listener: (exitCode: number | null) => void): void {
    if (this.#closed) listener(this.#exitCode);
    else this.#closers.push(listener);
  }

  close(): void {
    if (this.#closed) return;
    try {
      this.#channel.close();
    } catch {
      // Already gone.
    }
  }
}

/** Connects with ssh2 (MIT), keeping the key in memory only. */
export const ssh2Connector: SshConnector = {
  connect(target, policy, options = {}) {
    return new Promise((resolve, reject) => {
      const client = new Client();
      let presented: string | null = null;
      let refusal: SshFailure | null = null;
      let settled = false;
      const fail = (failure: SshFailure) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", onAbort);
        client.end();
        reject(failure);
      };
      const onAbort = () => fail(new SshFailure("closed", "stopped"));
      options.signal?.addEventListener("abort", onAbort, { once: true });
      const config: ConnectConfig = {
        host: target.address,
        port: target.port,
        username: target.user,
        privateKey: target.privateKey,
        readyTimeout: options.readyTimeoutMs ?? CONNECT_TIMEOUT_MS,
        keepaliveInterval: 10_000,
        keepaliveCountMax: 3,
        // Only the key: never a password or keyboard-interactive prompt.
        tryKeyboard: false,
        hostVerifier: (key: Buffer) => {
          presented = fingerprintOfHostKey(key);
          if (policy.expected && policy.expected !== presented) {
            refusal = new SshFailure("host_key_changed", "the host key changed", presented);
            return false;
          }
          if (!policy.expected && policy.strict) {
            refusal = new SshFailure("host_key_unknown", "the host key isn't trusted", presented);
            return false;
          }
          return true;
        },
      };
      client
        .on("ready", () => {
          if (settled) return;
          settled = true;
          options.signal?.removeEventListener("abort", onAbort);
          resolve(new Ssh2Session(client, presented ?? ""));
        })
        .on("error", (error) => fail(refusal ?? classifyClientError(error)))
        .on("close", () => fail(refusal ?? new SshFailure("unreachable", "the connection closed")));
      try {
        client.connect(config);
      } catch (error) {
        // A key ssh2 can't parse, for example.
        fail(new SshFailure("key_rejected", (error as Error).message));
      }
    });
  },
};

/** A POSIX single-quoted word: safe to put any text into a shell command line. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
