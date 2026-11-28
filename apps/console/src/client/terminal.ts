import { TERMINAL_NEEDS_WEBSOCKET, TERMINAL_UPSTREAM_REFUSED } from "@nearzero/shared/browser";
import { asApiError, callApi } from "./api.ts";
import { openDialog } from "./dialogs.ts";

/**
 * The Terminal dialog (spec 6.7, 8.2, 9.1). For a container it lists the containers (the
 * service's from GET /services/:id/runtime, a server's from GET /servers/:id/containers) and
 * opens the shell on Connect; a server card's Terminal (`data-terminal-ssh`) connects at once to
 * an SSH shell on the server (GET /servers/:id/terminal). Either way the shell runs over a
 * WebSocket through the console's proxy: keystrokes as binary frames, resizes as
 * `{ type: "resize" }`, output as binary frames, and `{ type: "status" | "exit" }` text frames.
 * xterm.js loads only when a terminal opens. Closing an open session asks "Close terminal?".
 */

interface XTerm {
  open(element: HTMLElement): void;
  write(data: string | Uint8Array): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onResize(listener: (size: { cols: number; rows: number }) => void): { dispose(): void };
  loadAddon(addon: unknown): void;
  focus(): void;
  dispose(): void;
  cols: number;
  rows: number;
}

interface Session {
  socket: WebSocket | null;
  term: XTerm | null;
  fit: { fit(): void } | null;
  observer: ResizeObserver | null;
  open: boolean;
}

const session: Session = { socket: null, term: null, fit: null, observer: null, open: false };
let subject: { kind: "service" | "server" | "ssh"; id: string; name: string } | null = null;

function dialog(): HTMLDialogElement | null {
  return document.querySelector<HTMLDialogElement>("[data-terminal]");
}

function status(text: string): void {
  const slot = dialog()?.querySelector<HTMLElement>("[data-terminal-status]");
  if (slot) slot.textContent = text;
}

function end(): void {
  session.open = false;
  try {
    session.socket?.close();
  } catch {
    // Already closed.
  }
  session.socket = null;
  session.observer?.disconnect();
  session.observer = null;
  session.term?.dispose();
  session.term = null;
  session.fit = null;
  const screen = dialog()?.querySelector<HTMLElement>("[data-terminal-screen]");
  screen?.replaceChildren();
}

function themeFor(dark: boolean) {
  return dark
    ? {
        background: "#0a0a0c",
        foreground: "#fafafa",
        cursor: "#fafafa",
        selectionBackground: "#7c3aed66",
      }
    : {
        background: "#ffffff",
        foreground: "#111827",
        cursor: "#111827",
        selectionBackground: "#11182733",
      };
}

async function loadContainers(): Promise<void> {
  const box = dialog();
  const select = box?.querySelector<HTMLSelectElement>("[data-terminal-container]");
  const connect = box?.querySelector<HTMLButtonElement>("[data-terminal-connect]");
  if (!box || !select || !subject) return;
  select.replaceChildren();
  status("Looking for running containers…");
  if (connect) connect.disabled = true;
  try {
    const list =
      subject.kind === "service"
        ? (
            await callApi<{
              containers: { id: string; name: string; state: string; current: boolean }[];
            }>("GET", `/services/${encodeURIComponent(subject.id)}/runtime`)
          ).containers
        : (
            await callApi<{ containers: { id: string; name: string; state: string }[] }>(
              "GET",
              `/servers/${encodeURIComponent(subject.id)}/containers`,
            )
          ).containers;
    const running = list.filter((item) => item.state === "running");
    for (const item of running) {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = `${item.name}${"current" in item && item.current ? " (current)" : ""}`;
      select.append(option);
    }
    if (running.length === 0) {
      status(
        "No container is running, so there is nothing to open a shell in. Start or deploy it first.",
      );
      return;
    }
    status("");
    if (connect) connect.disabled = false;
  } catch (error) {
    status(asApiError(error).message);
  }
}

