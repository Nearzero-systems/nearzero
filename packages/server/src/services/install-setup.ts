import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "@nearzero/server/db";
import {
	apiInstallSetupSubmit,
	installSetup,
	member,
	type ApiInstallSetupSubmit,
	type InstallSetupPhase,
} from "@nearzero/server/db/schema";
import {
	normalizeDnsHostname,
	normalizeDnsZoneName,
} from "@nearzero/server/utils/dns/zone-file";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
	getConfiguredPublicIp,
	getManagedDnsSoaEmail,
	getManagedDnsZone,
	getManagementHostname,
} from "../constants/domains";
import { normalizeAuthEmail, isValidAuthEmail } from "../lib/auth-email-policy";
import {
	updateLetsEncryptEmail,
	updateServerTraefik,
} from "../utils/traefik/web-server";
import {
	isManagedDnsEnabledByInstaller,
	writeManagedDnsBootstrapZone,
} from "./dns-bootstrap-zone";
import { isPublicIpv4 } from "./domain-target";
import { isCommunityMode } from "./runtime-mode";
import { ensureTraefikSetup } from "./settings";
import {
	getWebServerSettings,
	updateWebServerSettings,
} from "./web-server-settings";

const emailSchema = z.string().trim().email();

export type PublicInstallSetupStatus = {
	required: boolean;
	phase: InstallSetupPhase | "operational";
	community: boolean;
	bootstrapClaimed: boolean;
	setupTokenConfigured: boolean;
	managementConfigured: boolean;
	managementHostname: string | null;
	adminEmailConfigured: boolean;
	publicIp: string | null;
	managedDnsEnabled: boolean;
	managedDnsConfigured: boolean;
	managedDnsZone: string | null;
	managedDnsSkipped: boolean;
	canSubmit: boolean;
	resumeStep:
		| "welcome"
		| "management"
		| "zone"
		| "verify"
		| "done"
		| "register"
		| "login";
};

const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

