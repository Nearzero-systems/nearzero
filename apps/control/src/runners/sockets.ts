import type { ServerWebSocket, WebSocketHandler } from "bun";

/**
 * WebSockets on the control plane: runner connections and browser terminals (spec 25 D5: only
 * terminals use WebSockets towards browsers). Bun serves every socket through one handler; each
 * upgraded request brings its own {@link SocketHandler}, which this dispatches to.
 */

export type Socket = ServerWebSocket<SocketData>;

export interface SocketHandler {
  open?(socket: Socket): void;
  message?(socket: Socket, data: string | Uint8Array): void;
  close?(socket: Socket, code: number, reason: string): void;
}

export interface SocketData {
  handler: SocketHandler;
}

/** Largest frame accepted (terminal input and runner messages are far smaller). */
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

export const socketServer: WebSocketHandler<SocketData> = {
  maxPayloadLength: MAX_FRAME_BYTES,
  // Pings keep proxies from closing quiet sockets; a dead peer is closed after the idle timeout.
  sendPings: true,
  idleTimeout: 120,
  open(socket) {
    socket.data.handler.open?.(socket);
  },
  message(socket, message) {
    socket.data.handler.message?.(
      socket,
      typeof message === "string" ? message : new Uint8Array(message),
    );
  },
  close(socket, code, reason) {
    socket.data.handler.close?.(socket, code, reason);
  },
};

/** The upgrade function the HTTP layer gets from Bun.serve. */
export function upgraderFor(server: {
  upgrade(request: Request, options: { data: SocketData }): boolean;
}): (request: Request, handler: SocketHandler) => boolean {
  return (request, handler) => server.upgrade(request, { data: { handler } });
}