function socketUrl(container: string, shell: string, cols: number, rows: number): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const size = `cols=${cols}&rows=${rows}`;
  if (subject?.kind === "ssh") {
    return `${scheme}://${location.host}/api/v1/servers/${encodeURIComponent(subject.id)}/terminal?${size}`;
  }
  if (subject?.kind === "server") {
    return `${scheme}://${location.host}/api/v1/servers/${encodeURIComponent(subject.id)}/containers/${encodeURIComponent(container)}/terminal?${size}`;
  }
  return `${scheme}://${location.host}/api/v1/services/${encodeURIComponent(subject?.id ?? "")}/terminal?container=${encodeURIComponent(container)}&shell=${shell}&${size}`;
}

async function connect(): Promise<void> {
  const box = dialog();
  if (!box || !subject) return;
  end();
  const container = box.querySelector<HTMLSelectElement>("[data-terminal-container]")?.value ?? "";
  const shell = box.querySelector<HTMLSelectElement>("[data-terminal-shell]")?.value ?? "sh";
  const screen = box.querySelector<HTMLElement>("[data-terminal-screen]");
  const ssh = subject.kind === "ssh";
  if (!screen || (!container && !ssh)) return;
  const serverName = subject.name;
  status(ssh ? `Signing in to ${serverName} over SSH…` : "Opening the terminal…");
  const [xterm, fitModule] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
  ]);
  const dark = document.documentElement.dataset.tone === "dark";
  const term = new xterm.Terminal({
    cursorBlink: true,
    fontSize: 12,
    fontFamily:
      getComputedStyle(document.documentElement).getPropertyValue("--nz-font-code") || "monospace",
    theme: themeFor(dark),
  }) as unknown as XTerm;
  const fit = new fitModule.FitAddon();
  term.loadAddon(fit);
  term.open(screen);
  fit.fit();
  session.term = term;
  session.fit = fit;
  const socket = new WebSocket(socketUrl(container, shell, term.cols, term.rows));
  socket.binaryType = "arraybuffer";
  session.socket = socket;
  let opened = false;
  // Set once the server said why the shell ended, so closing the socket keeps that sentence.
  let exited = false;
  socket.addEventListener("open", () => {
    opened = true;
    session.open = true;
    // An SSH shell says "Connected" once the server has signed in and started it.
    status(ssh ? `Signing in to ${serverName} over SSH…` : "Connected");
    const options = box.querySelector<HTMLDetailsElement>("[data-terminal-options]");
    if (options) options.open = false;
    term.focus();
  });
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      try {
        const message = JSON.parse(event.data) as {
          type: string;
          connected?: boolean;
          exitCode?: number | null;
          error?: string | null;
        };
        if (message.type === "status") {
          status(
            message.connected
              ? "Connected"
              : "The server's link dropped. Waiting for it to come back…",
          );
        } else if (message.type === "exit") {
          session.open = false;
          exited = true;
          status(
            message.error ??
              `The shell ended${message.exitCode === null || message.exitCode === undefined ? "" : ` (exit code ${message.exitCode})`}.`,
          );
        }
      } catch {
        term.write(event.data);
      }
      return;
    }
    term.write(new Uint8Array(event.data as ArrayBuffer));
  });
  socket.addEventListener("close", async (event) => {
    session.open = false;
    // The console's bridge says when Nearzero never opened its side (C3-06): that's a refusal
    // to explain, not a terminal that closed.
    if (opened && event.code !== TERMINAL_UPSTREAM_REFUSED) {
      if (!exited) status("The terminal closed.");
      return;
    }
    // It never opened: ask why, in the API's words.
    try {
      if (subject?.kind === "service") {
        // A plain GET of the terminal gets the same refusal the WebSocket did.
        try {
          await callApi(
            "GET",
            `/services/${encodeURIComponent(subject.id)}/terminal?container=${encodeURIComponent(container)}&shell=${shell}`,
          );
        } catch (error) {
          if (asApiError(error).message !== TERMINAL_NEEDS_WEBSOCKET) throw error;
        }
        await callApi("GET", `/services/${encodeURIComponent(subject.id)}/runtime`);
      } else if (subject?.kind === "ssh") {
        await callApi("GET", `/servers/${encodeURIComponent(subject.id)}`);
      } else if (subject) {
        await callApi("GET", `/servers/${encodeURIComponent(subject.id)}/containers`);
      }
      status(
        ssh
          ? "The terminal couldn't connect. Check that you may manage this server and try again."
          : "The terminal couldn't connect. Check that the container is still running and try again.",
      );
    } catch (error) {
      status(asApiError(error).message);
    }
  });
  const encoder = new TextEncoder();
  term.onData((data) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(encoder.encode(data));
  });
  term.onResize(({ cols, rows }) => {
    if (socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify({ type: "resize", cols, rows }));
  });
  session.observer = new ResizeObserver(() => {
    try {
      session.fit?.fit();
    } catch {
      // The dialog is closing.
    }
  });
  session.observer.observe(screen);
}

