import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { joinBackendUrl } from "./backendProxy";
import type { AppRouter } from "./app-router";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createServerTrpcClient(request: Request): any {
	const cookie = request.headers.get("cookie") ?? "";
	return createTRPCProxyClient<AppRouter>({
		links: [
			httpBatchLink({
				url: joinBackendUrl("/api/trpc"),
				headers: () => (cookie ? { cookie } : {}),
				transformer: superjson,
			}),
		],
	});
}

export type ServerTrpcClient = ReturnType<typeof createServerTrpcClient>;
