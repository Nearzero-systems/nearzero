import { getWebServerSettings } from "@nearzero/server/services/web-server-settings";
import { findServerById } from "@nearzero/server/services/server";
import { TRPCError } from "@trpc/server";

export async function resolveDomainTargetIp(serverId?: string | null) {
	if (serverId) {
		const server = await findServerById(serverId);
		if (!server.ipAddress) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Remote server does not have an IP address configured",
			});
		}
		return server.ipAddress;
	}

	const settings = await getWebServerSettings();
	if (!settings?.serverIp) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Web server IP is not configured for managed DNS",
		});
	}
	return settings.serverIp;
}
