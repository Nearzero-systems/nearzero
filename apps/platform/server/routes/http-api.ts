import type { IncomingMessage, ServerResponse } from "node:http";
import { buffer } from "node:stream/consumers";
import { parse as parseUrl } from "node:url";
import type { ApiRequest, ApiResponse } from "@/server/types/api";

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
	return buffer(req);
}

export async function prepareApiRequest(req: ApiRequest) {
	if (req.method === "GET" || req.method === "HEAD") return;
	const contentType = req.headers["content-type"] ?? "";
	if (contentType.includes("application/json")) {
		const raw = await readRawBody(req);
		req.body = raw.length ? JSON.parse(raw.toString("utf8")) : undefined;
	} else if (
		contentType.includes("application/x-www-form-urlencoded") ||
		contentType.includes("multipart/form-data")
	) {
		const raw = await readRawBody(req);
		req.body = raw;
	} else {
		const raw = await readRawBody(req);
		req.body = raw.length ? raw : undefined;
	}
}

function enhanceResponse<T>(res: ServerResponse): ApiResponse<T> {
	const enhanced = res as ApiResponse<T>;
	if (!enhanced.status) {
		enhanced.status = (code: number) => {
			res.statusCode = code;
			return enhanced;
		};
	}
	if (!enhanced.json) {
		enhanced.json = (body: unknown) => {
			if (!res.headersSent) {
				res.setHeader("content-type", "application/json; charset=utf-8");
			}
			res.end(JSON.stringify(body));
		};
	}
	if (!enhanced.redirect) {
		enhanced.redirect = (statusOrUrl: number | string, url?: string) => {
			const status =
				typeof statusOrUrl === "number" ? statusOrUrl : url ? 307 : 302;
			const location =
				typeof statusOrUrl === "string" ? statusOrUrl : (url ?? "/");
			res.statusCode = status;
			res.setHeader("Location", location);
			res.end();
		};
	}
	if (!enhanced.send) {
		enhanced.send = (body: unknown) => {
			if (typeof body === "object" && body !== null) {
				enhanced.json(body as T);
			} else {
				res.end(String(body ?? ""));
			}
		};
	}
	return enhanced;
}

export function createApiRequest(
	req: IncomingMessage,
	params: Record<string, string | string[] | undefined> = {},
): ApiRequest {
	const parsed = parseUrl(req.url ?? "/", true);
	const enhanced = req as ApiRequest;
	enhanced.query = { ...parsed.query, ...params };
	enhanced.cookies = enhanced.cookies ?? {};
	return enhanced;
}

export async function runApiHandler(
	req: IncomingMessage,
	res: ServerResponse,
	params: Record<string, string | string[] | undefined>,
	handler: (req: ApiRequest, res: ApiResponse) => void | Promise<void>,
	options?: { parseBody?: boolean },
) {
	const apiReq = createApiRequest(req, params);
	if (options?.parseBody !== false) {
		await prepareApiRequest(apiReq);
	}
	const apiRes = enhanceResponse(res);
	await handler(apiReq, apiRes);
}
