import { rejectPendingInvitationForUser } from "@nearzero/server";
import { TRPCError } from "@trpc/server";
import { createTRPCContext } from "@/server/api/trpc";
import type { ApiRequest, ApiResponse } from "@/server/types/api";

export default async function handler(req: ApiRequest, res: ApiResponse) {
	if (req.method !== "POST") {
		return res.status(405).json({ message: "Method not allowed" });
	}

	const ctx = await createTRPCContext({
		req,
		res: res as Parameters<typeof createTRPCContext>[0]["res"],
	});

	if (!ctx.user) {
		return res.status(401).json({
			message: "Sign in to decline this invitation",
		});
	}

	const token =
		typeof req.body?.token === "string" ? req.body.token.trim() : "";
	if (!token) {
		return res.status(400).json({ message: "Invalid invitation link" });
	}

	try {
		await rejectPendingInvitationForUser(ctx.user.id, token);
		return res.status(200).json({ success: true });
	} catch (err) {
		const message =
			err instanceof TRPCError
				? err.message
				: err instanceof Error
					? err.message
					: "Could not decline this invitation";

		const status =
			err instanceof TRPCError
				? err.code === "NOT_FOUND"
					? 404
					: err.code === "FORBIDDEN" || err.code === "UNAUTHORIZED"
						? 403
						: 400
				: 400;

		return res.status(status).json({ message });
	}
}
