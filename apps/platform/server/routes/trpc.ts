import type { IncomingMessage, ServerResponse } from "node:http";
import { ExecError } from "@nearzero/server";
import { nodeHTTPRequestHandler } from "@trpc/server/adapters/node-http";
import { appRouter } from "@/server/api/root";
import { createTRPCContext } from "@/server/api/trpc";

const ONE_GB = 1024 * 1024 * 1024;

export async function handleTrpc(req: IncomingMessage, res: ServerResponse) {
	const pathname = (req.url ?? "/").split("?")[0] ?? "/";
	const path = pathname.replace(/^\/api\/trpc\/?/, "");
	await nodeHTTPRequestHandler({
		req,
		res,
		path,
		router: appRouter,
		createContext: createTRPCContext,
		maxBodySize: ONE_GB,
		onError:
			process.env.NODE_ENV === "development"
				? ({ path: trpcPath, error }) => {
						const cause = error.cause;
						if (cause instanceof ExecError) {
							console.error(
								`❌ tRPC failed on ${trpcPath ?? "<no-path>"}: ${cause.toUserMessage()}`,
							);
							return;
						}
						console.error(
							`❌ tRPC failed on ${trpcPath ?? "<no-path>"}: ${error.message}`,
						);
					}
				: undefined,
	});
}
