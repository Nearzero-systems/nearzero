import { AttachAddon } from "@xterm/addon-attach";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "xterm-addon-fit";
import { getAuthenticatedPlatformWebSocketUrl } from "@/lib/platform-websocket";
import { getXtermTheme } from "@/lib/terminal-theme";
import "@xterm/xterm/css/xterm.css";

type MountOpts = {
	containerId: string;
	serverId?: string;
	activeWay?: "bash" | "sh";
};

let activeCleanup: (() => void) | null = null;

export function mountDockerTerminal(
	host: HTMLElement,
	opts: MountOpts,
): () => void {
	activeCleanup?.();
	host.innerHTML = "";

	const { containerId, serverId, activeWay = "sh" } = opts;
	if (!containerId || containerId === "select-a-container") {
		host.textContent = "Select a container to open the terminal.";
		return () => {};
	}

	const term = new Terminal({
		cursorBlink: true,
		lineHeight: 1.4,
		convertEol: true,
		theme: getXtermTheme(),
	});
	const fitAddon = new FitAddon();
	const params = new URLSearchParams({
		containerId,
		activeWay,
	});
	if (serverId) params.set("serverId", serverId);

	term.open(host);
	term.loadAddon(fitAddon);
	fitAddon.fit();

	const onResize = () => fitAddon.fit();
	window.addEventListener("resize", onResize);

	// The auth ticket is fetched asynchronously (over the same-origin proxy)
	// before opening the socket on split deployments, so create the WS once the
	// URL resolves and guard against teardown happening first.
	let ws: WebSocket | null = null;
	let disposed = false;
	void getAuthenticatedPlatformWebSocketUrl(
		"/docker-container-terminal",
		params,
	).then((url) => {
		if (disposed) return;
		ws = new WebSocket(url);
		term.loadAddon(new AttachAddon(ws));
	});

	const cleanup = () => {
		disposed = true;
		window.removeEventListener("resize", onResize);
		if (ws && ws.readyState === WebSocket.OPEN) ws.close();
		term.dispose();
		activeCleanup = null;
	};
	activeCleanup = cleanup;
	return cleanup;
}

export function disconnectDockerTerminal() {
	activeCleanup?.();
	activeCleanup = null;
}
