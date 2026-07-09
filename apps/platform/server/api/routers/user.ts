import {
	createApiKey,
	createOrganizationUserWithCredentials,
	createWebSocketTicket,
	ensureOrganizationSlug,
	findNotificationById,
	findOrganizationById,
	findUserById,
	getConsoleUrl,
	getUserByToken,
	getWebServerSettings,
	rejectPendingInvitationForUser,
	renderInvitationEmail,
	sendEmailNotification,
	sendInvitationEmail,
	sendResendNotification,
	sendWelcomeEmail,
	updateUser,
} from "@nearzero/server";
import { db } from "@nearzero/server/db";
import {
	account,
	apiAssignPermissions,
	apiFindOneToken,
	apikey,
	apiUpdateUser,
	invitation,
	member,
	organization,
	session,
	user,
} from "@nearzero/server/db/schema";
import { emailEquals } from "@nearzero/server/lib/email-identity";
import {
	hasPermission,
	resolvePermissions,
} from "@nearzero/server/services/permission";
import { hasValidLicense } from "@nearzero/server/services/license-key";
import { TRPCError } from "@trpc/server";
import * as bcrypt from "bcrypt";
import { and, asc, desc, eq, gt, ne } from "drizzle-orm";

type OnboardingMember = {
	role: string;
	isDefault?: boolean | null;
	createdAt?: Date | null;
	organization: {
		id?: string;
		name: string | null;
		slug: string | null;
	} | null;
};

function isPlaceholderPersonalOrg(name: string | null | undefined) {
	const trimmed = name?.trim() ?? "";
	return !trimmed || trimmed === "My Organization";
}

function pickInvitedMembership(memberships: OnboardingMember[]) {
	return (
		memberships.find(
			(m) =>
				m.role !== "owner" && !isPlaceholderPersonalOrg(m.organization?.name),
		) ?? null
	);
}

function pickPrimaryMembership(memberships: OnboardingMember[]) {
	const invited = pickInvitedMembership(memberships);
	if (invited) return invited;
	return memberships.find((m) => m.isDefault) ?? memberships[0] ?? null;
}

async function findInvitedMembershipForUser(userId: string) {
	const memberships = await db.query.member.findMany({
		where: eq(member.userId, userId),
		orderBy: [desc(member.isDefault), desc(member.createdAt)],
		columns: { role: true, organizationId: true },
		with: {
			organization: {
				columns: { id: true, name: true, slug: true },
			},
		},
	});
	return pickInvitedMembership(memberships);
}

import { nanoid } from "nanoid";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import {
	adminProcedure,
	createTRPCRouter,
	protectedProcedure,
	publicProcedure,
	withPermission,
} from "../trpc";

const INVITATION_TTL_MS = 60 * 60 * 1000;

const apiCreateApiKey = z.object({
	name: z.string().min(1),
	prefix: z.string().optional(),
	expiresIn: z.number().optional(),
	metadata: z.object({
		organizationId: z.string(),
	}),
	// Rate limiting
	rateLimitEnabled: z.boolean().optional(),
	rateLimitTimeWindow: z.number().optional(),
	rateLimitMax: z.number().optional(),
	// Request limiting
	remaining: z.number().optional(),
	refillAmount: z.number().optional(),
	refillInterval: z.number().optional(),
});

