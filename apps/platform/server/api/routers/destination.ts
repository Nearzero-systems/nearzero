import {
	createDestination,
	findDestinationById,
	removeDestinationById,
	updateDestinationById,
} from "@nearzero/server";
import { db } from "@nearzero/server/db";
import { sanitizePublicErrorMessage } from "@nearzero/server/services/operational-log";
import {
	getDestinationSensitiveValues,
	getS3Credentials,
	quoteShellArgument,
} from "@nearzero/server/utils/backups/utils";
import { executeSensitiveShellScript } from "@nearzero/server/utils/process/execAsync";
import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import { createTRPCRouter, withPermission } from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import {
	apiCreateDestination,
	apiFindOneDestination,
	apiRemoveDestination,
	apiUpdateDestination,
	destinations,
} from "@/server/db/schema";

function toPublicDestination<
	T extends { accessKey: string; secretAccessKey: string },
>({ accessKey, secretAccessKey, ...destination }: T) {
	return {
		...destination,
		hasCredentials: Boolean(accessKey && secretAccessKey),
	};
}

export const destinationRouter = createTRPCRouter({
	create: withPermission("destination", "create")
		.input(apiCreateDestination)
		.mutation(async ({ input, ctx }) => {
			try {
				const result = await createDestination(
					input,
					ctx.session.activeOrganizationId,
				);
				await audit(ctx, {
					action: "create",
					resourceType: "destination",
					resourceId: result.destinationId,
					resourceName: input.name,
				});
				return result;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error creating the destination",
					cause: error,
				});
			}
		}),
	testConnection: withPermission("destination", "create")
		.input(apiCreateDestination)
		.mutation(async ({ input }) => {
			const {
				secretAccessKey,
				bucket,
				region,
				endpoint,
				accessKey,
				provider,
				additionalFlags,
			} = input;
			try {
				const rcloneFlags = [
					...getS3Credentials({
						accessKey,
						secretAccessKey,
						region,
						endpoint,
						provider,
						additionalFlags,
					}),
					"--retries 1",
					"--low-level-retries 1",
					"--timeout 10s",
					"--contimeout 5s",
				];
				const rcloneDestination = `:s3:${bucket}`;
				const rcloneCommand = `rclone ls ${rcloneFlags.join(" ")} ${quoteShellArgument(rcloneDestination)}`;
				await executeSensitiveShellScript({
					serverId: process.env.JOBS_URL ? input.serverId : null,
					script: rcloneCommand,
					sensitiveValues: getDestinationSensitiveValues(input),
				});
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: sanitizePublicErrorMessage(
						error instanceof Error ? error.message : error,
						"Error connecting to bucket",
					),
					cause: error,
				});
			}
		}),
	one: withPermission("destination", "read")
		.input(apiFindOneDestination)
		.query(async ({ input, ctx }) => {
			const destination = await findDestinationById(input.destinationId);
			if (destination.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not allowed to access this destination",
				});
			}
			return toPublicDestination(destination);
		}),
	all: withPermission("destination", "read").query(async ({ ctx }) => {
		const rows = await db.query.destinations.findMany({
			where: eq(destinations.organizationId, ctx.session.activeOrganizationId),
			orderBy: [desc(destinations.createdAt)],
		});
		return rows.map(toPublicDestination);
	}),
	remove: withPermission("destination", "delete")
		.input(apiRemoveDestination)
		.mutation(async ({ input, ctx }) => {
			try {
				const destination = await findDestinationById(input.destinationId);

				if (destination.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not allowed to delete this destination",
					});
				}
				const result = await removeDestinationById(
					input.destinationId,
					ctx.session.activeOrganizationId,
				);
				await audit(ctx, {
					action: "delete",
					resourceType: "destination",
					resourceId: input.destinationId,
					resourceName: destination.name,
				});
				return result ? toPublicDestination(result) : result;
			} catch (error) {
				throw error;
			}
		}),
	update: withPermission("destination", "create")
		.input(apiUpdateDestination)
		.mutation(async ({ input, ctx }) => {
			try {
				const destination = await findDestinationById(input.destinationId);
				if (destination.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not allowed to update this destination",
					});
				}
				const result = await updateDestinationById(input.destinationId, {
					...input,
					organizationId: ctx.session.activeOrganizationId,
				});
				await audit(ctx, {
					action: "update",
					resourceType: "destination",
					resourceId: input.destinationId,
					resourceName: input.name,
				});
				return result ? toPublicDestination(result) : result;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: sanitizePublicErrorMessage(
						error instanceof Error ? error.message : error,
						"Error updating the destination",
					),
					cause: error,
				});
			}
		}),
});
