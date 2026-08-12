import type { IncomingMessage } from "node:http";
import { apiKey } from "@better-auth/api-key";
import { sso } from "@better-auth/sso";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { admin, organization, twoFactor } from "better-auth/plugins";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import * as schema from "../db/schema";
import {
	getTrustedOrigins,
	getTrustedProviders,
	getUserByToken,
} from "../services/admin";
import { createAuditLog } from "../services/audit-log";
import {
	adoptConfiguredManagedDnsZone,
	ensureFirstOwnerServerIp,
} from "../services/install-domain-bootstrap";
import {
	getSetupAdminEmail,
	markInstallSetupClaimed,
} from "../services/install-setup";
import { getWebServerSettings } from "../services/web-server-settings";
import { getPublicIpWithFallback } from "../wss/utils";
import { ac, adminRole, memberRole, ownerRole } from "./access-control";
import {
	getAuthEmailPolicyError,
	normalizeAuthEmail,
} from "./auth-email-policy";
import { getAuthOtpAccountError } from "./auth-otp-intent";
import { betterAuthSecret } from "./auth-secret";
import { emailEquals } from "./email-identity";
import {
	resolveAuthPublicBaseUrl,
	resolveSharedCookieDomain,
} from "./public-url";
import {
	buildPublicRegistrationStatus,
	decideRegistration,
	mergeRegistrationPolicyAdminEmail,
	type RegistrationPolicy,
	registrationDecisionMessage,
	resolveRegistrationPolicy,
} from "./registration-policy";
import {
	appendRequestOrigin,
	buildHostPortOrigins,
	resolveConsoleAndPlatformPorts,
	resolveEnvTrustedOrigins,
} from "./resolve-trusted-origins";
import { verifyWebSocketTicket } from "./ws-ticket";

async function ensurePersonalOrganizationForUser(
	userId: string,
	tx: typeof db = db,
) {
	const existingPersonalMembership = await tx.query.member.findFirst({
		where: and(
			eq(schema.member.userId, userId),
			eq(schema.member.role, "owner"),
		),
		with: {
			organization: true,
		},
	});
	if (existingPersonalMembership?.organization) {
		return existingPersonalMembership.organization;
	}

	const personalOrganization = await tx
		.insert(schema.organization)
		.values({
			name: "My Organization",
			ownerId: userId,
			createdAt: new Date(),
		})
		.returning()
		.then((res) => res[0]);

	if (personalOrganization) {
		await tx.insert(schema.member).values({
			userId,
			organizationId: personalOrganization.id,
			role: "owner",
			createdAt: new Date(),
			isDefault: false,
		});
	}

	return personalOrganization;
}

const AUTH_EMAIL_PATHS = new Set(["/sign-in/email", "/sign-up/email"]);
const baseRegistrationPolicy = resolveRegistrationPolicy();

async function getEffectiveRegistrationPolicy(): Promise<RegistrationPolicy> {
	const setupAdminEmail = await getSetupAdminEmail();
	return mergeRegistrationPolicyAdminEmail(
		baseRegistrationPolicy,
		setupAdminEmail,
	);
}

async function isBootstrapRegistrationClaimed() {
	const policy = await getEffectiveRegistrationPolicy();
	if (policy.mode !== "bootstrap" || !policy.adminEmail) {
		return false;
	}
	const configuredAdmin = await db.query.user.findFirst({
		where: emailEquals(schema.user.email, policy.adminEmail),
		columns: { id: true },
	});
	return Boolean(configuredAdmin);
}

export async function getPublicRegistrationStatus() {
	return buildPublicRegistrationStatus(
		await getEffectiveRegistrationPolicy(),
		await isBootstrapRegistrationClaimed(),
	);
}

