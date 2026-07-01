import { db } from "@nearzero/server/db";
import {
	account,
	apikey,
	invitation,
	member,
	organization,
	user,
} from "@nearzero/server/db/schema";
import { TRPCError } from "@trpc/server";
import * as bcrypt from "bcrypt";
import { and, eq } from "drizzle-orm";
import { auth } from "../lib/auth";
import { emailEquals } from "../lib/email-identity";
import { getUserByToken } from "./admin";

export type User = typeof user.$inferSelect;

export async function acceptPendingInvitationForUser(
	userId: string,
	token: string,
	options?: { firstName?: string; email?: string },
) {
	const invite = await getUserByToken(token);

	if (invite.isExpired) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Invitation has expired",
		});
	}

	if (invite.status !== "pending") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Invitation has already been used",
		});
	}

	const normalizedEmail = (options?.email || invite.email).trim().toLowerCase();
	if (normalizedEmail !== invite.email.trim().toLowerCase()) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Email does not match invitation",
		});
	}

	const currentUser = await db.query.user.findFirst({
		where: eq(user.id, userId),
		columns: { isRegistered: true },
	});
	const alreadyRegistered = Boolean(currentUser?.isRegistered);
	const providedFirstName = options?.firstName?.trim() ?? "";

	const existingMember = await db.query.member.findFirst({
		where: and(
			eq(member.organizationId, invite.organizationId),
			eq(member.userId, userId),
		),
	});

	if (existingMember) {
		await db.transaction(async (tx) => {
			const existingPersonalMembership = await tx.query.member.findFirst({
				where: and(eq(member.userId, userId), eq(member.role, "owner")),
				with: {
					organization: true,
				},
			});
			if (!existingPersonalMembership?.organization) {
				const personalOrganization = await tx
					.insert(organization)
					.values({
						name: "My Organization",
						ownerId: userId,
						createdAt: new Date(),
					})
					.returning()
					.then((res) => res[0]);
				if (personalOrganization) {
					await tx.insert(member).values({
						userId,
						organizationId: personalOrganization.id,
						role: "owner",
						createdAt: new Date(),
						isDefault: false,
					});
				}
			}
			await tx
				.update(invitation)
				.set({ status: "accepted" })
				.where(eq(invitation.id, token));
			await tx
				.update(user)
				.set({
					updatedAt: new Date(),
					...(providedFirstName ? { firstName: providedFirstName } : {}),
					...(alreadyRegistered ? { isRegistered: true } : {}),
				})
				.where(eq(user.id, userId));
		});
		return {
			organizationId: invite.organizationId,
			organizationSlug: invite.organizationSlug,
		};
	}

	const now = new Date();

	await db.transaction(async (tx) => {
		const existingPersonalMembership = await tx.query.member.findFirst({
			where: and(eq(member.userId, userId), eq(member.role, "owner")),
			with: {
				organization: true,
			},
		});
		if (!existingPersonalMembership?.organization) {
			const personalOrganization = await tx
				.insert(organization)
				.values({
					name: "My Organization",
					ownerId: userId,
					createdAt: now,
				})
				.returning()
				.then((res) => res[0]);

			if (personalOrganization) {
				await tx.insert(member).values({
					userId,
					organizationId: personalOrganization.id,
					role: "owner",
					createdAt: now,
					isDefault: false,
				});
			}
		}

		await tx.insert(member).values({
			organizationId: invite.organizationId,
			userId,
			role: invite.role || "member",
			createdAt: now,
			isDefault: true,
		});

		await tx
			.update(invitation)
			.set({ status: "accepted" })
			.where(eq(invitation.id, token));

		await tx
			.update(user)
			.set({
				updatedAt: now,
				...(providedFirstName ? { firstName: providedFirstName } : {}),
				...(alreadyRegistered ? { isRegistered: true } : {}),
			})
			.where(eq(user.id, userId));
	});

	return {
		organizationId: invite.organizationId,
		organizationSlug: invite.organizationSlug,
	};
}

export async function rejectPendingInvitationForUser(
	userId: string,
	token: string,
) {
	const invite = await getUserByToken(token);

	if (invite.isExpired) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Invitation has expired",
		});
	}

	if (invite.status !== "pending") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Invitation has already been used",
		});
	}

	const currentUser = await db.query.user.findFirst({
		where: eq(user.id, userId),
		columns: { email: true },
	});

	if (!currentUser) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "User not found",
		});
	}

	if (
		currentUser.email.trim().toLowerCase() !== invite.email.trim().toLowerCase()
	) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "Email does not match invitation",
		});
	}

	await db
		.update(invitation)
		.set({ status: "canceled" })
		.where(eq(invitation.id, token));

	return { success: true };
}

export const addNewProject = async (
	userId: string,
	projectId: string,
	organizationId: string,
) => {
	const userR = await findMemberById(userId, organizationId);

	await db
		.update(member)
		.set({
			accessedProjects: [...userR.accessedProjects, projectId],
		})
		.where(
			and(eq(member.id, userR.id), eq(member.organizationId, organizationId)),
		);
};

