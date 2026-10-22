import {
	containerKill,
	containerRemove,
	containerRestart,
	containerStart,
	containerStop,
	findServerById,
	getConfig,
	getContainers,
	getContainersByAppLabel,
	getContainersByAppNameMatch,
	getServiceContainersByAppName,
	getStackContainersByAppName,
	uploadFileToContainer,
} from "@nearzero/server";
import {
	canAccessLocalAppName,
	canAccessLocalContainer,
	isInstanceAdministrator,
} from "@nearzero/server/services/instance-access";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import { uploadFileToContainerSchema } from "@/utils/schema";
import { createTRPCRouter, withPermission } from "../trpc";

export const containerIdRegex = /^[a-zA-Z0-9.\-_]+$/;

type DockerAccessCtx = {
	user: { id: string };
	session: { activeOrganizationId: string };
};

const assertRemoteServerAccess = async (
	ctx: DockerAccessCtx,
	serverId: string,
) => {
	const server = await findServerById(serverId);
	if (server.organizationId !== ctx.session.activeOrganizationId) {
		throw new TRPCError({ code: "UNAUTHORIZED" });
	}
};

/** Listing every container on the shared local host is instance-admin only. */
const assertDockerHostAccess = async (
	ctx: DockerAccessCtx,
	serverId?: string,
) => {
	if (serverId) return assertRemoteServerAccess(ctx, serverId);
	if (!(await isInstanceAdministrator(ctx.user.id))) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "Only instance administrators can manage the local Docker host.",
		});
	}
};

/** Local containers must belong to a service the caller can access. */
const assertContainerAccess = async (
	ctx: DockerAccessCtx,
	containerId: string,
	serverId?: string,
) => {
	if (serverId) return assertRemoteServerAccess(ctx, serverId);
	if (!(await canAccessLocalContainer(ctx, containerId))) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You don't have access to this container.",
		});
	}
};

const assertAppNameAccess = async (
	ctx: DockerAccessCtx,
	appName: string,
	serverId?: string,
) => {
	if (serverId) return assertRemoteServerAccess(ctx, serverId);
	if (!(await canAccessLocalAppName(ctx, appName))) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You don't have access to this service.",
		});
	}
};

export const dockerRouter = createTRPCRouter({
	getContainers: withPermission("docker", "read")
		.input(
			z.object({
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			await assertDockerHostAccess(ctx, input.serverId);
			return await getContainers(input.serverId);
		}),

	restartContainer: withPermission("service", "read")
		.input(
			z.object({
				containerId: z
					.string()
					.min(1)
					.regex(containerIdRegex, "Invalid container id."),
				serverId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			await assertContainerAccess(ctx, input.containerId, input.serverId);
			await containerRestart(input.containerId, input.serverId);
			await audit(ctx, {
				action: "start",
				resourceType: "docker",
				resourceId: input.containerId,
				resourceName: input.containerId,
			});
		}),

	startContainer: withPermission("service", "read")
		.input(
			z.object({
				containerId: z
					.string()
					.min(1)
					.regex(containerIdRegex, "Invalid container id."),
				serverId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			await assertContainerAccess(ctx, input.containerId, input.serverId);
			await containerStart(input.containerId, input.serverId);
			await audit(ctx, {
				action: "start",
				resourceType: "docker",
				resourceId: input.containerId,
				resourceName: input.containerId,
			});
		}),

	stopContainer: withPermission("service", "read")
		.input(
			z.object({
				containerId: z
					.string()
					.min(1)
					.regex(containerIdRegex, "Invalid container id."),
				serverId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			await assertContainerAccess(ctx, input.containerId, input.serverId);
			await containerStop(input.containerId, input.serverId);
			await audit(ctx, {
				action: "stop",
				resourceType: "docker",
				resourceId: input.containerId,
				resourceName: input.containerId,
			});
		}),

	killContainer: withPermission("service", "read")
		.input(
			z.object({
				containerId: z
					.string()
					.min(1)
					.regex(containerIdRegex, "Invalid container id."),
				serverId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			await assertContainerAccess(ctx, input.containerId, input.serverId);
			await containerKill(input.containerId, input.serverId);
			await audit(ctx, {
				action: "stop",
				resourceType: "docker",
				resourceId: input.containerId,
				resourceName: input.containerId,
			});
		}),

	removeContainer: withPermission("docker", "read")
		.input(
			z.object({
				containerId: z
					.string()
					.min(1)
					.regex(containerIdRegex, "Invalid container id."),
				serverId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			await assertContainerAccess(ctx, input.containerId, input.serverId);
			await containerRemove(input.containerId, input.serverId);
			await audit(ctx, {
				action: "delete",
				resourceType: "docker",
				resourceId: input.containerId,
				resourceName: input.containerId,
			});
		}),

	getConfig: withPermission("docker", "read")
		.input(
			z.object({
				containerId: z
					.string()
					.min(1)
					.regex(containerIdRegex, "Invalid container id."),
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			await assertContainerAccess(ctx, input.containerId, input.serverId);
			return await getConfig(input.containerId, input.serverId);
		}),

	getContainersByAppNameMatch: withPermission("service", "read")
		.input(
			z.object({
				appType: z.enum(["stack", "docker-compose"]).optional(),
				appName: z.string().min(1).regex(containerIdRegex, "Invalid app name."),
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			await assertAppNameAccess(ctx, input.appName, input.serverId);
			return await getContainersByAppNameMatch(
				input.appName,
				input.appType,
				input.serverId,
			);
		}),

	getContainersByAppLabel: withPermission("docker", "read")
		.input(
			z.object({
				appName: z.string().min(1).regex(containerIdRegex, "Invalid app name."),
				serverId: z.string().optional(),
				type: z.enum(["standalone", "swarm"]),
			}),
		)
		.query(async ({ input, ctx }) => {
			await assertAppNameAccess(ctx, input.appName, input.serverId);
			return await getContainersByAppLabel(
				input.appName,
				input.type,
				input.serverId,
			);
		}),

	getStackContainersByAppName: withPermission("docker", "read")
		.input(
			z.object({
				appName: z.string().min(1).regex(containerIdRegex, "Invalid app name."),
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			await assertAppNameAccess(ctx, input.appName, input.serverId);
			return await getStackContainersByAppName(input.appName, input.serverId);
		}),

	getServiceContainersByAppName: withPermission("docker", "read")
		.input(
			z.object({
				appName: z.string().min(1).regex(containerIdRegex, "Invalid app name."),
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			await assertAppNameAccess(ctx, input.appName, input.serverId);
			return await getServiceContainersByAppName(input.appName, input.serverId);
		}),

	uploadFileToContainer: withPermission("docker", "read")
		.input(uploadFileToContainerSchema)
		.mutation(async ({ input, ctx }) => {
			await assertContainerAccess(ctx, input.containerId, input.serverId);

			const file = input.file;
			if (!(file instanceof File)) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid file provided",
				});
			}

			// Convert File to Buffer
			const arrayBuffer = await file.arrayBuffer();
			const fileBuffer = Buffer.from(arrayBuffer);

			await uploadFileToContainer(
				input.containerId,
				fileBuffer,
				file.name,
				input.destinationPath,
				input.serverId || null,
			);

			return { success: true, message: "File uploaded successfully" };
		}),
});
