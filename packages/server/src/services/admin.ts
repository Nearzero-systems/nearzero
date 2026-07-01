import { db } from "@nearzero/server/db";
import {
	invitation,
	member,
	organization,
	user,
} from "@nearzero/server/db/schema";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { emailEquals } from "../lib/email-identity";
import { resolveConsoleUrl } from "../lib/public-url";
import { getWebServerSettings } from "./web-server-settings";

export const findUserById = async (userId: string) => {
	const userResult = await db.query.user.findFirst({
		where: eq(user.id, userId),
		// with: {
		// 	account: true,
		// },
	});
	if (!userResult) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "User not found",
		});
	}
	return userResult;
};

export const findOrganizationById = async (organizationId: string) => {
	const organizationResult = await db.query.organization.findFirst({
		where: eq(organization.id, organizationId),
		with: {
			owner: true,
		},
	});
	return organizationResult;
};

export const isAdminPresent = async () => {
	const admin = await db.query.member.findFirst({
		where: eq(member.role, "owner"),
	});

	if (!admin) {
		return false;
	}
	return true;
};

export const findOwner = async () => {
	const admin = await db.query.member.findFirst({
		where: eq(member.role, "owner"),
		with: {
			user: true,
		},
	});

	if (!admin) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Admin not found",
		});
	}
	return admin;
};

export const getUserByToken = async (token: string) => {
	const userResult = await db.query.invitation.findFirst({
		where: eq(invitation.id, token),
		columns: {
			id: true,
			email: true,
			status: true,
			expiresAt: true,
			role: true,
			inviterId: true,
			organizationId: true,
		},
		with: {
			organization: {
				columns: {
					id: true,
					name: true,
					slug: true,
					logo: true,
				},
			},
		},
	});

	if (!userResult) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Invitation not found",
		});
	}

	const inviter = userResult.inviterId
		? await db.query.user.findFirst({
				where: eq(user.id, userResult.inviterId),
				columns: { firstName: true, email: true },
			})
		: null;

	const userAlreadyExists = await db.query.user.findFirst({
		where: emailEquals(user.email, userResult.email),
	});

	const { expiresAt, organization, ...rest } = userResult;
	const inviterName =
		inviter?.firstName?.trim() ||
		inviter?.email?.split("@")[0] ||
		"A teammate";

	return {
		...rest,
		isExpired: userResult.expiresAt < new Date(),
		userAlreadyExists: !!userAlreadyExists,
		organizationId: userResult.organizationId,
		organizationName: organization?.name ?? "",
		organizationSlug: organization?.slug ?? "",
		organizationLogo: organization?.logo ?? null,
		inviterName,
		inviterEmail: inviter?.email ?? "",
	};
};

export const removeUserById = async (userId: string) => {
	await db
		.delete(user)
		.where(eq(user.id, userId))
		.returning()
		.then((res) => res[0]);
};

export const getNearzeroUrl = async () => {
	const settings = await getWebServerSettings();

	if (settings?.host) {
		const protocol = settings?.https ? "https" : "http";
		return `${protocol}://${settings?.host}`;
	}
	return `http://${settings?.serverIp || "127.0.0.1"}:${process.env.PORT || "3000"}`;
};

export const getConsoleUrl = async () => {
	return resolveConsoleUrl();
};

const TRUSTED_ORIGINS_CACHE_TTL_MS = 30 * 60_000;
let trustedOriginsCache: { data: string[]; expiresAt: number } | null = null;

export const getTrustedOrigins = async () => {
	const runQuery = async () => {
		const rows = await db
			.select({ trustedOrigins: user.trustedOrigins })
			.from(member)
			.innerJoin(user, eq(member.userId, user.id))
			.where(eq(member.role, "owner"));
		return Array.from(new Set(rows.flatMap((r) => r.trustedOrigins ?? [])));
	};

	const now = Date.now();
	if (trustedOriginsCache && now < trustedOriginsCache.expiresAt) {
		return trustedOriginsCache.data;
	}
	try {
		const trustedOrigins = await runQuery();
		trustedOriginsCache = {
			data: trustedOrigins,
			expiresAt: now + TRUSTED_ORIGINS_CACHE_TTL_MS,
		};
		return trustedOrigins;
	} catch (error) {
		console.error("Failed to fetch trusted origins:", error);
		return trustedOriginsCache?.data ?? [];
	}
};

export const getTrustedProviders = async () => {
	try {
		const providers = await db.query.ssoProvider.findMany();
		return providers.map((provider) => provider.providerId);
	} catch (error) {
		return [];
	}
};