export const addNewEnvironment = async (
	userId: string,
	environmentId: string,
	organizationId: string,
) => {
	const userR = await findMemberById(userId, organizationId);

	await db
		.update(member)
		.set({
			accessedEnvironments: [...userR.accessedEnvironments, environmentId],
		})
		.where(
			and(eq(member.id, userR.id), eq(member.organizationId, organizationId)),
		);
};

export const addNewService = async (
	userId: string,
	serviceId: string,
	organizationId: string,
) => {
	const userR = await findMemberById(userId, organizationId);
	await db
		.update(member)
		.set({
			accessedServices: [...userR.accessedServices, serviceId],
		})
		.where(
			and(eq(member.id, userR.id), eq(member.organizationId, organizationId)),
		);
};

export const canPerformCreationService = async (
	userId: string,
	projectId: string,
	organizationId: string,
) => {
	const { accessedProjects, canCreateServices } = await findMemberById(
		userId,
		organizationId,
	);
	const haveAccessToProject = accessedProjects.includes(projectId);

	if (canCreateServices && haveAccessToProject) {
		return true;
	}

	return false;
};

export const canPerformAccessService = async (
	userId: string,
	serviceId: string,
	organizationId: string,
) => {
	const { accessedServices } = await findMemberById(userId, organizationId);
	const haveAccessToService = accessedServices.includes(serviceId);

	if (haveAccessToService) {
		return true;
	}

	return false;
};

export const canPerformDeleteService = async (
	userId: string,
	serviceId: string,
	organizationId: string,
) => {
	const { accessedServices, canDeleteServices } = await findMemberById(
		userId,
		organizationId,
	);
	const haveAccessToService = accessedServices.includes(serviceId);

	if (canDeleteServices && haveAccessToService) {
		return true;
	}

	return false;
};

export const canPerformCreationProject = async (
	userId: string,
	organizationId: string,
) => {
	const { canCreateProjects } = await findMemberById(userId, organizationId);

	if (canCreateProjects) {
		return true;
	}

	return false;
};

export const canPerformDeleteProject = async (
	userId: string,
	organizationId: string,
) => {
	const { canDeleteProjects } = await findMemberById(userId, organizationId);

	if (canDeleteProjects) {
		return true;
	}

	return false;
};

export const canPerformAccessProject = async (
	userId: string,
	projectId: string,
	organizationId: string,
) => {
	const { accessedProjects } = await findMemberById(userId, organizationId);

	const haveAccessToProject = accessedProjects.includes(projectId);

	if (haveAccessToProject) {
		return true;
	}
	return false;
};

export const canPerformAccessEnvironment = async (
	userId: string,
	environmentId: string,
	organizationId: string,
) => {
	const { accessedEnvironments } = await findMemberById(userId, organizationId);
	const haveAccessToEnvironment = accessedEnvironments.includes(environmentId);

	if (haveAccessToEnvironment) {
		return true;
	}

	return false;
};

export const canPerformDeleteEnvironment = async (
	userId: string,
	projectId: string,
	organizationId: string,
) => {
	const { accessedProjects, canDeleteEnvironments } = await findMemberById(
		userId,
		organizationId,
	);
	const haveAccessToProject = accessedProjects.includes(projectId);

	if (canDeleteEnvironments && haveAccessToProject) {
		return true;
	}

	return false;
};

export const canAccessToTraefikFiles = async (
	userId: string,
	organizationId: string,
) => {
	const { canAccessToTraefikFiles } = await findMemberById(
		userId,
		organizationId,
	);
	return canAccessToTraefikFiles;
};

export const checkServiceAccess = async (
	userId: string,
	serviceId: string,
	organizationId: string,
	action = "access" as "access" | "create" | "delete",
) => {
	let hasPermission = false;
	switch (action) {
		case "create":
			hasPermission = await canPerformCreationService(
				userId,
				serviceId,
				organizationId,
			);
			break;
		case "access":
			hasPermission = await canPerformAccessService(
				userId,
				serviceId,
				organizationId,
			);
			break;
		case "delete":
			hasPermission = await canPerformDeleteService(
				userId,
				serviceId,
				organizationId,
			);
			break;
		default:
			hasPermission = false;
	}
	if (!hasPermission) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "Permission denied",
		});
	}
};

export const checkEnvironmentAccess = async (
	userId: string,
	environmentId: string,
	organizationId: string,
	action = "access" as const,
) => {
	let hasPermission = false;
	switch (action) {
		case "access":
			hasPermission = await canPerformAccessEnvironment(
				userId,
				environmentId,
				organizationId,
			);
			break;
		default:
			hasPermission = false;
	}
	if (!hasPermission) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "Permission denied",
		});
	}
};

export const checkEnvironmentDeletionPermission = async (
	userId: string,
	projectId: string,
	organizationId: string,
) => {
	const member = await findMemberById(userId, organizationId);

	if (!member) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "User not found in organization",
		});
	}

	if (member.role === "owner" || member.role === "admin") {
		return true;
	}

	if (!member.canDeleteEnvironments) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You don't have permission to delete environments",
		});
	}

	const hasProjectAccess = member.accessedProjects.includes(projectId);
	if (!hasProjectAccess) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You don't have access to this project",
		});
	}

	return true;
};

