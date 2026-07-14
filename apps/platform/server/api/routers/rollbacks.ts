import {
	findRollbackById,
	removeRollbackById,
	rollback,
} from "@nearzero/server";
import { checkServicePermissionAndAccess } from "@nearzero/server/services/permission";
import { TRPCError } from "@trpc/server";
import { audit } from "@/server/api/utils/audit";
import { apiFindOneRollback } from "@/server/db/schema";
import { createTRPCRouter, protectedProcedure } from "../trpc";

export const rollbackRouter = createTRPCRouter({
	delete: protectedProcedure
		.input(apiFindOneRollback)
		.mutation(async ({ input, ctx }) => {
			try {
				const rb = await findRollbackById(input.rollbackId);
				const serviceId = rb.deployment.applicationId;
				if (serviceId) {
					await checkServicePermissionAndAccess(ctx, serviceId, {
						deployment: ["create"],
					});
				}
				await removeRollbackById(input.rollbackId);
				await audit(ctx, {
					action: "delete",
					resourceType: "deployment",
					resourceId: input.rollbackId,
				});
				return { success: true, rollbackId: input.rollbackId };
			} catch {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Unable to delete rollback",
				});
			}
		}),
	rollback: protectedProcedure
		.input(apiFindOneRollback)
		.mutation(async ({ input, ctx }) => {
			try {
				const rb = await findRollbackById(input.rollbackId);
				const serviceId = rb.deployment.applicationId;
				if (serviceId) {
					await checkServicePermissionAndAccess(ctx, serviceId, {
						deployment: ["create"],
					});
				}
				const result = await rollback(input.rollbackId);
				await audit(ctx, {
					action: "restore",
					resourceType: "deployment",
					resourceId: input.rollbackId,
				});
				return result;
			} catch {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error input: Rolling back",
				});
			}
		}),
});
