import type { IncomingMessage, ServerResponse } from "node:http";
import { getConfiguredSocialAuthProviders } from "@nearzero/server/lib/social-auth-providers";

export function handleSocialAuthProviders(
	_req: IncomingMessage,
	res: ServerResponse,
) {
	res.statusCode = 200;
	res.setHeader("content-type", "application/json");
	res.end(
		JSON.stringify({
			providers: getConfiguredSocialAuthProviders(),
		}),
	);
}
