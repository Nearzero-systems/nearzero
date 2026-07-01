import type { IncomingMessage, ServerResponse } from "node:http";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type OpenApiMeta = {
	openapi?: {
		method: HttpMethod;
		path: string;
		tags?: string[];
		summary?: string;
		description?: string;
		protect?: boolean;
		enabled?: boolean;
		override?: boolean;
		[key: string]: unknown;
	};
};

type GenerateOptions = {
	title: string;
	version: string;
	baseUrl: string;
	docsUrl?: string;
	tags?: string[];
};

type OpenApiDocument = {
	openapi: "3.0.0";
	info: {
		title: string;
		version: string;
		description?: string;
		contact?: Record<string, unknown>;
		license?: Record<string, unknown>;
	};
	servers: Array<{ url: string }>;
	tags?: Array<{ name: string }>;
	paths: Record<string, unknown>;
	components?: Record<string, unknown>;
	security?: Array<Record<string, string[]>>;
	externalDocs?: { description?: string; url: string };
};

export function generateOpenApiDocument(
	_router: unknown,
	options: GenerateOptions,
): OpenApiDocument {
	return {
		openapi: "3.0.0",
		info: {
			title: options.title,
			version: options.version,
		},
		servers: [{ url: options.baseUrl }],
		tags: options.tags?.map((name) => ({ name })),
		paths: {},
		externalDocs: options.docsUrl
			? { description: "Documentation", url: options.docsUrl }
			: undefined,
	};
}

export function createOpenApiNodeHttpHandler(_opts: {
	router: unknown;
	createContext: (opts: {
		req: IncomingMessage;
		res: ServerResponse;
	}) => unknown | Promise<unknown>;
	onError?: (opts: { path: string | undefined; error: Error }) => void;
}) {
	return async (req: IncomingMessage, res: ServerResponse) => {
		res.statusCode = 404;
		res.setHeader("content-type", "application/json");
		res.end(
			JSON.stringify({
				message:
					"OpenAPI REST execution is not available in this build. Use /api/trpc or regenerate the local adapter.",
				path: req.url,
			}),
		);
	};
}