async function findAndNormalizeAuthUser(rawEmail: string) {
	const normalizedEmail = normalizeAuthEmail(rawEmail);
	const matches = await db.query.user.findMany({
		where: emailEquals(schema.user.email, normalizedEmail),
		columns: {
			id: true,
			email: true,
		},
		limit: 2,
	});
	const exactMatch = matches.find(
		(candidate) => candidate.email === normalizedEmail,
	);
	if (exactMatch) return exactMatch;
	if (matches.length === 0) return null;
	if (matches.length > 1) {
		throw new APIError("BAD_REQUEST", {
			message:
				"Multiple accounts use this email with different casing. Contact support before continuing.",
		});
	}

	const legacyMatch = matches[0];
	if (!legacyMatch) return null;
	try {
		const normalizedUser = await db
			.update(schema.user)
			.set({
				email: normalizedEmail,
				updatedAt: new Date(),
			})
			.where(eq(schema.user.id, legacyMatch.id))
			.returning({
				id: schema.user.id,
				email: schema.user.email,
			})
			.then((rows) => rows[0]);
		return normalizedUser ?? legacyMatch;
	} catch {
		const concurrentExactMatch = await db.query.user.findFirst({
			where: eq(schema.user.email, normalizedEmail),
			columns: {
				id: true,
				email: true,
			},
		});
		if (concurrentExactMatch) return concurrentExactMatch;
		throw new APIError("BAD_REQUEST", {
			message: "Could not normalize this account email. Contact support.",
		});
	}
}

const authEmailPolicyPlugin = {
	id: "nearzero-email-policy",
	hooks: {
		before: [
			{
				matcher(ctx: { path?: string }) {
					return AUTH_EMAIL_PATHS.has(ctx.path ?? "");
				},
				handler: createAuthMiddleware(async (ctx) => {
					const email =
						typeof ctx.body?.email === "string" ? ctx.body.email : "";
					const policyError = getAuthEmailPolicyError(email);
					if (policyError) {
						throw new APIError("BAD_REQUEST", { message: policyError });
					}
					const intent = ctx.path === "/sign-up/email" ? "signup" : "login";
					const existingUser = await findAndNormalizeAuthUser(email);
					const accountError = getAuthOtpAccountError(
						intent,
						Boolean(existingUser),
					);
					if (accountError) {
						throw new APIError("BAD_REQUEST", { message: accountError });
					}
				}),
			},
		],
	},
};

const productionCookieAttributes = {
	sameSite: "lax" as const,
	secure: true,
	httpOnly: true,
	path: "/",
};

