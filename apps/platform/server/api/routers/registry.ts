import {
	createRegistry,
	findRegistryById,
	loginDockerRegistry,
	removeRegistry,
	updateRegistry,
} from "@nearzero/server";
import { db } from "@nearzero/server/db";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { audit } from "@/server/api/utils/audit";
import {
	apiCreateRegistry,
	apiFindOneRegistry,
	apiRemoveRegistry,
	apiTestRegistry,
	apiTestRegistryById,
	apiUpdateRegistry,
	registry,
} from "@/server/db/schema";
import { createTRPCRouter, withPermission } from "../trpc";
export const registryRouter = createTRPCRouter({
	create: withPermission("registry", "create")
		.input(apiCreateRegistry)
		.mutation(async ({ ctx, input }) => {
			const reg = await createRegistry(input, ctx.session.activeOrganizationId);
			await audit(ctx, {
				action: "create",
				resourceType: "registry",
				resourceId: reg.registryId,
				resourceName: reg.registryName,
			});
			return reg;
		}),
	remove: withPermission("registry", "delete")
		.input(apiRemoveRegistry)
		.mutation(async ({ ctx, input }) => {
			const registry = await findRegistryById(input.registryId);
			if (registry.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not allowed to delete this registry",
				});
			}
			await audit(ctx, {
				action: "delete",
				resourceType: "registry",
				resourceId: registry.registryId,
				resourceName: registry.registryName,
			});
			await removeRegistry(input.registryId);
			return registry;
		}),
	update: withPermission("registry", "create")
		.input(apiUpdateRegistry)
		.mutation(async ({ input, ctx }) => {
			const { registryId, ...rest } = input;
			const registry = await findRegistryById(registryId);
			if (registry.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not allowed to update this registry",
				});
			}
			const application = await updateRegistry(registryId, {
				...rest,
			});

			if (!application) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error updating registry",
				});
			}

			await audit(ctx, {
				action: "update",
				resourceType: "registry",
				resourceId: registryId,
				resourceName: registry.registryName,
			});
			return true;
		}),
	all: withPermission("registry", "read").query(async ({ ctx }) => {
		const registryResponse = await db.query.registry.findMany({
			where: eq(registry.organizationId, ctx.session.activeOrganizationId),
			columns: { password: false },
		});
		return registryResponse;
	}),
	one: withPermission("registry", "read")
		.input(apiFindOneRegistry)
		.query(async ({ input, ctx }) => {
			const registry = await findRegistryById(input.registryId);
			if (registry.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not allowed to access this registry",
				});
			}
			return registry;
		}),
	testRegistry: withPermission("registry", "read")
		.input(apiTestRegistry)
		.mutation(async ({ input }) => {
			try {
				await loginDockerRegistry({
					registryUrl: input.registryUrl,
					username: input.username,
					password: input.password,
					serverId: input.serverId,
				});

				return true;
			} catch {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Registry authentication failed",
				});
			}
		}),
	testRegistryById: withPermission("registry", "read")
		.input(apiTestRegistryById)
		.mutation(async ({ input, ctx }) => {
			try {
				const registryData = await db.query.registry.findFirst({
					where: eq(registry.registryId, input.registryId ?? ""),
				});

				if (!registryData) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Registry not found",
					});
				}

				if (registryData.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not allowed to test this registry",
					});
				}

				await loginDockerRegistry({
					registryUrl: registryData.registryUrl,
					username: registryData.username,
					password: registryData.password,
					serverId: input.serverId,
				});

				return true;
			} catch {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Registry authentication failed",
				});
			}
		}),
});