export const userRouter = createTRPCRouter({
	all: withPermission("member", "read").query(async ({ ctx }) => {
		return await db.query.member.findMany({
			where: eq(member.organizationId, ctx.session.activeOrganizationId),
			with: {
				user: true,
			},
			orderBy: [asc(member.createdAt)],
		});
	}),
	one: protectedProcedure
		.input(
			z.object({
				userId: z.string(),
			}),
		)
		.query(async ({ input, ctx }) => {
			const memberResult = await db.query.member.findFirst({
				where: and(
					eq(member.userId, input.userId),
					eq(member.organizationId, ctx.session?.activeOrganizationId || ""),
				),
				with: {
					user: true,
				},
			});

			// If user not found in the organization, deny access
			if (!memberResult) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "User not found in this organization",
				});
			}

			// Allow access if:
			// 1. User is requesting their own information
			// 2. User is owner/admin
			// 3. User has member.update permission (custom roles managing permissions)
			if (
				memberResult.userId !== ctx.user.id &&
				ctx.user.role !== "owner" &&
				ctx.user.role !== "admin"
			) {
				const canUpdate = await hasPermission(ctx, { member: ["update"] });
				if (!canUpdate) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to access this user",
					});
				}
			}

			return memberResult;
		}),
	session: publicProcedure.query(async ({ ctx }) => {
		if (!ctx.user || !ctx.session || !ctx.session.activeOrganizationId) {
			return null;
		}
		return {
			user: {
				id: ctx.user.id,
			},
			session: {
				activeOrganizationId: ctx.session.activeOrganizationId,
			},
		};
	}),
	get: protectedProcedure.query(async ({ ctx }) => {
		const memberResult = await db.query.member.findFirst({
			where: and(
				eq(member.userId, ctx.user.id),
				eq(member.organizationId, ctx.session?.activeOrganizationId || ""),
			),
			with: {
				user: {
					with: {
						apiKeys: true,
					},
				},
			},
		});

		return memberResult;
	}),
	getPermissions: protectedProcedure.query(async ({ ctx }) => {
		return resolvePermissions(ctx);
	}),
	haveRootAccess: protectedProcedure.query(async ({ ctx }) => {
		if (
			process.env.USER_ADMIN_ID === ctx.user.id ||
			ctx.session?.impersonatedBy === process.env.USER_ADMIN_ID
		) {
			return true;
		}
		return false;
	}),
	getBackups: adminProcedure.query(async ({ ctx }) => {
		const memberResult = await db.query.member.findFirst({
			where: and(
				eq(member.userId, ctx.user.id),
				eq(member.organizationId, ctx.session?.activeOrganizationId || ""),
			),
			with: {
				user: {
					with: {
						backups: {
							with: {
								destination: true,
								deployments: true,
							},
						},
						apiKeys: true,
					},
				},
			},
		});

		return memberResult?.user;
	}),
	getServerMetrics: withPermission("monitoring", "read").query(
		async ({ ctx }) => {
			const memberResult = await db.query.member.findFirst({
				where: and(
					eq(member.userId, ctx.user.id),
					eq(member.organizationId, ctx.session?.activeOrganizationId || ""),
				),
				with: {
					user: true,
				},
			});

			return memberResult?.user;
		},
	),
	update: protectedProcedure
		.input(apiUpdateUser)
		.mutation(async ({ input, ctx }) => {
			if (input.password || input.currentPassword) {
				const currentAuth = await db.query.account.findFirst({
					where: eq(account.userId, ctx.user.id),
				});
				const correctPassword = bcrypt.compareSync(
					input.currentPassword || "",
					currentAuth?.password || "",
				);

				if (!correctPassword) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Current password is incorrect",
					});
				}

				if (!input.password) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "New password is required",
					});
				}
				await db
					.update(account)
					.set({
						password: bcrypt.hashSync(input.password, 10),
					})
					.where(eq(account.userId, ctx.user.id));

				await db
					.delete(session)
					.where(
						and(
							eq(session.userId, ctx.user.id),
							ne(session.id, ctx.session.id),
						),
					);
			}

			try {
				const result = await updateUser(ctx.user.id, input);
				await audit(ctx, {
					action: "update",
					resourceType: "user",
					resourceId: ctx.user.id,
					resourceName: ctx.user.email,
				});
				return result;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						error instanceof Error ? error.message : "Failed to update user",
				});
			}
		}),
	getUserByToken: publicProcedure
		.input(apiFindOneToken)
		.query(async ({ input }) => {
			return await getUserByToken(input.token);
		}),
	getMetricsToken: withPermission("monitoring", "read").query(
		async ({ ctx }) => {
			const user = await findUserById(ctx.user.ownerId);
			const settings = await getWebServerSettings();
			return {
				serverIp: settings?.serverIp,
				enabledFeatures: user.enablePaidFeatures,
				metricsConfig: settings?.metricsConfig,
			};
		},
	),
	remove: protectedProcedure
		.input(
			z.object({
				userId: z.string(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			// Ensure the acting user has admin privileges in the active organization
			if (ctx.user.role !== "owner" && ctx.user.role !== "admin") {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Only owners or admins can remove members",
				});
			}

			// Fetch target member within the active organization
			const targetMember = await db.query.member.findFirst({
				where: and(
					eq(member.userId, input.userId),
					eq(member.organizationId, ctx.session?.activeOrganizationId || ""),
				),
			});

			if (!targetMember) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Target user is not a member of this organization",
				});
			}

			// Never allow removing the organization owner via this endpoint
			if (targetMember.role === "owner") {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "You cannot delete the organization owner",
				});
			}

			// Admin self-protection: an admin cannot remove themselves
			if (targetMember.role === "admin" && input.userId === ctx.user.id) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message:
						"Admins cannot remove themselves. Ask the owner or another admin.",
				});
			}

			// Only owners can remove admins
			// Admins can only remove members
			if (ctx.user.role === "admin" && targetMember.role === "admin") {
				throw new TRPCError({
					code: "FORBIDDEN",
					message:
						"Only the organization owner can remove admins. Admins can only remove members.",
				});
			}

			const result = await db
				.delete(member)
				.where(eq(member.id, targetMember.id));
			await audit(ctx, {
				action: "delete",
				resourceType: "organization",
				resourceId: targetMember.id,
				metadata: { type: "removeMember", userId: input.userId },
			});
			return result;
		}),
	assignPermissions: withPermission("member", "update")
		.input(apiAssignPermissions)
		.mutation(async ({ input, ctx }) => {
			try {
				const organization = await findOrganizationById(
					ctx.session?.activeOrganizationId || "",
				);

				if (organization?.ownerId !== ctx.user.ownerId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not allowed to assign permissions",
					});
				}

				const { id, accessedGitProviders, accessedServers, ...rest } = input;

				const licensed = await hasValidLicense(
					ctx.session?.activeOrganizationId || "",
				);

				await db
					.update(member)
					.set({
						...rest,
						...(licensed && accessedGitProviders !== undefined
							? { accessedGitProviders }
							: {}),
						...(licensed && accessedServers !== undefined
							? { accessedServers }
							: {}),
					})
					.where(
						and(
							eq(member.userId, input.id),
							eq(
								member.organizationId,
								ctx.session?.activeOrganizationId || "",
							),
						),
					);
				await audit(ctx, {
					action: "update",
					resourceType: "user",
					resourceId: input.id,
					metadata: { permissions: rest },
				});
			} catch (error) {
				throw error;
			}
		}),
	getInvitations: protectedProcedure.query(async ({ ctx }) => {
		return await db.query.invitation.findMany({
			where: and(
				emailEquals(invitation.email, ctx.user.email),
				gt(invitation.expiresAt, new Date()),
				eq(invitation.status, "pending"),
			),
			with: {
				organization: true,
			},
		});
	}),

	getContainerMetrics: withPermission("monitoring", "read")
		.input(
			z.object({
				url: z.string(),
				token: z.string(),
				appName: z.string(),
				dataPoints: z.string(),
			}),
		)
		.query(async ({ input }) => {
			try {
				if (!input.appName) {
					throw new Error(
						[
							"No Application Selected:",
							"",
							"Make Sure to select an application to monitor.",
						].join("\n"),
					);
				}
				const url = new URL(`${input.url}/metrics/containers`);
				url.searchParams.append("limit", input.dataPoints);
				url.searchParams.append("appName", input.appName);
				const response = await fetch(url.toString(), {
					headers: {
						Authorization: `Bearer ${input.token}`,
					},
				});
				if (!response.ok) {
					throw new Error(
						`Error ${response.status}: ${response.statusText}. Please verify that the application "${input.appName}" is running and this service is included in the monitoring configuration.`,
					);
				}

				const data = await response.json();
				if (!Array.isArray(data) || data.length === 0) {
					throw new Error(
						[
							`No monitoring data available for "${input.appName}". This could be because:`,
							"",
							"1. The container was recently started - wait a few minutes for data to be collected",
							"2. The container is not running - verify its status",
							"3. The service is not included in your monitoring configuration",
						].join("\n"),
					);
				}
				return data as {
					containerId: string;
					containerName: string;
					containerImage: string;
					containerLabels: string;
					containerCommand: string;
					containerCreated: string;
				}[];
			} catch (error) {
				throw error;
			}
		}),

	generateToken: protectedProcedure.mutation(async () => {
		return "token";
	}),

	/**
	 * Mint a short-lived ticket for authenticating browser WebSocket
	 * connections (terminals, logs, stats). Called over the authenticated
	 * same-origin proxy so the session cookie is always present here; the
	 * returned token is then passed as a `wsToken` query param when the console
	 * and API run on different hostnames and the cookie is not sent on the
	 * cross-subdomain WebSocket handshake.
	 */
	createWsTicket: protectedProcedure.mutation(async ({ ctx }) => {
		return createWebSocketTicket({
			userId: ctx.user.id,
			organizationId: ctx.session.activeOrganizationId,
		});
	}),

	deleteApiKey: protectedProcedure
		.input(
			z.object({
				apiKeyId: z.string(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			try {
				const apiKeyToDelete = await db.query.apikey.findFirst({
					where: eq(apikey.id, input.apiKeyId),
				});

				if (!apiKeyToDelete) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "API key not found",
					});
				}

				if (apiKeyToDelete.referenceId !== ctx.user.id) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to delete this API key",
					});
				}

				await db.delete(apikey).where(eq(apikey.id, input.apiKeyId));
				await audit(ctx, {
					action: "delete",
					resourceType: "user",
					resourceId: input.apiKeyId,
					resourceName: apiKeyToDelete.name || undefined,
				});
				return true;
			} catch (error) {
				throw error;
			}
		}),

	createApiKey: protectedProcedure
		.input(apiCreateApiKey)
		.mutation(async ({ input, ctx }) => {
			// Verify user is a member of the organization specified in metadata
			if (input.metadata?.organizationId) {
				const userMember = await db.query.member.findFirst({
					where: and(
						eq(member.organizationId, input.metadata.organizationId),
						eq(member.userId, ctx.user.id),
					),
				});

				if (!userMember) {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "You are not a member of this organization",
					});
				}
			}

			const apiKey = await createApiKey(ctx.user.id, input);
			await audit(ctx, {
				action: "create",
				resourceType: "user",
				resourceId: apiKey.id,
				resourceName: input.name,
			});
			return apiKey;
		}),

	checkUserOrganizations: protectedProcedure
		.input(
			z.object({
				userId: z.string(),
			}),
		)
		.query(async ({ input, ctx }) => {
			// Users can check their own organizations
			// Admins and owners can check organizations of members in their active organization
			if (input.userId !== ctx.user.id) {
				// Verify the target user is a member of the active organization
				const targetMember = await db.query.member.findFirst({
					where: and(
						eq(member.userId, input.userId),
						eq(member.organizationId, ctx.session?.activeOrganizationId || ""),
					),
				});

				if (!targetMember) {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "User is not a member of your active organization",
					});
				}

				// Only admins and owners can check other users' organizations
				if (ctx.user.role !== "owner" && ctx.user.role !== "admin") {
					throw new TRPCError({
						code: "FORBIDDEN",
						message:
							"Only admins and owners can check other users' organizations",
					});
				}
			}

			const organizations = await db.query.member.findMany({
				where: eq(member.userId, input.userId),
			});

			return organizations.length;
		}),
	createUserWithCredentials: withPermission("member", "create")
		.input(
			z.object({
				email: z.string().email(),
				password: z.string().min(8),
				role: z.string().min(1),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			if (!ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Active organization is required",
				});
			}

			if (input.role === "owner") {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Cannot create a user with the owner role",
				});
			}

			return await createOrganizationUserWithCredentials({
				organizationId: ctx.session.activeOrganizationId,
				email: input.email,
				password: input.password,
				role: input.role,
			});
		}),
	sendInvitation: withPermission("member", "create")
		.input(
			z.object({
				invitationId: z.string().min(1),
				notificationId: z.string().min(1),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const notification = await findNotificationById(input.notificationId);

			const email = notification.email;
			const resend = notification.resend;

			const currentInvitation = await db.query.invitation.findFirst({
				where: eq(invitation.id, input.invitationId),
			});

			if (!email && !resend) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Email provider not found",
				});
			}

			const host = await getConsoleUrl();
			const inviteLink = `${host}/invitation?token=${encodeURIComponent(input.invitationId)}`;

			const organization = await findOrganizationById(
				ctx.session.activeOrganizationId,
			);

			try {
				const toEmail = currentInvitation?.email || "";
				const orgName = organization?.name || "organization";
				const subject = `You've been invited to join ${orgName} on Nearzero`;
				const html = await renderInvitationEmail({
					email: toEmail,
					inviteLink,
					organizationName: orgName,
				});

				if (email) {
					await sendEmailNotification(
						{ ...email, toAddresses: [toEmail] },
						subject,
						html,
					);
				} else if (resend) {
					await sendResendNotification(
						{ ...resend, toAddresses: [toEmail] },
						subject,
						html,
					);
				}
			} catch (error) {
				console.log(error);
				throw error;
			}
			await audit(ctx, {
				action: "create",
				resourceType: "user",
				resourceId: input.invitationId,
				resourceName: currentInvitation?.email || "",
				metadata: { type: "sendInvitation" },
			});
			return inviteLink;
		}),

	getBookmarkedTemplates: protectedProcedure.query(async ({ ctx }) => {
		const result = await db.query.user.findFirst({
			where: eq(user.id, ctx.user.id),
			columns: { bookmarkedTemplates: true },
		});

		return result?.bookmarkedTemplates ?? [];
	}),

	toggleTemplateBookmark: protectedProcedure
		.input(
			z.object({
				templateId: z.string().min(1),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const result = await db.query.user.findFirst({
				where: eq(user.id, ctx.user.id),
				columns: { bookmarkedTemplates: true },
			});

			const current = result?.bookmarkedTemplates ?? [];
			const isBookmarked = current.includes(input.templateId);

			const updated = isBookmarked
				? current.filter((id) => id !== input.templateId)
				: [...current, input.templateId];

			await db
				.update(user)
				.set({ bookmarkedTemplates: updated })
				.where(eq(user.id, ctx.user.id));

			return { isBookmarked: !isBookmarked };
		}),

	onboardingStatus: protectedProcedure.query(async ({ ctx }) => {
		const row = await db.query.user.findFirst({
			where: eq(user.id, ctx.user.id),
			columns: { isRegistered: true, firstName: true },
		});

		const memberships = await db.query.member.findMany({
			where: eq(member.userId, ctx.user.id),
			orderBy: [desc(member.isDefault), desc(member.createdAt)],
			columns: {
				id: true,
				role: true,
				organizationId: true,
				isDefault: true,
				createdAt: true,
			},
			with: {
				organization: {
					columns: { name: true, slug: true },
				},
			},
		});

		const invitedMembership = pickInvitedMembership(memberships);
		const membership = pickPrimaryMembership(memberships);

		let organizationName =
			invitedMembership?.organization?.name?.trim() ??
			membership?.organization?.name?.trim() ??
			"";
		if (!organizationName && ctx.session.activeOrganizationId) {
			const org = await db.query.organization.findFirst({
				where: eq(organization.id, ctx.session.activeOrganizationId),
				columns: { name: true },
			});
			organizationName = org?.name?.trim() ?? "";
		}

		const firstName = row?.firstName?.trim() ?? "";
		const profileComplete = Boolean(
			firstName && organizationName && organizationName !== "My Organization",
		);

		const pendingInvitation = await db.query.invitation.findFirst({
			where: and(
				emailEquals(invitation.email, ctx.user.email),
				eq(invitation.status, "pending"),
				gt(invitation.expiresAt, new Date()),
			),
			columns: { id: true },
		});

		const hasMembership = memberships.length > 0;
		const needsWorkspaceSetup = !hasMembership && !pendingInvitation;

		const joinedExistingOrg = Boolean(invitedMembership);

		const inviteMemberProfileComplete = Boolean(firstName);

		// Signup and invitation flows can create memberships before profile details exist.
		// Treat onboarding as complete only when the stored completion flag and the
		// required details for that flow are both present.
		const storedRegistrationComplete = Boolean(row?.isRegistered);
		const complete =
			storedRegistrationComplete &&
			(joinedExistingOrg ? inviteMemberProfileComplete : profileComplete);

		return {
			complete,
			profileComplete,
			firstName,
			organizationName,
			pendingInvitationId: pendingInvitation?.id ?? null,
			needsWorkspaceSetup,
			needsInviteMemberSetup: joinedExistingOrg && !complete,
			inviteMemberProfileComplete,
			organizationSlug:
				invitedMembership?.organization?.slug ??
				membership?.organization?.slug ??
				null,
		};
	}),

	saveInviteMemberProfile: protectedProcedure
		.input(z.object({ firstName: z.string().trim().min(1) }))
		.mutation(async ({ input, ctx }) => {
			const membership = await findInvitedMembershipForUser(ctx.user.id);
			if (!membership) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invite member profile is only for joined workspaces",
				});
			}

			await updateUser(ctx.user.id, {
				firstName: input.firstName.trim(),
			});

			return { success: true };
		}),

	completeInviteMemberOnboarding: protectedProcedure
		.input(
			z.object({
				heardAbout: z.string().min(1),
				role: z.string().min(1),
				needsOnPrem: z.string().optional(),
				monthlyCallVolume: z.string().optional(),
				migratingFromProvider: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const membership = await findInvitedMembershipForUser(ctx.user.id);

			if (!membership) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invite member onboarding is only for joined workspaces",
				});
			}

			const org = membership.organization;
			if (
				!org?.id ||
				!org.name?.trim() ||
				org.name.trim() === "My Organization"
			) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Joined workspace is required",
				});
			}

			const userRow = await db.query.user.findFirst({
				where: eq(user.id, ctx.user.id),
				columns: { firstName: true },
			});
			const firstName = userRow?.firstName?.trim() ?? "";
			if (!firstName) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Your name is required",
				});
			}

			await updateUser(ctx.user.id, {
				firstName,
				isRegistered: true,
			});

			const organizationSlug =
				org.slug ||
				(await ensureOrganizationSlug(org.name.trim(), org.id, org.slug));

			if (!org.slug && organizationSlug) {
				await db
					.update(organization)
					.set({ slug: organizationSlug })
					.where(eq(organization.id, org.id));
			}

			const consoleUrl = await getConsoleUrl();
			const dashboardLink = `${consoleUrl}/${organizationSlug}/dashboard/agent`;

			try {
				await sendWelcomeEmail({
					email: ctx.user.email,
					firstName,
					organizationName: org.name.trim(),
					dashboardLink,
				});
			} catch (err) {
				console.error("Failed to send welcome email:", err);
			}

			return {
				success: true,
				organizationSlug,
				heardAbout: input.heardAbout,
				role: input.role,
				needsOnPrem: input.needsOnPrem,
				monthlyCallVolume: input.monthlyCallVolume,
				migratingFromProvider: input.migratingFromProvider,
			};
		}),

	setupPersonalWorkspace: protectedProcedure
		.input(
			z.object({
				firstName: z.string().trim().min(1),
				workspaceName: z.string().trim().min(1),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const memberRecord = await db.query.member.findFirst({
				where: eq(member.userId, ctx.user.id),
				columns: { id: true },
			});
			if (memberRecord) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Workspace already exists",
				});
			}

			const pendingInvitation = await db.query.invitation.findFirst({
				where: and(
					emailEquals(invitation.email, ctx.user.email),
					eq(invitation.status, "pending"),
					gt(invitation.expiresAt, new Date()),
				),
				columns: { id: true },
			});
			if (pendingInvitation) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Accept or decline your pending invitation first",
				});
			}

			const createdOrg = await db
				.insert(organization)
				.values({
					name: input.workspaceName.trim(),
					ownerId: ctx.user.id,
					createdAt: new Date(),
				})
				.returning()
				.then((res) => res[0]);

			if (!createdOrg) {
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: "Failed to create workspace",
				});
			}

			const organizationSlug = await ensureOrganizationSlug(
				input.workspaceName.trim(),
				createdOrg.id,
				createdOrg.slug,
			);

			await db
				.update(organization)
				.set({ slug: organizationSlug })
				.where(eq(organization.id, createdOrg.id));

			await db.insert(member).values({
				userId: ctx.user.id,
				organizationId: createdOrg.id,
				role: "owner",
				createdAt: new Date(),
				isDefault: true,
			});

			const firstName = input.firstName.trim();
			await updateUser(ctx.user.id, {
				firstName,
				isRegistered: true,
			});

			const consoleUrl = await getConsoleUrl();
			const dashboardLink = `${consoleUrl}/${organizationSlug}/dashboard/agent`;

			try {
				await sendWelcomeEmail({
					email: ctx.user.email,
					firstName,
					organizationName: input.workspaceName.trim(),
					dashboardLink,
				});
			} catch (err) {
				console.error("Failed to send welcome email:", err);
			}

			return { success: true, organizationSlug };
		}),

	rejectInvitation: protectedProcedure
		.input(z.object({ token: z.string().min(1) }))
		.mutation(async ({ input, ctx }) => {
			return await rejectPendingInvitationForUser(ctx.user.id, input.token);
		}),

	saveOnboardingProfile: protectedProcedure
		.input(
			z.object({
				firstName: z.string().trim().min(1),
				workspaceName: z.string().trim().min(1),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const orgId = ctx.session.activeOrganizationId;
			if (!orgId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Active organization is required",
				});
			}

			const org = await db.query.organization.findFirst({
				where: eq(organization.id, orgId),
			});
			if (!org) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Organization not found",
				});
			}

			await db
				.update(organization)
				.set({
					name: input.workspaceName.trim(),
					slug: await ensureOrganizationSlug(
						input.workspaceName.trim(),
						orgId,
						org.slug,
					),
				})
				.where(eq(organization.id, orgId));

			await updateUser(ctx.user.id, {
				firstName: input.firstName.trim(),
			});

			return { success: true };
		}),

	completeOnboarding: protectedProcedure
		.input(
			z.object({
				heardAbout: z.string().min(1),
				role: z.string().min(1),
				needsOnPrem: z.string().optional(),
				monthlyCallVolume: z.string().optional(),
				migratingFromProvider: z.string().optional(),
				workspaceMode: z.enum(["organization", "solo"]),
				organizationName: z.string().optional(),
				firstName: z.string().optional(),
				workspaceName: z.string().optional(),
				inviteEmails: z.array(z.string().email()).max(10).optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const orgId = ctx.session.activeOrganizationId;
			if (!orgId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Active organization is required",
				});
			}

			const org = await db.query.organization.findFirst({
				where: eq(organization.id, orgId),
			});
			if (!org) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Organization not found",
				});
			}

			let displayName = "";
			let orgName = org.name;

			if (input.workspaceMode === "organization") {
				const name = String(input.organizationName || "").trim();
				if (!name) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Organization name is required",
					});
				}
				orgName = name;
				displayName =
					name.split(/\s+/)[0] || ctx.user.email.split("@")[0] || "User";
			} else {
				const first = String(input.firstName || "").trim();
				const workspace = String(input.workspaceName || "").trim();
				if (!first) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Your name is required",
					});
				}
				if (!workspace) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Workspace name is required",
					});
				}
				displayName = first;
				orgName = workspace;
			}

			const organizationSlug = await ensureOrganizationSlug(
				orgName,
				orgId,
				org.slug,
			);

			await db
				.update(organization)
				.set({
					name: orgName,
					slug: organizationSlug,
				})
				.where(eq(organization.id, orgId));

			await updateUser(ctx.user.id, {
				firstName: displayName,
				isRegistered: true,
			});

			const consoleUrl = await getConsoleUrl();
			const dashboardLink = `${consoleUrl}/${organizationSlug}/dashboard/agent`;

			try {
				await sendWelcomeEmail({
					email: ctx.user.email,
					firstName: displayName,
					organizationName: orgName,
					dashboardLink,
				});
			} catch (err) {
				console.error("Failed to send welcome email:", err);
			}

			const inviteEmails = (input.inviteEmails ?? [])
				.map((e) => e.trim().toLowerCase())
				.filter(Boolean);

			for (const email of inviteEmails) {
				if (email === ctx.user.email.toLowerCase()) continue;

				const existingUser = await db.query.user.findFirst({
					where: emailEquals(user.email, email),
				});
				if (existingUser) {
					const existingMember = await db.query.member.findFirst({
						where: and(
							eq(member.organizationId, orgId),
							eq(member.userId, existingUser.id),
						),
					});
					if (existingMember) continue;
				}

				const existingInvitation = await db.query.invitation.findFirst({
					where: and(
						eq(invitation.organizationId, orgId),
						emailEquals(invitation.email, email),
						eq(invitation.status, "pending"),
						gt(invitation.expiresAt, new Date()),
					),
				});
				if (existingInvitation) continue;

				const [created] = await db
					.insert(invitation)
					.values({
						id: nanoid(),
						organizationId: orgId,
						email,
						role: "member",
						status: "pending",
						expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
						inviterId: ctx.user.id,
					})
					.returning();

				if (created) {
					const host = await getConsoleUrl();
					const inviteLink = `${host}/invitation?token=${encodeURIComponent(created.id)}`;
					try {
						await sendInvitationEmail({
							email,
							inviteLink,
							organizationName: orgName,
						});
					} catch (err) {
						console.error(
							`Failed to send onboarding invitation email to ${email}:`,
							err,
						);
					}
				}
			}

			await audit(ctx, {
				action: "update",
				resourceType: "user",
				resourceId: ctx.user.id,
				resourceName: ctx.user.email,
				metadata: {
					type: "completeOnboarding",
					heardAbout: input.heardAbout,
					role: input.role,
					needsOnPrem: input.needsOnPrem,
					monthlyCallVolume: input.monthlyCallVolume,
					migratingFromProvider: input.migratingFromProvider,
					workspaceMode: input.workspaceMode,
				},
			});

			return { success: true, organizationSlug };
		}),
});
