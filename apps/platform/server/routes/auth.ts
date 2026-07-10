import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { buffer } from "node:stream/consumers";
import { hashPassword } from "better-auth/crypto";
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

async function readJsonBody(req: IncomingMessage) {
	const raw = await buffer(req);
	if (!raw.length) return null;
	try {
		return JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

async function adoptMissingCredential(
	req: IncomingMessage,
	res: ServerResponse,
) {
	if (req.method !== "POST") {
		return json(res, 405, { message: "Method not allowed" });
	}

	const body = await readJsonBody(req);
	const email = typeof body?.email === "string" ? body.email : "";
	const password = typeof body?.password === "string" ? body.password : "";
	if (!email || password.length < 8) {
		return json(res, 400, { message: "Invalid email or password." });
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
		return json(res, 404, { message: "No account exists for this email yet." });
	}

	const existingCredential = await db.query.account.findFirst({
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
	if (existingCredential?.password) {
		return json(res, 409, {
			message: "An account already exists with this email. Log in instead.",
		});
	}

	const now = new Date();
	const hashedPassword = await hashPassword(password);
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

	const token = randomBytes(32).toString("hex");
	await db.insert(session).values({
		id: randomBytes(16).toString("hex"),
		token,
		userId: existingUser.id,
		createdAt: now,
		updatedAt: now,
		expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
		ipAddress:
			typeof req.headers["x-forwarded-for"] === "string"
				? req.headers["x-forwarded-for"].split(",")[0]?.trim()
				: req.socket.remoteAddress,
		userAgent: req.headers["user-agent"],
	});

	return json(res, 200, {
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
		await adoptMissingCredential(req, res);
		return;
	}
	return authHandler(req, res);
}
