import { getAuthenticatedPlatformWebSocketUrl } from "@/lib/platform-websocket";

type MountOpts = {
	containerId: string;
	serverId?: string;
	runType: "native" | "swarm";
};

let activeWs: WebSocket | null = null;
let activeToken = 0;

export function mountDockerLogs(el: HTMLElement, opts: MountOpts) {
	disconnectDockerLogs();
	el.textContent = "";

	const { containerId, serverId, runType } = opts;
	const params = new URLSearchParams({
		containerId,
		tail: "100",
		since: "all",
		search: "",
		runType,
	});
	if (serverId) params.append("serverId", serverId);

	const token = ++activeToken;
	let buffer = "";

	void getAuthenticatedPlatformWebSocketUrl(
		"/docker-container-logs",
		params,
	).then((url) => {
		// A newer mount (or a disconnect) superseded this one before the ticket
		// resolved; abandon this connection attempt.
		if (token !== activeToken) return;

		const ws = new WebSocket(url);
		activeWs = ws;

		ws.onmessage = (e) => {
			buffer += String(e.data ?? "");
			const lines = buffer.split("\n");
			if (lines.length > 500) buffer = lines.slice(-500).join("\n");
			el.textContent = buffer;
			el.scrollTop = el.scrollHeight;
		};

		ws.onerror = () => {
			if (!buffer) el.textContent = "Failed to connect to log stream";
		};

		ws.onclose = () => {
			if (!buffer) el.textContent = "No logs found";
		};
	});
}

export function disconnectDockerLogs() {
	activeToken++;
	activeWs?.close();
	activeWs = null;
}
