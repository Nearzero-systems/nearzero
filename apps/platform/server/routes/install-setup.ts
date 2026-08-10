import type { IncomingMessage, ServerResponse } from "node:http";
import { buffer } from "node:stream/consumers";
import {
	getPublicInstallSetupStatus,
	InstallSetupError,
	submitInstallSetup,
} from "@nearzero/server/services/install-setup";

function json(res: ServerResponse, status: number, body: unknown) {
	res.statusCode = status;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.setHeader("cache-control", "no-store");
	res.end(JSON.stringify(body));
}

function clientKey(req: IncomingMessage) {
	const forwarded = req.headers["x-forwarded-for"];
	if (typeof forwarded === "string" && forwarded.trim()) {
		return forwarded.split(",")[0]?.trim() || "unknown";
	}
	return req.socket.remoteAddress || "unknown";
}

async function readJsonBody(req: IncomingMessage) {
	const raw = await buffer(req);
	if (!raw.length) return null;
	try {
		return JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
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

	if (pathname === "/api/install/setup" && method === "POST") {
		try {
			const body = await readJsonBody(req);
			if (!body) {
				return json(res, 400, { message: "Invalid JSON body" });
			}
			const status = await submitInstallSetup(body, {
				clientKey: clientKey(req),
			});
			return json(res, 200, status);
		} catch (error) {
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
