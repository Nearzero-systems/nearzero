import type { IncomingMessage, ServerResponse } from "node:http";
import { validateRequest } from "@nearzero/server";
import { createOpenApiNodeHttpHandler } from "@nearzero/trpc-openapi";
import { appRouter } from "@/server/api/root";
import { createTRPCContext } from "@/server/api/trpc";

const openApiHandler = createOpenApiNodeHttpHandler({
	router: appRouter,
	createContext: createTRPCContext,
	onError:
		process.env.NODE_ENV === "development"
			? ({ path, error }: { path: string | undefined; error: Error }) => {
					console.error(
						`❌ OpenAPI failed on ${path ?? "<no-path>"}: ${error.message}`,
					);
				}
			: undefined,
});

export async function handleOpenApi(req: IncomingMessage, res: ServerResponse) {
	const { session, user } = await validateRequest(req);
	if (!user || !session) {
		res.statusCode = 401;
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ message: "Unauthorized" }));
		return;
	}
	await openApiHandler(req, res);
}