export const checkProjectAccess = async (
	authId: string,
	action: "create" | "delete" | "access",
	organizationId: string,
	projectId?: string,
) => {
	let hasPermission = false;
	switch (action) {
		case "access":
			hasPermission = await canPerformAccessProject(
				authId,
				projectId as string,
				organizationId,
			);
			break;
		case "create":
			hasPermission = await canPerformCreationProject(authId, organizationId);
			break;
		case "delete":
			hasPermission = await canPerformDeleteProject(authId, organizationId);
			break;
		default:
			hasPermission = false;
	}
	if (!hasPermission) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "Permission denied",
		});
	}
};

export const checkEnvironmentCreationPermission = async (
	userId: string,
	projectId: string,
	organizationId: string,
) => {
	// Get user's member record
	const member = await findMemberById(userId, organizationId);

	if (!member) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "User not found in organization",
		});
	}

	// Owners and admins can always create environments
	if (member.role === "owner" || member.role === "admin") {
		return true;
	}

	// Check if user has canCreateEnvironments permission
	if (!member.canCreateEnvironments) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You don't have permission to create environments",
		});
	}

	// Check if user has access to the project
	const hasProjectAccess = member.accessedProjects.includes(projectId);
	if (!hasProjectAccess) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You don't have access to this project",
		});
	}

	return true;
};

export const findMemberById = async (
	userId: string,
	organizationId: string,
) => {
	const result = await db.query.member.findFirst({
		where: and(
			eq(member.userId, userId),
			eq(member.organizationId, organizationId),
		),
		with: {
			user: true,
		},
	});

	if (!result) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "Permission denied",
		});
	}
	return result;
};

export const createOrganizationUserWithCredentials = async ({
	organizationId,
	email,
	password,
	role,
}: {
	organizationId: string;
	email: string;
	password: string;
	role: string;
}) => {
	const normalizedEmail = email.trim().toLowerCase();
	const now = new Date();

	return await db.transaction(async (tx) => {
		const existingUser = await tx.query.user.findFirst({
			where: emailEquals(user.email, normalizedEmail),
			columns: {
				id: true,
			},
		});

		if (existingUser) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message:
					"This email already has an account. Use the invitation link flow for existing users.",
			});
		}

		const createdUser = await tx
			.insert(user)
			.values({
				email: normalizedEmail,
				emailVerified: false,
				updatedAt: now,
			})
			.returning({
				id: user.id,
				email: user.email,
			})
			.then((res) => res[0]);

		if (!createdUser) {
			throw new TRPCError({
				code: "INTERNAL_SERVER_ERROR",
				message: "Failed to create user",
			});
		}

		await tx.insert(account).values({
			userId: createdUser.id,
			providerId: "credential",
			password: bcrypt.hashSync(password, 10),
			createdAt: now,
			updatedAt: now,
		});

		await tx.insert(member).values({
			organizationId,
			userId: createdUser.id,
			role,
			createdAt: now,
			isDefault: true,
		});

		await tx
			.update(invitation)
			.set({
				status: "canceled",
			})
			.where(
				and(
					eq(invitation.organizationId, organizationId),
					emailEquals(invitation.email, normalizedEmail),
					eq(invitation.status, "pending"),
				),
			);

		return {
			userId: createdUser.id,
			email: createdUser.email,
			role,
		};
	});
};

export const updateUser = async (userId: string, userData: Partial<User>) => {
	// Validate email if it's being updated
	if (userData.email !== undefined) {
		if (!userData.email || userData.email.trim() === "") {
			throw new Error("Email is required and cannot be empty");
		}

		// Basic email format validation
		const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
		if (!emailRegex.test(userData.email)) {
			throw new Error("Please enter a valid email address");
		}
	}

	const userResult = await db
		.update(user)
		.set({
			...userData,
		})
		.where(eq(user.id, userId))
		.returning()
		.then((res) => res[0]);

	return userResult;
};

export const createApiKey = async (
	userId: string,
	input: {
		name: string;
		prefix?: string;
		expiresIn?: number;
		metadata: {
			organizationId: string;
		};
		rateLimitEnabled?: boolean;
		rateLimitTimeWindow?: number;
		rateLimitMax?: number;
		remaining?: number;
		refillAmount?: number;
		refillInterval?: number;
	},
) => {
	const result = await auth.createApiKey({
		body: {
			name: input.name,
			expiresIn: input.expiresIn,
			prefix: input.prefix,
			rateLimitEnabled: input.rateLimitEnabled,
			rateLimitTimeWindow: input.rateLimitTimeWindow,
			rateLimitMax: input.rateLimitMax,
			remaining: input.remaining,
			refillAmount: input.refillAmount,
			refillInterval: input.refillInterval,
			userId,
		},
	});

	if (input.metadata) {
		await db
			.update(apikey)
			.set({ metadata: JSON.stringify(input.metadata) })
			.where(eq(apikey.id, result.id));
	}

	return result;
};
