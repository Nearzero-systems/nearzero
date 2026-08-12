import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import {
	getPublicInstallSetupStatus,
	InstallSetupError,
	submitInstallSetup,
	verifyInstallSetupToken,
} from "@nearzero/server/services/install-setup";
import {
	getInstallSetupReadiness,
	InstallSetupReadinessError,
} from "@nearzero/server/services/install-setup-readiness";

export const INSTALL_SETUP_SESSION_COOKIE = "nearzero_install_setup_token";
export const INSTALL_SETUP_JSON_BODY_LIMIT_BYTES = 16 * 1024;
const INSTALL_SETUP_SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;
const MAX_SETUP_TOKEN_LENGTH = 256;
const MAX_CLIENT_ADDRESS_LENGTH = 128;
const MAX_FORWARDED_FOR_LENGTH = 2_048;
const MAX_FORWARDED_HOPS = 32;

export class InstallSetupBodyTooLargeError extends Error {
	constructor() {
		super("Install setup request body is too large");
		this.name = "InstallSetupBodyTooLargeError";
	}
}

function json(res: ServerResponse, status: number, body: unknown) {
	res.statusCode = status;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.setHeader("cache-control", "no-store");
	res.end(JSON.stringify(body));
}

function normalizedClientAddress(value: string | undefined) {
	const candidate = value?.trim();
	if (!candidate || candidate.length > MAX_CLIENT_ADDRESS_LENGTH) return null;
	if (isIP(candidate)) return candidate.toLowerCase();

	const bracketed = candidate.match(/^\[([^\]]+)](?::\d{1,5})?$/);
	if (bracketed?.[1] && isIP(bracketed[1]) === 6) {
		return bracketed[1].toLowerCase();
	}
	const ipv4WithPort = candidate.match(/^(.+):(\d{1,5})$/);
	if (ipv4WithPort?.[1] && isIP(ipv4WithPort[1]) === 4) {
		return ipv4WithPort[1];
	}
	return null;
}

export function installSetupClientKey(
	req: Pick<IncomingMessage, "headers" | "socket">,
) {
	const forwardedHeader = req.headers["x-forwarded-for"];
	const forwarded = Array.isArray(forwardedHeader)
		? forwardedHeader.join(",")
		: forwardedHeader;
	if (forwarded?.trim()) {
		const hops = forwarded
			.slice(-MAX_FORWARDED_FOR_LENGTH)
			.split(",")
			.slice(-MAX_FORWARDED_HOPS);
		for (let index = hops.length - 1; index >= 0; index -= 1) {
			const address = normalizedClientAddress(hops[index]);
			if (address) return address;
		}
	}
	return normalizedClientAddress(req.socket.remoteAddress) ?? "unknown";
}

export function readInstallSetupJsonBody(req: IncomingMessage) {
	const declaredLength = Number(headerValue(req.headers["content-length"]));
	if (
		Number.isFinite(declaredLength) &&
		declaredLength > INSTALL_SETUP_JSON_BODY_LIMIT_BYTES
	) {
		req.resume();
		return Promise.reject(new InstallSetupBodyTooLargeError());
	}

	return new Promise<Record<string, unknown> | null>((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let settled = false;

		const cleanup = () => {
			req.removeListener("data", onData);
			req.removeListener("end", onEnd);
			req.removeListener("error", onError);
			req.removeListener("aborted", onAborted);
		};
		const finish = (error: unknown, value?: Record<string, unknown> | null) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (error) reject(error);
			else resolve(value ?? null);
		};
		const onData = (chunk: Buffer | string) => {
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			size += bytes.length;
			if (size > INSTALL_SETUP_JSON_BODY_LIMIT_BYTES) {
				finish(new InstallSetupBodyTooLargeError());
				// Drain the remainder so the server can send a clean 413 on this socket.
				req.resume();
				return;
			}
			chunks.push(bytes);
		};
		const onEnd = () => {
			const raw = Buffer.concat(chunks);
			if (!raw.length) {
				finish(null, null);
				return;
			}
			try {
				const value = JSON.parse(raw.toString("utf8"));
				finish(
					null,
					value && typeof value === "object" && !Array.isArray(value)
						? (value as Record<string, unknown>)
						: null,
				);
			} catch {
				finish(null, null);
			}
		};
		const onError = (error: Error) => finish(error);
		const onAborted = () => finish(new Error("Request body was aborted"));

		req.on("data", onData);
		req.once("end", onEnd);
		req.once("error", onError);
		req.once("aborted", onAborted);
	});
}

function cookieValue(cookieHeader: string | undefined, name: string) {
	if (!cookieHeader) return null;
	for (const part of cookieHeader.split(";")) {
		const separator = part.indexOf("=");
		if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
		try {
			return decodeURIComponent(part.slice(separator + 1).trim());
		} catch {
			return null;
		}
	}
	return null;
}

function headerValue(value: string | string[] | undefined) {
	return Array.isArray(value) ? value[0] : value;
}

function installSetupBodyTooLarge(res: ServerResponse, error: unknown) {
	if (!(error instanceof InstallSetupBodyTooLargeError)) return false;
	json(res, 413, {
		message: "Install setup request body is too large",
		code: "PAYLOAD_TOO_LARGE",
	});
	return true;
}

