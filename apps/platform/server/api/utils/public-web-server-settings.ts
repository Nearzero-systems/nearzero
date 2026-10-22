/**
 * The host SSH private key and the monitoring token are write-only: the
 * console only needs to know whether a key is configured.
 */
export const toPublicWebServerSettings = <
	T extends {
		sshPrivateKey?: string | null;
		metricsConfig?: { server?: { token?: string } } | null;
	},
>(
	settings: T | null | undefined,
) => {
	if (!settings) return settings ?? null;
	const { sshPrivateKey, metricsConfig, ...rest } = settings;
	return {
		...rest,
		hasSshPrivateKey: Boolean(sshPrivateKey),
		metricsConfig: metricsConfig?.server
			? { ...metricsConfig, server: { ...metricsConfig.server, token: "" } }
			: metricsConfig,
	};
};
