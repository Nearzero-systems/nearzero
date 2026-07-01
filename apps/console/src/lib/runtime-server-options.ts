export type RuntimeServerOption = {
	serverId: string;
	name: string;
	ipAddress?: string | null;
	port?: number | null;
	setupStatus?: string | null;
	serverStatus?: string | null;
};

export function isReadyRuntimeServer(server: RuntimeServerOption) {
	return server.serverStatus === "active" && server.setupStatus === "ready";
}

export function listReadyRuntimeServers<T extends RuntimeServerOption>(
	servers: T[],
) {
	return servers.filter(isReadyRuntimeServer);
}

export function formatRuntimeServerLabel(server: RuntimeServerOption) {
	return server.ipAddress ? `${server.name} (${server.ipAddress})` : server.name;
}

export function formatRuntimeServerReadiness(server: RuntimeServerOption) {
	if (isReadyRuntimeServer(server)) return "Ready";
	if (server.serverStatus && server.serverStatus !== "active") {
		return "Inactive";
	}
	if (server.setupStatus === "running") return "Setup running";
	if (server.setupStatus === "failed") return "Setup failed";
	return "Setup needed";
}

export function runtimeServerRequirementMessage(servers: RuntimeServerOption[]) {
	return servers.length > 0
		? "Complete setup for an existing server before creating services."
		: "Add and complete setup for a server before creating services.";
}

export function runtimeServerPlaceholder(servers: RuntimeServerOption[]) {
	return servers.length > 0
		? "Complete server setup first"
		: "Add a ready server first";
}
