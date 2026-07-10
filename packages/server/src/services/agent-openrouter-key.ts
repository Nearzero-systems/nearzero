import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { tryGetEdition } from "@nearzero/edition-contract";
import { db } from "@nearzero/server/db";
import { organizationSettings } from "@nearzero/server/db/schema";
import { eq } from "drizzle-orm";
import { getOrganizationSettings } from "./organization-settings";

function encryptionSecret() {
	const secret = process.env.BETTER_AUTH_SECRET;
	if (!secret) {
		throw new Error("BETTER_AUTH_SECRET is required to store OpenRouter keys.");
	}
	return secret;
}

export function isValidOpenRouterKeyShape(apiKey: string) {
	const trimmed = apiKey.trim();
	return trimmed.length >= 8 && trimmed.length <= 512;
}

export async function encryptOrgOpenRouterKey(plaintext: string) {
	return symmetricEncrypt({
		key: encryptionSecret(),
		data: plaintext.trim(),
	});
}

export async function decryptOrgOpenRouterKey(ciphertext: string) {
	return symmetricDecrypt({
		key: encryptionSecret(),
		data: ciphertext,
	});
}

export async function hasOrgOpenRouterKey(organizationId: string) {
	const settings = await getOrganizationSettings(organizationId);
	return Boolean(settings.openRouterApiKeyCiphertext?.trim());
}

export async function getOrgOpenRouterApiKey(organizationId: string) {
	const settings = await getOrganizationSettings(organizationId);
	const ciphertext = settings.openRouterApiKeyCiphertext?.trim();
	if (!ciphertext) return null;
	return decryptOrgOpenRouterKey(ciphertext);
}

export async function setOrgOpenRouterKey(
	organizationId: string,
	userId: string,
	apiKey: string,
) {
	if (!isValidOpenRouterKeyShape(apiKey)) {
		throw new Error("Invalid OpenRouter API key.");
	}
	await getOrganizationSettings(organizationId);
	const ciphertext = await encryptOrgOpenRouterKey(apiKey);
	const now = new Date().toISOString();
	const [updated] = await db
		.update(organizationSettings)
		.set({
			openRouterApiKeyCiphertext: ciphertext,
			openRouterApiKeyConfiguredAt: now,
			openRouterApiKeyConfiguredByUserId: userId,
			updatedAt: now,
		})
		.where(eq(organizationSettings.organizationId, organizationId))
		.returning();
	if (!updated) throw new Error("Failed to save OpenRouter key.");
	return updated;
}

export async function clearOrgOpenRouterKey(organizationId: string) {
	await getOrganizationSettings(organizationId);
	const now = new Date().toISOString();
	const [updated] = await db
		.update(organizationSettings)
		.set({
			openRouterApiKeyCiphertext: null,
			openRouterApiKeyConfiguredAt: null,
			openRouterApiKeyConfiguredByUserId: null,
			updatedAt: now,
		})
		.where(eq(organizationSettings.organizationId, organizationId))
		.returning();
	if (!updated) throw new Error("Failed to clear OpenRouter key.");
	return updated;
}

export type AgentProviderSource = "env" | "org" | "none";

export async function getAgentProviderStatus(organizationId: string) {
	const edition = tryGetEdition();
	const allowsEnvProviderKey =
		edition?.allowsEnvAgentProviderKey() ?? false;

	if (allowsEnvProviderKey && process.env.OPENROUTER_API_KEY?.trim()) {
		return { configured: true, source: "env" as const };
	}
	if (await hasOrgOpenRouterKey(organizationId)) {
		return { configured: true, source: "org" as const };
	}
	return { configured: false, source: "none" as const };
}