function askToClose(): void {
  const box = dialog();
  if (!box) return;
  if (!session.open) {
    end();
    box.close();
    return;
  }
  const confirm = box.querySelector<HTMLElement>("[data-terminal-confirm]");
  if (confirm) {
    confirm.hidden = false;
    confirm.querySelector<HTMLElement>("[data-terminal-keep]")?.focus();
  }
}

export function initTerminal(): void {
  document.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    const opener = target?.closest<HTMLElement>(
      "[data-terminal-open], [data-terminal-server], [data-terminal-ssh]",
    );
    if (opener) {
      const box = dialog();
      if (!box) return;
      event.preventDefault();
      opener.closest<HTMLElement>("[popover]")?.hidePopover();
      const name = opener.dataset.terminalName ?? "";
      const serverId = opener.dataset.terminalServer;
      const sshId = opener.dataset.terminalSsh;
      subject = sshId
        ? { kind: "ssh", id: sshId, name }
        : serverId
          ? { kind: "server", id: serverId, name }
          : { kind: "service", id: opener.dataset.terminalOpen ?? "", name };
      const subjectSlot = box.querySelector<HTMLElement>("[data-terminal-subject]");
      if (subjectSlot) {
        subjectSlot.textContent =
          subject.kind === "ssh" ? `SSH shell on ${subject.name}` : subject.name;
      }
      const shell = box.querySelector<HTMLElement>("[data-terminal-shell-wrap]");
      if (shell) shell.hidden = subject.kind !== "service";
      const options = box.querySelector<HTMLDetailsElement>("[data-terminal-options]");
      if (options) {
        options.hidden = subject.kind === "ssh";
        options.open = true;
      }
      const confirm = box.querySelector<HTMLElement>("[data-terminal-confirm]");
      if (confirm) confirm.hidden = true;
      end();
      status("");
      openDialog(box, opener);
      if (subject.kind === "ssh") void connect();
      else void loadContainers();
      return;
    }
    if (!target?.closest("[data-terminal]")) return;
    if (target.closest("[data-terminal-connect]")) {
      event.preventDefault();
      void connect();
    } else if (target.closest("[data-terminal-close]")) {
      event.preventDefault();
      askToClose();
    } else if (target.closest("[data-terminal-keep]")) {
      const confirm = dialog()?.querySelector<HTMLElement>("[data-terminal-confirm]");
      if (confirm) confirm.hidden = true;
      session.term?.focus();
    } else if (target.closest("[data-terminal-end]")) {
      end();
      dialog()?.close();
    }
  });
  // A backdrop click and Escape go through the same question while a shell is open.
  document.addEventListener(
    "click",
    (event) => {
      const box = event.target as Element | null;
      if (!box?.matches?.("[data-terminal]") || !session.open) return;
      event.stopPropagation();
      askToClose();
    },
    true,
  );
  document.addEventListener(
    "cancel",
    (event) => {
      if (!(event.target as Element | null)?.matches?.("[data-terminal]")) return;
      if (session.open) {
        event.preventDefault();
        askToClose();
      }
    },
    true,
  );
  document.addEventListener(
    "close",
    (event) => {
      if ((event.target as Element | null)?.matches?.("[data-terminal]")) end();
    },
    true,
  );
  document.addEventListener("astro:before-swap", end);
}