function hashSetupToken(token: string) {
	return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateInstallSetupToken() {
	return randomBytes(32).toString("base64url");
}

export function hashInstallSetupToken(token: string) {
	return hashSetupToken(token);
}

export function getInstallSetupTokenHash(
	env: Record<string, string | undefined> = process.env,
) {
	const hash = env.NEARZERO_INSTALL_SETUP_TOKEN_HASH?.trim().toLowerCase();
	return hash && /^[a-f0-9]{64}$/.test(hash) ? hash : null;
}

export function verifyInstallSetupToken(
	token: string,
	env: Record<string, string | undefined> = process.env,
) {
	const expected = getInstallSetupTokenHash(env);
	if (!expected || !token) return false;
	const actual = hashSetupToken(token);
	try {
		return timingSafeEqual(
			Buffer.from(actual, "utf8"),
			Buffer.from(expected, "utf8"),
		);
	} catch {
		return false;
	}
}

function consumeRateLimit(key: string, limit = 20, windowMs = 60_000) {
	const now = Date.now();
	const current = rateLimitBuckets.get(key);
	if (!current || current.resetAt <= now) {
		rateLimitBuckets.set(key, { count: 1, resetAt: now + windowMs });
		return true;
	}
	if (current.count >= limit) return false;
	current.count += 1;
	return true;
}

/** Test helper */
export function resetInstallSetupRateLimits() {
	rateLimitBuckets.clear();
}

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

export async function getSetupAdminEmail(): Promise<string | null> {
	const envEmail = normalizeAuthEmail(process.env.NEARZERO_ADMIN_EMAIL ?? "");
	if (isValidAuthEmail(envEmail)) return envEmail;
	const row = await getInstallSetupRow();
	const dbEmail = normalizeAuthEmail(row.adminEmail ?? "");
	return isValidAuthEmail(dbEmail) ? dbEmail : null;
}

export async function getEffectiveManagedDnsZone(): Promise<string | null> {
	const fromEnv = getManagedDnsZone();
	if (fromEnv) return fromEnv;
	const row = await getInstallSetupRow();
	return row.managedDnsZone
		? normalizeDnsZoneName(row.managedDnsZone)
		: null;
}

export async function getEffectiveManagedDnsSoaEmail(): Promise<string | null> {
	const fromEnv = getManagedDnsSoaEmail();
	if (fromEnv) return fromEnv;
	const row = await getInstallSetupRow();
	const candidate = row.managedDnsSoaEmail || row.adminEmail;
	return candidate ? emailSchema.parse(candidate) : null;
}

function resolveResumeStep(input: {
	required: boolean;
	bootstrapClaimed: boolean;
	managementConfigured: boolean;
	managedDnsEnabled: boolean;
	managedDnsConfigured: boolean;
	managedDnsSkipped: boolean;
	phase: InstallSetupPhase;
}): PublicInstallSetupStatus["resumeStep"] {
	if (input.bootstrapClaimed || input.phase === "claimed") return "login";
	if (!input.required) {
		return input.managementConfigured ? "register" : "login";
	}
	if (input.phase === "configured" || input.managementConfigured) {
		return "verify";
	}
	if (!input.managementConfigured) {
		return input.phase === "pending" ? "welcome" : "management";
	}
	if (
		input.managedDnsEnabled &&
		!input.managedDnsConfigured &&
		!input.managedDnsSkipped
	) {
		return "zone";
	}
	return "verify";
}

export async function getPublicInstallSetupStatus(): Promise<PublicInstallSetupStatus> {
	const community = isCommunityMode();
	const bootstrapClaimed = await hasOwnerMember();
	const settings = await getWebServerSettings();
	const row = await getInstallSetupRow();
	const envHost = getManagementHostname();
	const managementHostname =
		(settings?.host
			? normalizeDnsHostname(settings.host, { requireFqdn: true })
			: null) ||
		(row.managementHostname
			? normalizeDnsHostname(row.managementHostname, { requireFqdn: true })
			: null) ||
		envHost;
	const managedDnsEnabled = isManagedDnsEnabledByInstaller();
	const managedDnsZone = await getEffectiveManagedDnsZone();
	const adminEmailConfigured = Boolean(await getSetupAdminEmail());
	const managementConfigured = Boolean(managementHostname);
	const managedDnsConfigured = Boolean(managedDnsZone);
	const setupTokenConfigured = Boolean(getInstallSetupTokenHash());
	const phase: InstallSetupPhase =
		bootstrapClaimed || row.phase === "claimed"
			? "claimed"
			: managementConfigured || row.phase === "configured"
				? "configured"
				: "pending";

	// Token presence is the authority gate. Production Community installs always
	// receive a token from install.sh; local/dev only enters the wizard when a
	// token hash is explicitly configured.
	const required =
		community &&
		!bootstrapClaimed &&
		setupTokenConfigured &&
		(!managementConfigured || !adminEmailConfigured);

	const canSubmit =
		required &&
		phase === "pending" &&
		!bootstrapClaimed &&
		setupTokenConfigured;

	return {
		required,
		phase: bootstrapClaimed ? "operational" : phase,
		community,
		bootstrapClaimed,
		setupTokenConfigured,
		managementConfigured,
		managementHostname,
		adminEmailConfigured,
		publicIp:
			settings?.serverIp ||
			row.publicIp ||
			getConfiguredPublicIp() ||
			null,
		managedDnsEnabled,
		managedDnsConfigured,
		managedDnsZone,
		managedDnsSkipped: row.managedDnsSkipped,
		canSubmit,
		resumeStep: resolveResumeStep({
			required: required || (community && !bootstrapClaimed && setupTokenConfigured),
			bootstrapClaimed,
			managementConfigured,
			managedDnsEnabled,
			managedDnsConfigured,
			managedDnsSkipped: row.managedDnsSkipped,
			phase,
		}),
	};
}

export class InstallSetupError extends Error {
	constructor(
		message: string,
		readonly code:
			| "FORBIDDEN"
			| "UNAUTHORIZED"
			| "BAD_REQUEST"
			| "RATE_LIMITED"
			| "CONFLICT" = "BAD_REQUEST",
	) {
		super(message);
		this.name = "InstallSetupError";
	}
}

export async function assertInstallSetupMutable() {
	if (!isCommunityMode()) {
		throw new InstallSetupError(
			"Install setup is only available on Community editions",
			"FORBIDDEN",
		);
	}
	if (await hasOwnerMember()) {
		throw new InstallSetupError(
			"Install setup is no longer available after the first owner exists",
			"FORBIDDEN",
		);
	}
	const row = await getInstallSetupRow();
	if (row.phase === "configured" || row.phase === "claimed") {
		const settings = await getWebServerSettings();
		if (settings?.host) {
			throw new InstallSetupError(
				"Install setup has already been completed",
				"CONFLICT",
			);
		}
	}
	if (!getInstallSetupTokenHash()) {
		throw new InstallSetupError(
			"Install setup token is not configured on this installation",
			"FORBIDDEN",
		);
	}
}

export async function submitInstallSetup(
	rawInput: unknown,
	options: { clientKey?: string } = {},
) {
	const clientKey = options.clientKey ?? "anonymous";
	if (!consumeRateLimit(`setup:${clientKey}`, 12, 60_000)) {
		throw new InstallSetupError(
			"Too many setup attempts. Try again in a minute.",
			"RATE_LIMITED",
		);
	}

	await assertInstallSetupMutable();

	const parsed = apiInstallSetupSubmit.parse(rawInput);
	if (!verifyInstallSetupToken(parsed.token)) {
		throw new InstallSetupError("Invalid or expired setup token", "UNAUTHORIZED");
	}

	const managementHostname = normalizeDnsHostname(parsed.managementHostname, {
		requireFqdn: true,
	});
	const adminEmail = normalizeAuthEmail(parsed.adminEmail);
	if (!isValidAuthEmail(adminEmail)) {
		throw new InstallSetupError("Enter a valid administrator email");
	}

	const configuredIp =
		parsed.publicIp?.trim() ||
		(await getWebServerSettings())?.serverIp ||
		getConfiguredPublicIp();
	if (!configuredIp || !isPublicIpv4(configuredIp)) {
		throw new InstallSetupError(
			"A publicly routable IPv4 address is required before assigning a management hostname",
		);
	}

	const managedDnsEnabled = isManagedDnsEnabledByInstaller();
	const skipManagedDns = Boolean(parsed.skipManagedDns) || !managedDnsEnabled;
	let managedDnsZone: string | null = null;
	let managedDnsSoaEmail: string | null = null;

	if (!skipManagedDns && parsed.managedDnsZone?.trim()) {
		managedDnsZone = normalizeDnsZoneName(parsed.managedDnsZone);
		managedDnsSoaEmail = emailSchema.parse(
			parsed.managedDnsSoaEmail?.trim() || adminEmail,
		);
	}

	const existingEnvHost = getManagementHostname();
	if (existingEnvHost && existingEnvHost !== managementHostname) {
		throw new InstallSetupError(
			`Management hostname is already fixed by the installer as ${existingEnvHost}`,
			"CONFLICT",
		);
	}
	const existingEnvZone = getManagedDnsZone();
	if (
		existingEnvZone &&
		managedDnsZone &&
		existingEnvZone !== managedDnsZone
	) {
		throw new InstallSetupError(
			`Managed DNS zone is already fixed by the installer as ${existingEnvZone}`,
			"CONFLICT",
		);
	}

	const settings = await updateWebServerSettings({
		host: managementHostname,
		https: true,
		certificateType: "letsencrypt",
		letsEncryptEmail: adminEmail,
		serverIp: configuredIp,
	});
	if (!settings) {
		throw new InstallSetupError("Failed to persist management domain settings");
	}

	try {
		updateServerTraefik(settings, managementHostname);
		updateLetsEncryptEmail(adminEmail);
		await ensureTraefikSetup();
	} catch (error) {
		console.error("Install setup Traefik apply failed:", error);
		throw new InstallSetupError(
			error instanceof Error
				? error.message
				: "Failed to apply Traefik management routing",
		);
	}

	if (managedDnsZone && managedDnsSoaEmail) {
		writeManagedDnsBootstrapZone({
			zoneName: managedDnsZone,
			publicIp: configuredIp,
			soaEmail: managedDnsSoaEmail,
			managementHostname,
		});
	}

	const row = await getInstallSetupRow();
	const now = new Date();
	await db
		.update(installSetup)
		.set({
			phase: "configured",
			adminEmail,
			managementHostname,
			publicIp: configuredIp,
			managedDnsZone,
			managedDnsSoaEmail,
			managedDnsSkipped: skipManagedDns || !managedDnsZone,
			configuredAt: now,
			updatedAt: now,
		})
		.where(eq(installSetup.id, row.id));

	return getPublicInstallSetupStatus();
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

/** Seed install_setup from legacy env-configured installs so the wizard skips. */
export async function syncInstallSetupFromEnvironment() {
	const row = await getInstallSetupRow();
	if (row.phase !== "pending") return row;
	const host = getManagementHostname();
	const adminEmail = normalizeAuthEmail(process.env.NEARZERO_ADMIN_EMAIL ?? "");
	const zone = getManagedDnsZone();
	const soa = getManagedDnsSoaEmail();
	const publicIp = getConfiguredPublicIp();
	if (!host && !adminEmail && !zone) return row;

	const now = new Date();
	const configured = Boolean(host && isValidAuthEmail(adminEmail));
	const [updated] = await db
		.update(installSetup)
		.set({
			phase: configured ? "configured" : "pending",
			managementHostname: host,
			adminEmail: isValidAuthEmail(adminEmail) ? adminEmail : null,
			managedDnsZone: zone,
			managedDnsSoaEmail: soa,
			publicIp,
			managedDnsSkipped: !zone && !isManagedDnsEnabledByInstaller(),
			configuredAt: configured ? now : null,
			updatedAt: now,
		})
		.where(eq(installSetup.id, row.id))
		.returning();
	return updated ?? row;
}

export type { ApiInstallSetupSubmit };
