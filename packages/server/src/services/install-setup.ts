import { db } from "@nearzero/server/db";
import { installSetup, member } from "@nearzero/server/db/schema";
import { normalizeDnsZoneName } from "@nearzero/server/utils/dns/zone-file";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getManagedDnsSoaEmail, getManagedDnsZone } from "../constants/domains";
import { normalizeAuthEmail } from "../lib/auth-email-policy";

const emailSchema = z.string().trim().email();

export async function getInstallSetupRow() {
	const existing = await db.query.installSetup.findFirst();
	if (existing) return existing;
	const [created] = await db.insert(installSetup).values({}).returning();
	return created!;
}

export async function hasOwnerMember() {
	const owner = await db.query.member.findFirst({
		where: eq(member.role, "owner"),
		columns: { id: true },
	});
	return Boolean(owner);
}

export async function getEffectiveManagedDnsZone(): Promise<string | null> {
	const fromEnv = getManagedDnsZone();
	if (fromEnv) return fromEnv;
	const row = await getInstallSetupRow();
	return row.managedDnsZone ? normalizeDnsZoneName(row.managedDnsZone) : null;
}

export async function getEffectiveManagedDnsSoaEmail(): Promise<string | null> {
	const fromEnv = getManagedDnsSoaEmail();
	if (fromEnv) return fromEnv;
	const row = await getInstallSetupRow();
	const candidate = row.managedDnsSoaEmail || row.adminEmail;
	return candidate ? emailSchema.parse(candidate) : null;
}

export async function markInstallSetupClaimed(ownerEmail: string) {
	const row = await getInstallSetupRow();
	if (row.phase === "claimed") return row;
	const now = new Date();
	const [updated] = await db
		.update(installSetup)
		.set({
			phase: "claimed",
			claimedAt: now,
			updatedAt: now,
			adminEmail: normalizeAuthEmail(ownerEmail) || row.adminEmail,
		})
		.where(eq(installSetup.id, row.id))
		.returning();
	return updated ?? row;
}