function createAuthRuntime() {
	const sharedCookieDomain = resolveSharedCookieDomain();
	const authBaseUrl = resolveAuthPublicBaseUrl();
	const useLocalAuthCookies =
		process.env.NODE_ENV !== "production" ||
		(authBaseUrl?.startsWith("http://") ?? false);

	return betterAuth({
		database: drizzleAdapter(db, {
			provider: "pg",
			schema: schema,
		}),
		disabledPaths: [
			"/sso/register",
			"/organization/create",
			"/organization/update",
			"/organization/delete",
			"/verify-email",
		],
		emailAndPassword: {
			enabled: true,
			requireEmailVerification: false,
		},
		secret: betterAuthSecret,
		...(authBaseUrl ? { baseURL: authBaseUrl } : {}),
		...(useLocalAuthCookies
			? {
					advanced: {
						useSecureCookies: false,
						disableOriginCheck: true,
						defaultCookieAttributes: {
							sameSite: "lax",
							secure: false,
							httpOnly: true,
							path: "/",
						},
					},
				}
			: {
					advanced: {
						useSecureCookies: true,
						disableOriginCheck: true,
						...(sharedCookieDomain
							? {
									crossSubDomainCookies: {
										enabled: true,
										domain: sharedCookieDomain,
									},
								}
							: {}),
						defaultCookieAttributes: productionCookieAttributes,
					},
				}),

		account: {
			accountLinking: {
				enabled: true,
				async trustedProviders() {
					return getTrustedProviders();
				},
				allowDifferentEmails: true,
			},
		},
		appName: "Nearzero",
		logger: {
			disabled: process.env.NODE_ENV === "production",
		},
		async trustedOrigins(request) {
			const { consolePort, platformPort } = resolveConsoleAndPlatformPorts();
			const envOrigins = resolveEnvTrustedOrigins();

			let publicIpOrigins: string[] = [];
			try {
				const publicIp = await getPublicIpWithFallback();
				if (publicIp) {
					publicIpOrigins = buildHostPortOrigins(
						[publicIp],
						consolePort,
						platformPort,
					);
				}
			} catch (error) {
				console.error(
					"Failed to resolve public IP for trusted origins:",
					error,
				);
			}

			try {
				const dbOrigins = await getTrustedOrigins();
				const settings = await getWebServerSettings();

				const runtimeOrigins = [
					...publicIpOrigins,
					...(settings?.serverIp
						? buildHostPortOrigins(
								[settings.serverIp],
								consolePort,
								platformPort,
							)
						: []),
					...(settings?.host ? [`https://${settings.host}`] : []),
					...dbOrigins,
				];

				return appendRequestOrigin(
					[...new Set([...envOrigins, ...runtimeOrigins])],
					request,
					consolePort,
					platformPort,
				);
			} catch (error) {
				console.error("Failed to resolve trusted origins:", error);
				const fallbackOrigins = [
					...new Set([...envOrigins, ...publicIpOrigins]),
				];
				if (fallbackOrigins.length > 0) {
					return appendRequestOrigin(
						fallbackOrigins,
						request,
						consolePort,
						platformPort,
					);
				}
				return appendRequestOrigin(
					process.env.NODE_ENV === "development"
						? [
								"http://localhost:4321",
								"http://127.0.0.1:4321",
								"http://localhost:3000",
								"http://127.0.0.1:3000",
							]
						: [],
					request,
					consolePort,
					platformPort,
				);
			}
		},
		databaseHooks: {
			user: {
				create: {
					before: async (_user, context) => {
						const normalizedUser = {
							..._user,
							email: normalizeAuthEmail(_user.email),
						};
						const xNearzeroToken =
							context?.request?.headers?.get("x-nearzero-token");
						if (xNearzeroToken) {
							let invitation: Awaited<ReturnType<typeof getUserByToken>>;
							try {
								invitation = await getUserByToken(xNearzeroToken);
							} catch {
								throw new APIError("BAD_REQUEST", {
									message: "Invalid invitation token",
								});
							}
							if (invitation.isExpired) {
								throw new APIError("BAD_REQUEST", {
									message: "Invitation has expired",
								});
							}
							if (invitation.status !== "pending") {
								throw new APIError("BAD_REQUEST", {
									message: "Invitation has already been used",
								});
							}
							if (
								_user.email.toLowerCase().trim() !==
								invitation.email.toLowerCase().trim()
							) {
								throw new APIError("BAD_REQUEST", {
									message: "Email does not match invitation",
								});
							}
							return { data: normalizedUser };
						}

						const isSSORequest = context?.path.includes("/sso");
						if (isSSORequest) {
							return;
						}
						if (context?.path !== "/sign-up/email") {
							return;
						}

						const policy = await getEffectiveRegistrationPolicy();
						if (policy.mode === "bootstrap" && !policy.adminEmail) {
							throw new APIError("FORBIDDEN", {
								message:
									"Finish the one-time domain setup before creating the first owner account.",
							});
						}
						const decision = decideRegistration({
							policy,
							email: _user.email,
							hasValidInvitation: false,
							bootstrapClaimed: await isBootstrapRegistrationClaimed(),
						});
						const policyMessage = registrationDecisionMessage(decision);
						if (policyMessage) {
							throw new APIError("FORBIDDEN", { message: policyMessage });
						}
						// A normalized unique email makes concurrent bootstrap attempts for the
						// configured administrator converge on one database row.
						return { data: normalizedUser };
					},
					after: async (user, context) => {
						const isSSORequest = context?.path.includes("/sso");
						const isAdminPresent = await db.query.member.findFirst({
							where: eq(schema.member.role, "owner"),
						});

						if (!isAdminPresent) {
							await ensureFirstOwnerServerIp(getPublicIpWithFallback);
						}

						let firstOwnerOrganizationId: string | null = null;
						if (isSSORequest) {
							const providerId = context?.params?.providerId;
							if (!providerId) {
								throw new APIError("BAD_REQUEST", {
									message: "Provider ID is required",
								});
							}
							const provider = await db.query.ssoProvider.findFirst({
								where: eq(schema.ssoProvider.providerId, providerId),
							});

							if (!provider) {
								throw new APIError("BAD_REQUEST", {
									message: "Provider not found",
								});
							}
							await db.insert(schema.member).values({
								userId: user.id,
								organizationId: provider?.organizationId || "",
								role: "member",
								createdAt: new Date(),
								isDefault: true,
							});
						} else {
							const personalOrganization = await db.transaction(async (tx) => {
								return ensurePersonalOrganizationForUser(user.id, tx);
							});
							if (!isAdminPresent && personalOrganization) {
								firstOwnerOrganizationId = personalOrganization.id;
							}
						}

						if (firstOwnerOrganizationId) {
							try {
								await adoptConfiguredManagedDnsZone({
									organizationId: firstOwnerOrganizationId,
									ownerEmail: user.email,
								});
							} catch (error) {
								console.error(
									"First-owner managed DNS adoption failed; the zone remains recoverable from Infrastructure → Domains.",
									error,
								);
							}
							try {
								await markInstallSetupClaimed(user.email);
							} catch (error) {
								console.error(
									"Failed to mark install setup as claimed after first-owner signup.",
									error,
								);
							}
						}
					},
				},
			},
			session: {
				create: {
					before: async (session) => {
						const member = await db.query.member.findFirst({
							where: eq(schema.member.userId, session.userId),
							orderBy: [
								desc(schema.member.isDefault),
								desc(schema.member.createdAt),
							],
							with: {
								organization: true,
							},
						});

						return {
							data: {
								...session,
								activeOrganizationId: member?.organization.id,
							},
						};
					},
					after: async (session) => {
						const orgId = (
							session as typeof session & { activeOrganizationId?: string }
						).activeOrganizationId;
						if (!orgId) return;
						const memberRecord = await db.query.member.findFirst({
							where: and(
								eq(schema.member.userId, session.userId),
								eq(schema.member.organizationId, orgId),
							),
							with: { user: true },
						});
						if (!memberRecord) return;
						await createAuditLog({
							organizationId: orgId,
							userId: session.userId,
							userEmail: memberRecord.user.email,
							userRole: memberRecord.role,
							action: "login",
							resourceType: "session",
						});
					},
				},
				delete: {
					after: async (session) => {
						const orgId = (
							session as typeof session & { activeOrganizationId?: string }
						).activeOrganizationId;
						if (!orgId) return;
						const memberRecord = await db.query.member.findFirst({
							where: and(
								eq(schema.member.userId, session.userId),
								eq(schema.member.organizationId, orgId),
							),
							with: { user: true },
						});
						if (!memberRecord) return;
						await createAuditLog({
							organizationId: orgId,
							userId: session.userId,
							userEmail: memberRecord.user.email,
							userRole: memberRecord.role,
							action: "logout",
							resourceType: "session",
						});
					},
				},
			},
		},
		session: {
			expiresIn: 60 * 60 * 24 * 3,
			updateAge: 60 * 60 * 24,
		},
		user: {
			modelName: "user",
			fields: {
				name: "firstName",
			},
			additionalFields: {
				role: {
					type: "string",
					input: false,
				},
				ownerId: {
					type: "string",
					input: false,
				},
				allowImpersonation: {
					fieldName: "allowImpersonation",
					type: "boolean",
					defaultValue: false,
				},
				lastName: {
					type: "string",
					required: false,
					input: true,
					defaultValue: "",
				},
				enableEnterpriseFeatures: {
					type: "boolean",
					required: false,
					input: false,
				},
				isValidEnterpriseLicense: {
					type: "boolean",
					required: false,
					input: false,
				},
			},
		},
		plugins: [
			authEmailPolicyPlugin,
			apiKey({
				enableMetadata: true,
				references: "user",
			}),
			sso(),
			twoFactor(),
			organization({
				ac,
				roles: {
					owner: ownerRole,
					admin: adminRole,
					member: memberRole,
				},
				dynamicAccessControl: {
					enabled: true,
					maximumRolesPerOrganization: 10,
				},
			}),
			...(process.env.USER_ADMIN_ID
				? [
						admin({
							adminUserIds: [process.env.USER_ADMIN_ID as string],
						}),
					]
				: []),
		],
	});
}