export function installSetupRequestToken(
	req: Pick<IncomingMessage, "headers">,
) {
	const headerToken = headerValue(
		req.headers["x-nearzero-setup-token"],
	)?.trim();
	if (headerToken) return headerToken;
	return (
		cookieValue(
			headerValue(req.headers.cookie),
			INSTALL_SETUP_SESSION_COOKIE,
		)?.trim() || null
	);
}

export function installSetupRequestIsHttps(
	req: Pick<IncomingMessage, "headers" | "socket">,
) {
	const forwardedProtocol = headerValue(req.headers["x-forwarded-proto"])
		?.split(",")[0]
		?.trim()
		.toLowerCase();
	return (
		forwardedProtocol === "https" ||
		Boolean((req.socket as { encrypted?: boolean }).encrypted)
	);
}

export function installSetupSessionCookie(token: string, secure: boolean) {
	const attributes = [
		`${INSTALL_SETUP_SESSION_COOKIE}=${encodeURIComponent(token)}`,
		`Max-Age=${INSTALL_SETUP_SESSION_MAX_AGE_SECONDS}`,
		"Path=/api/install/setup",
		"HttpOnly",
		"SameSite=Strict",
	];
	if (secure) attributes.push("Secure");
	return attributes.join("; ");
}

export function installSetupSubmitPayload(
	body: Record<string, unknown>,
	req: Pick<IncomingMessage, "headers">,
) {
	const requestToken = installSetupRequestToken(req);
	return requestToken ? { ...body, token: requestToken } : body;
}

function readinessErrorStatus(error: InstallSetupReadinessError) {
	return error.code === "UNAUTHORIZED"
		? 401
		: error.code === "FORBIDDEN"
			? 403
			: error.code === "RATE_LIMITED"
				? 429
				: 504;
}

export async function handleInstallSetup(
	req: IncomingMessage,
	res: ServerResponse,
) {
	const pathname = (req.url ?? "/").split("?")[0] ?? "/";
	const method = (req.method ?? "GET").toUpperCase();

	if (pathname === "/api/install/setup-status" && method === "GET") {
		try {
			return json(res, 200, await getPublicInstallSetupStatus());
		} catch (error) {
			console.error("install setup status failed:", error);
			return json(res, 500, { message: "Failed to load install setup status" });
		}
	}

	if (pathname === "/api/install/setup/session" && method === "POST") {
		try {
			const body = await readInstallSetupJsonBody(req);
			const token = typeof body?.token === "string" ? body.token.trim() : "";
			if (
				!token ||
				token.length > MAX_SETUP_TOKEN_LENGTH ||
				!verifyInstallSetupToken(token)
			) {
				return json(res, 401, {
					message: "Invalid or expired setup token",
					code: "UNAUTHORIZED",
				});
			}
			const status = await getPublicInstallSetupStatus();
			if (!status.community) {
				return json(res, 403, {
					message: "Install setup is only available on Community editions",
					code: "FORBIDDEN",
				});
			}
			if (status.bootstrapClaimed) {
				return json(res, 403, {
					message:
						"Install setup is no longer available after the first owner exists",
					code: "FORBIDDEN",
				});
			}
			res.setHeader(
				"set-cookie",
				installSetupSessionCookie(token, installSetupRequestIsHttps(req)),
			);
			return json(res, 200, { ok: true });
		} catch (error) {
			if (installSetupBodyTooLarge(res, error)) return;
			console.error("install setup session failed:", error);
			return json(res, 500, {
				message: "Failed to create install setup session",
			});
		}
	}

	if (pathname === "/api/install/setup/readiness" && method === "POST") {
		try {
			const readiness = await getInstallSetupReadiness({
				token: installSetupRequestToken(req) ?? "",
				clientKey: installSetupClientKey(req),
			});
			return json(res, 200, readiness);
		} catch (error) {
			if (error instanceof InstallSetupReadinessError) {
				if (error.code === "RATE_LIMITED") {
					res.setHeader("retry-after", "60");
				}
				return json(res, readinessErrorStatus(error), {
					message: error.message,
					code: error.code,
				});
			}
			console.error("install setup readiness failed:", error);
			return json(res, 500, { message: "Failed to check install readiness" });
		}
	}

	if (pathname === "/api/install/setup" && method === "POST") {
		try {
			const body = await readInstallSetupJsonBody(req);
			if (!body) {
				return json(res, 400, { message: "Invalid JSON body" });
			}
			const submitBody = installSetupSubmitPayload(body, req);
			const status = await submitInstallSetup(submitBody, {
				clientKey: installSetupClientKey(req),
			});
			return json(res, 200, status);
		} catch (error) {
			if (installSetupBodyTooLarge(res, error)) return;
			if (error instanceof InstallSetupError) {
				const status =
					error.code === "UNAUTHORIZED"
						? 401
						: error.code === "FORBIDDEN"
							? 403
							: error.code === "RATE_LIMITED"
								? 429
								: error.code === "CONFLICT"
									? 409
									: 400;
				return json(res, status, { message: error.message, code: error.code });
			}
			if (
				error &&
				typeof error === "object" &&
				"name" in error &&
				(error as { name: string }).name === "ZodError"
			) {
				return json(res, 400, {
					message: "Invalid setup payload",
					code: "BAD_REQUEST",
				});
			}
			console.error("install setup submit failed:", error);
			return json(res, 500, { message: "Failed to apply install setup" });
		}
	}

	return json(res, 404, { message: "Not found" });
}
