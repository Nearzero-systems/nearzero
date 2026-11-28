import type { Logger } from "../log.ts";
import type { Socket, SocketHandler } from "../runners/sockets.ts";
import { AccessFailure, openSession, type ServerAccess } from "../server-setup/connection.ts";
import { type ShellSize, SshFailure, type SshSession, type SshShell } from "../server-setup/ssh.ts";
import type { ControlServices } from "../services.ts";

/**
 * A server's Terminal (spec 9.1, 22.3): an SSH login shell on the server itself, in the browser.
 * The route checks the server's manage rights and records the audit entry before the WebSocket
 * opens; this handler then signs in the way setup does (the server's key, its recorded host key)
 * and bridges the shell's pseudo-terminal to the socket:
 *
 * - browser → server: binary frames are keystrokes; text frames are `{ type: "resize", cols,
 *   rows }`, `{ type: "input", data }`, or plain text typed as is.
 * - server → browser: binary frames are the shell's output; text frames are
 *   `{ type: "status", connected: true }` once the shell runs and `{ type: "exit", exitCode,
 *   error }` when it ends or couldn't start (with the reason in people's words).
 */

/** Largest terminal the browser may ask for, in each direction. */
const MAX_CELLS = 1000;

export type TerminalFrame =
  | { kind: "input"; bytes: Uint8Array }
  | { kind: "resize"; size: ShellSize }
  | { kind: "ignored" };

/** Reads one frame the browser sent to a terminal socket. */
export function readTerminalFrame(data: string | Uint8Array): TerminalFrame {
  if (typeof data !== "string") return { kind: "input", bytes: data };
  let parsed: { type?: unknown; cols?: unknown; rows?: unknown; data?: unknown } | null;
  try {
    parsed = JSON.parse(data);
  } catch {
    return { kind: "input", bytes: new TextEncoder().encode(data) };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { kind: "input", bytes: new TextEncoder().encode(data) };
  }
  if (parsed.type === "resize" && Number.isInteger(parsed.cols) && Number.isInteger(parsed.rows)) {
    const clamp = (value: number) => Math.min(MAX_CELLS, Math.max(1, value));
    return {
      kind: "resize",
      size: { cols: clamp(parsed.cols as number), rows: clamp(parsed.rows as number) },
    };
  }
  if (parsed.type === "input" && typeof parsed.data === "string") {
    return { kind: "input", bytes: new TextEncoder().encode(parsed.data) };
  }
  return { kind: "ignored" };
}

/** Why the shell couldn't start, in the words the setup dialog uses for the same failures. */
export function shellFailureMessage(error: unknown, server: { name: string }): string {
  if (error instanceof AccessFailure) return error.failure.message;
  if (error instanceof SshFailure) {
    return `Signed in to ${server.name}, but it didn't open a shell (${error.detail}). Check the SSH user's login shell, then try again.`;
  }
  return `Couldn't open a shell on ${server.name}. Try again in a moment.`;
}

/** The socket handler for one SSH terminal on `server`. */
export function sshTerminal(
  services: ControlServices,
  server: ServerAccess,
  size: ShellSize,
  log: Logger,
): SocketHandler {
  let session: SshSession | null = null;
  let shell: SshShell | null = null;
  let gone = false;

  const send = (socket: Socket, frame: string | Uint8Array) => {
    if (!gone) socket.send(frame);
  };
  const finish = (socket: Socket, exitCode: number | null, error: string | null) => {
    send(socket, JSON.stringify({ type: "exit", exitCode, error }));
    if (!gone) socket.close(1000, error ? "failed" : "exited");
    gone = true;
    shell?.close();
    session?.close();
  };

  return {
    open(socket) {
      void (async () => {
        try {
          session = (await openSession(services, server)).session;
          if (gone) return session.close();
          shell = await session.shell(size);
          if (gone) {
            shell.close();
            return session.close();
          }
          shell.onData((bytes) => send(socket, bytes));
          shell.onClose((exitCode) => finish(socket, exitCode, null));
          send(socket, JSON.stringify({ type: "status", connected: true }));
        } catch (error) {
          if (!(error instanceof AccessFailure) && !(error instanceof SshFailure)) {
            log.error("server terminal failed", { serverId: server.id, error: String(error) });
          }
          finish(socket, null, shellFailureMessage(error, server));
        }
      })();
    },
    message(_socket, data) {
      const frame = readTerminalFrame(data);
      if (frame.kind === "input") shell?.write(frame.bytes);
      else if (frame.kind === "resize") shell?.resize(frame.size);
    },
    close() {
      gone = true;
      shell?.close();
      session?.close();
    },
  };
}
