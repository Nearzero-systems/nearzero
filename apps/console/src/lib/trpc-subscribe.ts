import {
	createTRPCClient,
	createWSClient,
	httpBatchLink,
	splitLink,
	wsLink,
} from "@trpc/client";
import superjson from "superjson";
import { getAuthenticatedPlatformWebSocketUrl } from "@/lib/platform-websocket";

let wsClientSingleton: ReturnType<typeof createWSClient> | null = null;

function getWsClient() {
	if (!wsClientSingleton) {
		wsClientSingleton = createWSClient({
			// Resolved lazily so each (re)connection attaches a fresh auth ticket
			// for cross-subdomain deployments.
			url: () => getAuthenticatedPlatformWebSocketUrl("/drawer-logs"),
			lazy: { enabled: true, closeMs: 3000 },
		});
	}
	return wsClientSingleton;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TrpcAnyClient = ReturnType<typeof createTRPCClient<any>>;

let clientSingleton: TrpcAnyClient | null = null;

function getTrpcClient(): TrpcAnyClient {
	if (!clientSingleton) {
		clientSingleton = createTRPCClient({
			links: [
				splitLink({
					condition: (op) => op.type === "subscription",
					true: wsLink({
						client: getWsClient(),
						transformer: superjson,
					}),
					false: httpBatchLink({
						url: "/api/trpc",
						transformer: superjson,
					}),
				}),
			],
		});
	}
	return clientSingleton;
}

export function trpcSubscribe<TOutput>(
	procedure: string,
	input: unknown,
	handlers: {
		onData: (value: TOutput) => void;
		onError?: (err: unknown) => void;
		onComplete?: () => void;
	},
): () => void {
	const [router, method] = procedure.split(".");
	if (!router || !method) {
		throw new Error(`Invalid subscription procedure: ${procedure}`);
	}

	const client = getTrpcClient() as Record<
		string,
		Record<
			string,
			{
				subscribe: (
					input: unknown,
					opts: {
						onData: (value: TOutput) => void;
						onError?: (err: unknown) => void;
						onComplete?: () => void;
					},
				) => { unsubscribe: () => void };
			}
		>
	>;

	const sub = client[router]?.[method]?.subscribe(input, handlers);
	if (!sub) {
		throw new Error(`Subscription not found: ${procedure}`);
	}
	return () => sub.unsubscribe();
}
