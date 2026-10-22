import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { buffer } from "node:stream/consumers";
import { db } from "@nearzero/server/db";
import { account, member, session, user } from "@nearzero/server/db/schema";
import { auth, getPublicRegistrationStatus } from "@nearzero/server/index";
import { normalizeAuthEmail } from "@nearzero/server/lib/auth-email-policy";
import { emailEquals } from "@nearzero/server/lib/email-identity";
import bcrypt from "bcrypt";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { toNodeHandler } from "better-auth/node";
import { and, desc, eq } from "drizzle-orm";

const authHandler = toNodeHandler(auth.handler);

function json(res: ServerResponse, status: number, body: unknown) {
	res.statusCode = status;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.end(JSON.stringify(body));
}

function authState(
	res: ServerResponse,
	body:
		| { ok: true; token: string; user: Record<string, unknown> }
		| { ok: false; code: string; message: string },
) {
	return json(res, 200, body);
}

async function readJsonBody(req: IncomingMessage) {
	const raw = await buffer(req);
	if (!raw.length) return null;
	try {
		return JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

async function createSessionForUser(req: IncomingMessage, userId: string) {
	const now = new Date();
	const token = randomBytes(32).toString("hex");
	// Same choice as better-auth's session.create.before hook, which a direct
	// insert bypasses: the default membership, else the newest one.
	const defaultMembership = await db.query.member.findFirst({
		where: eq(member.userId, userId),
		orderBy: [desc(member.isDefault), desc(member.createdAt)],
		columns: { organizationId: true },
	});
	await db.insert(session).values({
		id: randomBytes(16).toString("hex"),
		token,
		userId,
		activeOrganizationId: defaultMembership?.organizationId ?? null,
		createdAt: now,
		updatedAt: now,
		expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
		ipAddress:
			typeof req.headers["x-forwarded-for"] === "string"
				? req.headers["x-forwarded-for"].split(",")[0]?.trim()
				: req.socket.remoteAddress,
		userAgent: req.headers["user-agent"],
	});
	return token;
}

const CREDENTIAL_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_CREDENTIAL_FAILURES_PER_EMAIL = 10;
const credentialFailures = new Map<
	string,
	{ count: number; resetAt: number }
>();

/**
 * This route checks passwords outside better-auth, so it carries its own
 * brute-force limit. Requests reach it through the console proxy, which does
 * not forward a trustworthy client address, so failures are counted per email.
 */
function isCredentialLoginThrottled(email: string, now = Date.now()) {
	const entry = credentialFailures.get(email);
	if (!entry) return false;
	if (entry.resetAt <= now) {
		credentialFailures.delete(email);
		return false;
	}
	return entry.count >= MAX_CREDENTIAL_FAILURES_PER_EMAIL;
}

function recordCredentialFailure(email: string, now = Date.now()) {
	const entry = credentialFailures.get(email);
	if (!entry || entry.resetAt <= now) {
		credentialFailures.set(email, {
			count: 1,
			resetAt: now + CREDENTIAL_FAILURE_WINDOW_MS,
		});
	} else {
		entry.count += 1;
	}
	if (credentialFailures.size > 10_000) {
		for (const [key, value] of credentialFailures) {
			if (value.resetAt <= now) credentialFailures.delete(key);
		}
	}
}

let timingEqualizerHash: Promise<string> | null = null;

/** Spend the same hashing work when no account exists, so timing does not reveal it. */
async function equalizeMissingAccountTiming(password: string) {
	timingEqualizerHash ??= hashPassword(randomBytes(16).toString("hex"));
	await verifyStoredPassword(await timingEqualizerHash, password);
}

const INVALID_CREDENTIALS = {
	ok: false,
	code: "invalid_credentials",
	message: "Invalid email or password.",
} as const;

async function verifyStoredPassword(hash: string, password: string) {
	if (hash.includes(":")) {
		try {
			return await verifyPassword({ hash, password });
		} catch {
			return false;
		}
	}
	return bcrypt.compare(password, hash);
}

async function handleCredentialSession(
	req: IncomingMessage,
	res: ServerResponse,
) {
	if (req.method !== "POST") {
		return json(res, 405, { message: "Method not allowed" });
	}

	const body = await readJsonBody(req);
	const email = typeof body?.email === "string" ? body.email : "";
	const password = typeof body?.password === "string" ? body.password : "";
	const intent = body?.intent === "signup" ? "signup" : "login";
	if (!email || password.length < 8) {
		return authState(res, {
			ok: false,
			code: "invalid_input",
			message: "Use a valid email and a password with at least 8 characters.",
		});
	}

	const normalizedEmail = normalizeAuthEmail(email);
	if (intent === "login" && isCredentialLoginThrottled(normalizedEmail)) {
		return authState(res, {
			ok: false,
			code: "too_many_attempts",
			message:
				"Too many failed sign-in attempts. Wait a few minutes and try again.",
		});
	}
	const existingUser = await db.query.user.findFirst({
		where: emailEquals(user.email, normalizedEmail),
		columns: {
			id: true,
			email: true,
			firstName: true,
			image: true,
			twoFactorEnabled: true,
			banned: true,
			banExpires: true,
		},
	});
	if (!existingUser) {
		if (intent === "signup") {
			return authState(res, {
				ok: false,
				code: "no_account",
				message: "Create this account with the normal signup flow.",
			});
		}
		// Do not reveal whether an account exists for this email.
		await equalizeMissingAccountTiming(password);
		recordCredentialFailure(normalizedEmail);
		return authState(res, INVALID_CREDENTIALS);
	}

	const credentialAccounts = await db.query.account.findMany({
		where: and(
			eq(account.userId, existingUser.id),
			eq(account.providerId, "credential"),
		),
		columns: {
			id: true,
			providerId: true,
			password: true,
		},
	});
	const credentialWithPassword = credentialAccounts.find(
		(candidate) => typeof candidate.password === "string" && candidate.password,
	);
	if (credentialWithPassword?.password) {
		if (intent === "signup") {
			return authState(res, {
				ok: false,
				code: "account_exists",
				message: "An account already exists with this email. Log in instead.",
			});
		}
		const valid = await verifyStoredPassword(
			credentialWithPassword.password,
			password,
		);
		if (!valid) {
			recordCredentialFailure(normalizedEmail);
			return authState(res, INVALID_CREDENTIALS);
		}
		credentialFailures.delete(normalizedEmail);
		if (!credentialWithPassword.password.includes(":")) {
			await db
				.update(account)
				.set({
					password: await hashPassword(password),
					updatedAt: new Date(),
				})
				.where(eq(account.id, credentialWithPassword.id));
		}

		const banActive =
			existingUser.banned &&
			(!existingUser.banExpires || existingUser.banExpires > new Date());
		if (banActive) {
			return authState(res, {
				ok: false,
				code: "account_banned",
				message: "This account has been suspended. Contact an administrator.",
			});
		}

		// Never mint a session here for 2FA accounts: the console hands off to
		// better-auth's sign-in, which issues the second-factor challenge.
		if (existingUser.twoFactorEnabled) {
			return authState(res, {
				ok: false,
				code: "two_factor_required",
				message: "Enter the code from your authenticator app.",
			});
		}

		const token = await createSessionForUser(req, existingUser.id);
		return authState(res, {
			ok: true,
			token,
			user: {
				id: existingUser.id,
				email: existingUser.email,
				name: existingUser.firstName || existingUser.email.split("@")[0],
				image: existingUser.image,
			},
		});
	}

	return authState(res, {
		ok: false,
		code: "password_recovery_required",
		message:
			"This account has no password credential. Ask an administrator to reset the account password.",
	});
}

export async function handleAuth(req: IncomingMessage, res: ServerResponse) {
	const pathname = (req.url ?? "").split("?")[0];
	if (pathname === "/api/auth/registration-status") {
		if (req.method !== "GET") {
			return json(res, 405, { message: "Method not allowed" });
		}
		res.setHeader("cache-control", "no-store");
		return json(res, 200, await getPublicRegistrationStatus());
	}
	if (pathname === "/api/auth/nearzero-adopt-credential") {
		await handleCredentialSession(req, res);
		return;
	}
	return authHandler(req, res);
}
