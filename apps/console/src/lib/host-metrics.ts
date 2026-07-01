const DEFAULT_METRICS_PORT = 4500;

type MetricsServerConfig = {
	type?: "Nearzero" | "Remote";
	port?: number;
	token?: string;
};

type HostMetricsConfig = {
	serverIp?: string | null;
	metricsConfig?: {
		server?: MetricsServerConfig;
	};
};

/** Build the local Nearzero host metrics endpoint (platform server fetches this URL). */
export function buildHostMetricsUrl(
	config: HostMetricsConfig | null | undefined,
): string {
	const envUrl = process.env.NEARZERO_METRICS_URL?.trim();
	if (envUrl) return envUrl;

	const server = config?.metricsConfig?.server;
	const port = server?.port ?? DEFAULT_METRICS_PORT;
	const host =
		server?.type === "Remote" && config?.serverIp?.trim()
			? config.serverIp.trim()
			: "127.0.0.1";
	return `http://${host}:${port}/metrics`;
}

export function resolveHostMetricsToken(
	config: HostMetricsConfig | null | undefined,
): string {
	return config?.metricsConfig?.server?.token?.trim() ?? "";
}
