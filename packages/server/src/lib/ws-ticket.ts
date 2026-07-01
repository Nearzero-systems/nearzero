import { createHmac, timingSafeEqual } from "node:crypto";
import { betterAuthSecret } from "./auth-secret";

/**
 * Short-lived, signed ticket used to authenticate browser WebSocket
 * connections (terminals, logs, stats) when the console and the platform API
 * run on different hostnames (e.g. app.* vs api.*).
 *
 * Browsers cannot attach custom headers to a WebSocket handshake and only send
 * cookies scoped to the target host, so a cross-subdomain WS may arrive without
 * the session cookie. The console mints a ticket over the authenticated
 * same-origin proxy (where the cookie is always present) and passes it as a
 * `wsToken` query parameter; the backend verifies it here.
 *
 * The ticket is stateless: it carries the user/organization and an expiry, all
 * signed with the better-auth secret. The TTL is intentionally tiny because it
 * is consumed immediately when the socket is opened.
 */

const TICKET_TTL_MS = 60_000;
const TICKET_VERSION = "v1";

export interface WebSocketTicketPayload {
	userId: string;
	organizationId: string;
}

interface SignedTicketPayload extends WebSocketTicketPayload {
	v: string;
	exp: number;
}

function base64UrlEncode(input: string): string {
	return Buffer.from(input, "utf8").toString("base64url");
}

function base64UrlDecode(input: string): string {
	return Buffer.from(input, "base64url").toString("utf8");
}

function sign(data: string): string {
	return createHmac("sha256", betterAuthSecret)
		.update(data)
		.digest("base64url");
}

export function createWebSocketTicket(payload: WebSocketTicketPayload): string {
	const body: SignedTicketPayload = {
		v: TICKET_VERSION,
		userId: payload.userId,
		organizationId: payload.organizationId,
		exp: Date.now() + TICKET_TTL_MS,
	};
	const encoded = base64UrlEncode(JSON.stringify(body));
	return `${encoded}.${sign(encoded)}`;
}

export function verifyWebSocketTicket(
	token: string | null | undefined,
): WebSocketTicketPayload | null {
	if (!token) return null;

	const [encoded, signature] = token.split(".");
	if (!encoded || !signature) return null;

	const expected = sign(encoded);
	// Constant-time comparison; bail out if lengths differ.
	const sigBuf = Buffer.from(signature);
	const expBuf = Buffer.from(expected);
	if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
		return null;
	}

	try {
		const body = JSON.parse(base64UrlDecode(encoded)) as SignedTicketPayload;
		if (body.v !== TICKET_VERSION) return null;
		if (typeof body.exp !== "number" || Date.now() > body.exp) return null;
		if (!body.userId || !body.organizationId) return null;
		return { userId: body.userId, organizationId: body.organizationId };
	} catch {
		return null;
	}
}
