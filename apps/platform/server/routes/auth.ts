import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { buffer } from "node:stream/consumers";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import bcrypt from "bcrypt";
import { auth } from "@nearzero/server/index";
import { db } from "@nearzero/server/db";
import { account, session, user } from "@nearzero/server/db/schema";
import { normalizeAuthEmail } from "@nearzero/server/lib/auth-email-policy";
import { emailEquals } from "@nearzero/server/lib/email-identity";
import { toNodeHandler } from "better-auth/node";
import { and, eq } from "drizzle-orm";

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
	await db.insert(session).values({
		id: randomBytes(16).toString("hex"),
		token,
		userId,
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

async function handleCredentialSession(req: IncomingMessage, res: ServerResponse) {
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
	const existingUser = await db.query.user.findFirst({
		where: emailEquals(user.email, normalizedEmail),
		columns: {
			id: true,
			email: true,
			firstName: true,
			image: true,
		},
	});
	if (!existingUser) {
		return authState(res, {
			ok: false,
			code: "no_account",
			message:
				intent === "signup"
					? "Create this account with the normal signup flow."
					: "No account exists for this email yet. Sign up first.",
		});
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
			return authState(res, {
				ok: false,
				code: "invalid_credentials",
				message: "Invalid email or password.",
			});
		}
		if (!credentialWithPassword.password.includes(":")) {
			await db
				.update(account)
				.set({
					password: await hashPassword(password),
					updatedAt: new Date(),
				})
				.where(eq(account.id, credentialWithPassword.id));
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

	const now = new Date();
	const hashedPassword = await hashPassword(password);
	const existingCredential = credentialAccounts[0];
	if (existingCredential) {
		await db
			.update(account)
			.set({
				password: hashedPassword,
				updatedAt: now,
			})
			.where(eq(account.id, existingCredential.id));
	} else {
		await db.insert(account).values({
			userId: existingUser.id,
			accountId: existingUser.id,
			providerId: "credential",
			password: hashedPassword,
			createdAt: now,
			updatedAt: now,
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

export async function handleAuth(req: IncomingMessage, res: ServerResponse) {
	if ((req.url ?? "").split("?")[0] === "/api/auth/nearzero-adopt-credential") {
		await handleCredentialSession(req, res);
		return;
	}
	return authHandler(req, res);
}