type AuthRuntime = ReturnType<typeof createAuthRuntime>;
type ReloadableAuthApiMethod =
	| "createApiKey"
	| "registerSSOProvider"
	| "updateSSOProvider";

let currentAuthRuntime = createAuthRuntime();

function currentAuthApi() {
	return currentAuthRuntime.api;
}

function reloadableApiMethod<K extends ReloadableAuthApiMethod>(key: K) {
	return ((...args: unknown[]) => {
		const method = currentAuthApi()[key] as unknown as (
			...values: unknown[]
		) => unknown;
		return method(...args);
	}) as AuthRuntime["api"][K];
}

const stableAuthHandler: AuthRuntime["handler"] = (request) =>
	currentAuthRuntime.handler(request);

const _auth = {
	handler: stableAuthHandler,
	createApiKey: reloadableApiMethod("createApiKey"),
	registerSSOProvider: reloadableApiMethod("registerSSOProvider"),
	updateSSOProvider: reloadableApiMethod("updateSSOProvider"),
};

export type AuthType = typeof _auth;
export const auth: AuthType = _auth;

/**
 * Rebuild Better Auth after first-run setup changes the durable public origin.
 * `auth` remains referentially stable, so Node adapters and service imports keep
 * dispatching through the newly created runtime without a process restart.
 */
