import type { IncomingMessage, ServerResponse } from "node:http";
import { auth } from "@nearzero/server/index";
import { toNodeHandler } from "better-auth/node";

const authHandler = toNodeHandler(auth.handler);

export function handleAuth(req: IncomingMessage, res: ServerResponse) {
	return authHandler(req, res);
}
