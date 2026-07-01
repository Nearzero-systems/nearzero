import type { IncomingMessage, ServerResponse } from "node:http";

/** Node HTTP API types for route handlers. */
export type ApiRequest = IncomingMessage & {
	query: Record<string, string | string[] | undefined>;
	cookies: Partial<Record<string, string>>;
	/** Parsed JSON/form/raw request body. Route handlers validate the shape they need. */
	body?: any;
};

export type ApiResponse<T = unknown> = ServerResponse & {
	status(code: number): ApiResponse<T>;
	json(body: T): void;
	redirect(statusOrUrl: number | string, url?: string): void;
	send(body: unknown): void;
	end(data?: unknown): ServerResponse;
	setHeader(
		name: string,
		value: string | number | readonly string[],
	): ApiResponse<T>;
};