export function reloadAuthRuntime() {
	currentAuthRuntime = createAuthRuntime();
	const publicBaseUrl = resolveAuthPublicBaseUrl() ?? null;
	return {
		publicBaseUrl,
		secureCookies:
			process.env.NODE_ENV === "production" &&
			Boolean(publicBaseUrl?.startsWith("https://")),
	};
}

const validateWebSocketTicket = async (request: IncomingMessage) => {
	let ticket: ReturnType<typeof verifyWebSocketTicket> = null;
	try {
		const url = new URL(
			request.url || "",
			`http://${request.headers.host || "localhost"}`,
		);
		ticket = verifyWebSocketTicket(url.searchParams.get("wsToken"));
	} catch {
		ticket = null;
	}
	if (!ticket) return null;

	const member = await db.query.member.findFirst({
		where: and(
			eq(schema.member.userId, ticket.userId),
			eq(schema.member.organizationId, ticket.organizationId),
		),
		with: {
			organization: true,
			user: true,
		},
	});

	if (!member) return null;

	const userFromDb = member.user as typeof member.user & {
		firstName: string;
		lastName: string;
	};

	return {
		session: {
			userId: userFromDb.id,
			activeOrganizationId: ticket.organizationId,
		},
		user: {
			id: userFromDb.id,
			name: userFromDb.firstName,
			email: userFromDb.email,
			emailVerified: userFromDb.emailVerified,
			image: userFromDb.image,
			createdAt: userFromDb.createdAt,
			updatedAt: userFromDb.updatedAt,
			twoFactorEnabled: userFromDb.twoFactorEnabled,
			role: member.role || "member",
			ownerId: member.organization.ownerId,
			enableEnterpriseFeatures: userFromDb.enableEnterpriseFeatures,
			isValidEnterpriseLicense: userFromDb.isValidEnterpriseLicense,
		},
	};
};

