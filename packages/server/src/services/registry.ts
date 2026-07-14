import { db } from "@nearzero/server/db";
import { type apiCreateRegistry, registry } from "@nearzero/server/db/schema";
import {
	execAsync,
	execAsyncRemote,
	execFileAsync,
} from "@nearzero/server/utils/process/execAsync";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import type { z } from "zod";

export type Registry = typeof registry.$inferSelect;
export type PublicRegistry = Omit<Registry, "password">;

export function toPublicRegistry(value: Registry): PublicRegistry {
	const publicValue: Partial<Registry> = { ...value };
	delete publicValue.password;
	return publicValue as PublicRegistry;
}

type PublicRelatedRegistry<T> = T extends Registry ? PublicRegistry : T;
export type PublicRegistryRelations<T extends object> = Omit<
	T,
	"registry" | "rollbackRegistry"
> &
	("registry" extends keyof T
		? { registry: PublicRelatedRegistry<T["registry"]> }
		: unknown) &
	("rollbackRegistry" extends keyof T
		? { rollbackRegistry: PublicRelatedRegistry<T["rollbackRegistry"]> }
		: unknown);

/** Redact registry credentials nested in application/service API results. */
export function toPublicRegistryRelations<T extends object>(
	resource: T,
): PublicRegistryRelations<T> {
	const publicResource = { ...resource } as Record<string, unknown>;
	for (const key of ["registry", "rollbackRegistry"] as const) {
		const relatedRegistry = publicResource[key];
		if (relatedRegistry && typeof relatedRegistry === "object") {
			publicResource[key] = toPublicRegistry(relatedRegistry as Registry);
		}
	}
	return publicResource as PublicRegistryRelations<T>;
}

function shEscape(s: string | undefined): string {
	if (!s) return "''";
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function safeDockerLoginCommand(
	registry: string | undefined,
	user: string | undefined,
) {
	const escapedUser = shEscape(user);
	const registryTarget = registry ? ` ${shEscape(registry)}` : "";
	return `docker login${registryTarget} --username ${escapedUser} --password-stdin`;
}

export async function loginDockerRegistry(input: {
	registryUrl?: string;
	username?: string;
	password: string;
	serverId?: string | null;
}) {
	const passwordInput = `${input.password}\n`;
	if (input.serverId && input.serverId !== "none") {
		return execAsyncRemote(
			input.serverId,
			safeDockerLoginCommand(input.registryUrl, input.username),
			undefined,
			{ input: passwordInput },
		);
	}

	const args = [
		"login",
		...(input.registryUrl ? [input.registryUrl] : []),
		"--username",
		input.username ?? "",
		"--password-stdin",
	];
	return execFileAsync("docker", args, { input: passwordInput });
}

export const createRegistry = async (
	input: z.infer<typeof apiCreateRegistry>,
	organizationId: string,
) => {
	try {
		return await db.transaction(async (tx) => {
			const newRegistry = await tx
				.insert(registry)
				.values({
					...input,
					organizationId: organizationId,
				})
				.returning()
				.then((value) => value[0]);

			if (!newRegistry) throw new Error("Registry insert returned no row");

			if (input.serverId && input.serverId !== "none") {
				await loginDockerRegistry({
					registryUrl: input.registryUrl,
					username: input.username,
					password: input.password,
					serverId: input.serverId,
				});
			} else if (newRegistry.registryType === "cloud") {
				await loginDockerRegistry({
					registryUrl: input.registryUrl,
					username: input.username,
					password: input.password,
				});
			}

			return toPublicRegistry(newRegistry);
		});
	} catch {
		// Drizzle errors include bound SQL parameters, including the password.
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Unable to create registry",
		});
	}
};

export const removeRegistry = async (registryId: string) => {
	try {
		const response = await db
			.delete(registry)
			.where(eq(registry.registryId, registryId))
			.returning()
			.then((res) => res[0]);

		if (!response) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "Registry not found",
			});
		}

		await execAsync(`docker logout ${shEscape(response.registryUrl)}`);

		return toPublicRegistry(response);
	} catch (error) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error removing this registry",
			cause: error,
		});
	}
};

export const updateRegistry = async (
	registryId: string,
	registryData: Partial<Registry> & { serverId?: string | null },
) => {
	try {
		const { serverId, ...updates } = registryData;
		const response = await db
			.update(registry)
			.set({
				...updates,
			})
			.where(eq(registry.registryId, registryId))
			.returning()
			.then((res) => res[0]);

		if (!response) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "Registry not found",
			});
		}

		if (serverId && serverId !== "none") {
			await loginDockerRegistry({
				registryUrl: response.registryUrl,
				username: response.username,
				password: response.password,
				serverId,
			});
		} else if (response?.registryType === "cloud") {
			await loginDockerRegistry({
				registryUrl: response.registryUrl,
				username: response.username,
				password: response.password,
			});
		}

		return toPublicRegistry(response);
	} catch {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Unable to update registry",
		});
	}
};

export const findRegistryById = async (registryId: string) => {
	const registryResponse = await db.query.registry.findFirst({
		where: eq(registry.registryId, registryId),
		columns: {
			password: false,
		},
	});
	if (!registryResponse) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Registry not found",
		});
	}
	return registryResponse;
};

export const findAllRegistryByOrganizationId = async (
	organizationId: string,
) => {
	const registryResponse = await db.query.registry.findMany({
		where: eq(registry.organizationId, organizationId),
	});
	return registryResponse;
};

export const loginOrganizationRegistries = async (
	organizationId: string,
	serverId?: string | null,
) => {
	const registries = await findAllRegistryByOrganizationId(organizationId);

	for (const reg of registries) {
		if (serverId) {
			await loginDockerRegistry({
				registryUrl: reg.registryUrl,
				username: reg.username,
				password: reg.password,
				serverId,
			});
		} else if (reg.registryType === "cloud") {
			await loginDockerRegistry({
				registryUrl: reg.registryUrl,
				username: reg.username,
				password: reg.password,
			});
		}
	}
};
