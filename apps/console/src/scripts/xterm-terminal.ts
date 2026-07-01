import { getAuthenticatedPlatformWebSocketUrl } from "@/lib/platform-websocket";
import { getXtermTheme } from "@/lib/terminal-theme";
import "@xterm/xterm/css/xterm.css";

type LocalServerData = { port: number; username: string };

const DEFAULT_LOCAL: LocalServerData = { port: 22, username: "root" };

let activeWs: WebSocket | null = null;
let activeTerm: { dispose?: () => void } | null = null;
let activeResizeObserver: ResizeObserver | null = null;

export function getLocalServerData(): LocalServerData {
	try {
		const raw = localStorage.getItem("localServerData");
		if (!raw) return DEFAULT_LOCAL;
		const parsed = JSON.parse(raw) as Partial<LocalServerData>;
		return {
			port: parsed.port && parsed.port > 0 ? parsed.port : DEFAULT_LOCAL.port,
			username: parsed.username?.trim() || DEFAULT_LOCAL.username,
		};
	} catch {
		return DEFAULT_LOCAL;
	}
}

export function saveLocalServerData(data: LocalServerData) {
	localStorage.setItem("localServerData", JSON.stringify(data));
}

export function disconnectSshTerminal() {
	activeResizeObserver?.disconnect();
	activeResizeObserver = null;
	activeWs?.close();
	activeWs = null;
	activeTerm?.dispose?.();
	activeTerm = null;
}

export async function mountSshTerminal(
	container: HTMLElement,
	serverId: string,
) {
	disconnectSshTerminal();
	container.innerHTML = "";

	const [{ Terminal }, { FitAddon }, { AttachAddon }, { ClipboardAddon }] =
		await Promise.all([
			import("@xterm/xterm"),
			import("xterm-addon-fit"),
			import("@xterm/addon-attach"),
			import("@xterm/addon-clipboard"),
		]);

	const term = new Terminal({
		cursorBlink: true,
		lineHeight: 1.4,
		convertEol: true,
		fontFamily:
			'"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
		fontSize: 13,
		theme: getXtermTheme(),
	});

	const fitAddon = new FitAddon();
	const params = new URLSearchParams({ serverId });
	if (serverId === "local") {
		const { port, username } = getLocalServerData();
		params.set("port", String(port));
		params.set("username", username);
	}

	const ws = new WebSocket(
		await getAuthenticatedPlatformWebSocketUrl("/terminal", params),
	);
	activeWs = ws;
	const attachAddon = new AttachAddon(ws);
	const clipboardAddon = new ClipboardAddon();

	term.loadAddon(clipboardAddon);
	term.open(container);
	term.loadAddon(fitAddon);
	term.loadAddon(attachAddon);
	const fit = () => {
		window.requestAnimationFrame(() => fitAddon.fit());
	};
	fit();
	activeResizeObserver = new ResizeObserver(fit);
	activeResizeObserver.observe(container);
	activeTerm = term;

	// Surface connection problems instead of leaving a blank black box. The
	// backend may close the socket immediately (e.g. when the session cookie is
	// not sent on a cross-subdomain WebSocket), which otherwise shows nothing.
	let receivedData = false;
	ws.addEventListener("message", () => {
		receivedData = true;
	});
	ws.addEventListener("error", () => {
		term.write(
			"\x1b[31mUnable to reach the terminal WebSocket.\x1b[0m\r\n" +
				"Check that the API is reachable over wss and that you are signed in.\r\n",
		);
	});

	ws.addEventListener("close", (event) => {
		if (activeWs === ws) activeWs = null;
		// If the socket closed before any output arrived, the connection was
		// rejected (most often an auth/session failure on a split FE/BE setup).
		if (!receivedData) {
			const code = event.code ? ` (code ${event.code})` : "";
			const reason = event.reason ? `: ${event.reason}` : "";
			term.write(
				`\x1b[31mTerminal connection closed${code}${reason}.\x1b[0m\r\n` +
					"You may not be authenticated on this domain, or the API WebSocket is unreachable.\r\n",
			);
		}
	});
}