export const validateRequest = async (request: IncomingMessage) => {
	// Capture one coherent Better Auth runtime for the whole request. A setup
	// reload can replace the global runtime concurrently without mixing APIs.
	const api = currentAuthApi();
	const apiKey = request.headers["x-api-key"] as string;
	if (apiKey) {
		try {
			const { valid, key, error } = await api.verifyApiKey({
				body: {
					key: apiKey,
				},
			});

			if (error) {
				throw new Error(error.message?.toString() || "Error verifying API key");
			}
			if (!valid || !key) {
				return {
					session: null,
					user: null,
				};
			}

			const apiKeyRecord = await db.query.apikey.findFirst({
				where: eq(schema.apikey.id, key.id),
				with: {
					user: true,
				},
			});

			if (!apiKeyRecord) {
				return {
					session: null,
					user: null,
				};
			}

			const organizationId = (
				JSON.parse(apiKeyRecord.metadata || "{}") as {
					organizationId?: string;
				}
			).organizationId;

			if (!organizationId) {
				return {
					session: null,
					user: null,
				};
			}

			const member = await db.query.member.findFirst({
				where: and(
					eq(schema.member.userId, apiKeyRecord.user.id),
					eq(schema.member.organizationId, organizationId),
				),
				with: {
					organization: true,
				},
			});

			const userFromDb = apiKeyRecord.user as typeof apiKeyRecord.user & {
				firstName: string;
				lastName: string;
			};

			const mockSession = {
				session: {
					userId: apiKeyRecord.user.id,
					activeOrganizationId: organizationId || "",
				},
				user: {
					id: userFromDb.id,
					name: userFromDb.firstName,
					email: userFromDb.email,
					emailVerified: userFromDb.emailVerified,
					image: userFromDb.image,
					createdAt: userFromDb.createdAt,
					updatedAt: userFromDb.updatedAt,
					twoFactorEnabled: userFromDb.twoFactorEnabled,
					role: member?.role || "member",
					ownerId: member?.organization.ownerId || apiKeyRecord.user.id,
					enableEnterpriseFeatures: userFromDb.enableEnterpriseFeatures,
					isValidEnterpriseLicense: userFromDb.isValidEnterpriseLicense,
				},
			};

			return mockSession;
		} catch (error) {
			console.error("Error verifying API key", error);
			return {
				session: null,
				user: null,
			};
		}
	}

	const session = await api.getSession({
		headers: new Headers({
			cookie: request.headers.cookie || "",
		}),
	});

	if (!session?.session || !session.user) {
		// No cookie session. Fall back to a short-lived WebSocket ticket passed as
		// a `wsToken` query param. This is how cross-subdomain browser WebSockets
		// (terminals, logs, stats) authenticate when the session cookie is scoped
		// to the console host and not sent to the API host.
		const ticketSession = await validateWebSocketTicket(request);
		if (ticketSession) {
			return ticketSession;
		}
		return {
			session: null,
			user: null,
		};
	}

	if (session?.user) {
		const member = await db.query.member.findFirst({
			where: and(
				eq(schema.member.userId, session.user.id),
				...(session.session.activeOrganizationId
					? [
							eq(
								schema.member.organizationId,
								session.session.activeOrganizationId || "",
							),
						]
					: []),
			),
			orderBy: [desc(schema.member.isDefault), desc(schema.member.createdAt)],
			with: {
				organization: true,
				user: true,
			},
		});

		session.user.role = member?.role || "member";
		session.user.enableEnterpriseFeatures =
			member?.user.enableEnterpriseFeatures || false;
		session.user.isValidEnterpriseLicense =
			member?.user.isValidEnterpriseLicense || false;
		session.session.activeOrganizationId = member?.organization.id || "";
		if (member) {
			session.user.ownerId = member.organization.ownerId;
		} else {
			session.user.ownerId = session.user.id;
		}
	}

	return session;
};
