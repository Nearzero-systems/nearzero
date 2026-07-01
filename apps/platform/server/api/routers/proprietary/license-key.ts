import { db } from "@nearzero/server/db";
import { user } from "@nearzero/server/db/schema";
import { hasValidLicense, validateLicenseKey } from "@nearzero/server/index";
import {
	EDITION_FEATURES,
	isEditionFeatureEnabled,
} from "@nearzero/server/services/edition-policy";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
	adminProcedure,
	createTRPCRouter,
	protectedProcedure,
} from "@/server/api/trpc";
import {
	activateLicenseKey,
	deactivateLicenseKey,
} from "@/server/utils/enterprise";

export const licenseKeyRouter = createTRPCRouter({
	activate: adminProcedure
		.input(z.object({ licenseKey: z.string().min(1) }))
		.mutation(async ({ input, ctx }) => {
			try {
				if (!isEditionFeatureEnabled(EDITION_FEATURES.managedSupport)) {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "Enterprise licensing is not available in Community mode",
					});
				}

				const currentUserId = ctx.user.id;
				const currentUser = await db.query.user.findFirst({
					where: eq(user.id, currentUserId),
				});
				if (!currentUser) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "User not found",
					});
				}

				if (ctx.user.role !== "owner") {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "You are not authorized to activate a license key",
					});
				}

				await activateLicenseKey(input.licenseKey);
				await db
					.update(user)
					.set({
						enableEnterpriseFeatures: true,
						licenseKey: input.licenseKey,
						isValidEnterpriseLicense: true,
					})
					.where(eq(user.id, currentUserId));
				return { success: true };
			} catch (error) {
				if (error instanceof TRPCError) throw error;
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message:
						error instanceof Error
							? error.message
							: "Failed to activate license key",
					cause: error,
				});
			}
		}),
	validate: adminProcedure.mutation(async ({ ctx }) => {
		try {
			if (!isEditionFeatureEnabled(EDITION_FEATURES.managedSupport)) {
				return false;
			}

			const currentUserId = ctx.user.id;
			const currentUser = await db.query.user.findFirst({
				where: eq(user.id, currentUserId),
			});
			if (!currentUser) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "User not found",
				});
			}

			if (ctx.user.role !== "owner") {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "You are not authorized to validate a license key",
				});
			}

			if (!currentUser.licenseKey) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "No license key found",
				});
			}

			const valid = await validateLicenseKey(currentUser.licenseKey);
			if (valid) {
				await db
					.update(user)
					.set({ isValidEnterpriseLicense: true })
					.where(eq(user.id, currentUserId));
			}
			return valid;
		} catch (error) {
			if (error instanceof TRPCError) throw error;
			throw new TRPCError({
				code: "INTERNAL_SERVER_ERROR",
				message:
					error instanceof Error
						? error.message
						: "Failed to validate license key",
			});
		}
	}),
	deactivate: adminProcedure.mutation(async ({ ctx }) => {
		try {
			const currentUserId = ctx.user.id;
			const currentUser = await db.query.user.findFirst({
				where: eq(user.id, currentUserId),
			});
			if (!currentUser) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "User not found",
				});
			}
			if (!currentUser.licenseKey) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "No license key found",
				});
			}

			if (ctx.user.role !== "owner") {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "You are not authorized to deactivate a license key",
				});
			}

			try {
				await deactivateLicenseKey(currentUser.licenseKey);
			} catch (err) {
				console.error("Failed to deactivate license key remotely:", err);
			}

			await db
				.update(user)
				.set({
					licenseKey: null,
					isValidEnterpriseLicense: false,
				})
				.where(eq(user.id, currentUserId));
			return { success: true };
		} catch (error) {
			if (error instanceof TRPCError) throw error;
			throw new TRPCError({
				code: "INTERNAL_SERVER_ERROR",
				message:
					error instanceof Error
						? error.message
						: "Failed to deactivate license key",
			});
		}
	}),
	getEnterpriseSettings: adminProcedure.query(async ({ ctx }) => {
		const currentUserId = ctx.user.id;
		const currentUser = await db.query.user.findFirst({
			where: eq(user.id, currentUserId),
		});

		if (!currentUser) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "User not found",
			});
		}

		if (ctx.user.role !== "owner") {
			throw new TRPCError({
				code: "FORBIDDEN",
				message: "You are not authorized to get enterprise settings",
			});
		}

		return {
			enableEnterpriseFeatures: !!currentUser.enableEnterpriseFeatures,
			licenseKey: currentUser.licenseKey ?? "",
		};
	}),
	haveValidLicenseKey: protectedProcedure.query(async ({ ctx }) => {
		return await hasValidLicense(ctx.session.activeOrganizationId);
	}),
	updateEnterpriseSettings: adminProcedure
		.input(
			z.object({
				enableEnterpriseFeatures: z.boolean().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			try {
				if (!isEditionFeatureEnabled(EDITION_FEATURES.managedSupport)) {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "Enterprise licensing is not available in Community mode",
					});
				}

				const currentUserId = ctx.user.id;

				if (input.enableEnterpriseFeatures === undefined) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "enableEnterpriseFeatures must be provided",
					});
				}

				if (ctx.user.role !== "owner") {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "You are not authorized to update enterprise settings",
					});
				}

				await db
					.update(user)
					.set({
						enableEnterpriseFeatures: input.enableEnterpriseFeatures,
						isValidEnterpriseLicense: input.enableEnterpriseFeatures,
					})
					.where(eq(user.id, currentUserId));

				return true;
			} catch (error) {
				if (error instanceof TRPCError) throw error;
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message:
						error instanceof Error
							? error.message
							: "Failed to update enterprise settings",
				});
			}
		}),
});
