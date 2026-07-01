import { formatServiceScaleError } from "@nearzero/server";
import { TRPCError } from "@trpc/server";

type ServiceScaleAction = "start" | "stop";

export async function runServiceScaleAction<T>(
	action: ServiceScaleAction,
	operation: () => Promise<T>,
): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: formatServiceScaleError(error, action),
			cause: error,
		});
	}
}
