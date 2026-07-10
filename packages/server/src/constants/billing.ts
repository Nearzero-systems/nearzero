import { tryGetEdition } from "@nearzero/edition-contract";

/** Platform-wide default apex for Mode B auto URLs (e.g. from NEARZERO_PLATFORM_DOMAIN). */
export function getPlatformDefaultDomain(): string | null {
	const raw = process.env.NEARZERO_PLATFORM_DOMAIN?.trim()
		.toLowerCase()
		.replace(/\.$/, "");
	return raw || null;
}

export function isStripeConfigured() {
	return false;
}

/** Cloud billing is not enforced in the Community edition. */
export function shouldEnforceCloudBilling() {
	const edition = tryGetEdition();
	if (edition) {
		return edition.shouldEnforceCloudBilling();
	}
	return false;
}
