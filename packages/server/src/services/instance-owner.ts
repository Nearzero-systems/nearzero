import { hashPassword } from "better-auth/crypto";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../db";
import { account, member, organization, session, user } from "../db/schema";
import { signUpTrustedOwner } from "../lib/auth";
import { isValidAuthEmail, normalizeAuthEmail } from "../lib/auth-email-policy";
import { emailEquals } from "../lib/email-identity";
import { ensureOrganizationSlug } from "../utils/org-slug";
import { hasOwnerMember } from "./install-setup";

export const MIN_OWNER_PASSWORD_LENGTH = 8;
export const MAX_OWNER_PASSWORD_LENGTH = 128;

export class InstanceOwnerError extends Error {
	constructor(
		message: string,
		readonly code: "INVALID_INPUT" | "OWNER_EXISTS" | "NOT_FOUND",
	) {
		super(message);
		this.name = "InstanceOwnerError";
	}
}

function validateCredentials(rawEmail: string, password: string) {
	const email = normalizeAuthEmail(rawEmail);
	if (!isValidAuthEmail(email)) {
		throw new InstanceOwnerError(
			"Enter a valid email address.",
			"INVALID_INPUT",
		);
	}
	if (
		password.length < MIN_OWNER_PASSWORD_LENGTH ||
		password.length > MAX_OWNER_PASSWORD_LENGTH
	) {
		throw new InstanceOwnerError(
			`Use a password between ${MIN_OWNER_PASSWORD_LENGTH} and ${MAX_OWNER_PASSWORD_LENGTH} characters.`,
			"INVALID_INPUT",
		);
	}
	return email;
}

/** "jane.doe@acme.com" -> "Jane" */
export function ownerFirstNameFromEmail(email: string) {
	const word = normalizeAuthEmail(email)
		.split("@")[0]
		?.split(/[^a-z0-9]+/)
		.find((part) => /[a-z]/.test(part));
	if (!word) return "Admin";
	return word.charAt(0).toUpperCase() + word.slice(1);
}

export async function findInstanceOwner() {
	const ownerMembership = await db.query.member.findFirst({
		where: eq(member.role, "owner"),
		orderBy: [asc(member.createdAt)],
		with: { user: { columns: { id: true, email: true } } },
	});
	return ownerMembership?.user ?? null;
}

/**
 * Create the first owner of a self-hosted install from the server. The account
 * lands straight on the dashboard: its profile and workspace are filled in, so
 * there is no onboarding to click through.
 */
export async function createInstanceOwner(input: {
	email: string;
	password: string;
}) {
	const email = validateCredentials(input.email, input.password);
	if (await hasOwnerMember()) {
		throw new InstanceOwnerError(
			"This server already has an owner account.",
			"OWNER_EXISTS",
		);
	}
	const existing = await db.query.user.findFirst({
		where: emailEquals(user.email, email),
		columns: { id: true },
	});
	if (existing) {
		throw new InstanceOwnerError(
			`An account for ${email} already exists.`,
			"OWNER_EXISTS",
		);
	}

	const firstName = ownerFirstNameFromEmail(email);
	const created = await signUpTrustedOwner({
		email,
		password: input.password,
		name: firstName,
	});
	const userId = created.user.id;

	// Sign-up opens a session nobody will use.
	await db.delete(session).where(eq(session.userId, userId));

	const workspace = await db.query.member.findFirst({
		where: and(eq(member.userId, userId), eq(member.role, "owner")),
		with: { organization: true },
	});
	if (workspace?.organization) {
		const name = `${firstName}'s workspace`;
		await db
			.update(organization)
			.set({
				name,
				slug: await ensureOrganizationSlug(
					name,
					workspace.organization.id,
					workspace.organization.slug,
				),
			})
			.where(eq(organization.id, workspace.organization.id));
		await db
			.update(member)
			.set({ isDefault: true })
			.where(eq(member.id, workspace.id));
	}
	await db
		.update(user)
		.set({ firstName, isRegistered: true, emailVerified: true })
		.where(eq(user.id, userId));

	return { id: userId, email };
}

/** Set a new password for an account and sign it out everywhere. */
export async function resetAccountPassword(input: {
	email: string;
	password: string;
}) {
	const email = validateCredentials(input.email, input.password);
	const target = await db.query.user.findFirst({
		where: emailEquals(user.email, email),
		columns: { id: true, email: true },
	});
	if (!target) {
		throw new InstanceOwnerError(
			`No account exists for ${email}.`,
			"NOT_FOUND",
		);
	}

	const passwordHash = await hashPassword(input.password);
	const now = new Date();
	const updated = await db
		.update(account)
		.set({ password: passwordHash, updatedAt: now })
		.where(
			and(eq(account.userId, target.id), eq(account.providerId, "credential")),
		)
		.returning({ id: account.id });
	if (updated.length === 0) {
		await db.insert(account).values({
			accountId: target.id,
			providerId: "credential",
			userId: target.id,
			password: passwordHash,
			createdAt: now,
			updatedAt: now,
		});
	}
	await db.delete(session).where(eq(session.userId, target.id));
	return { id: target.id, email: target.email };
}
