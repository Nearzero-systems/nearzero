import { getEdition, tryGetEdition } from "@nearzero/edition-contract";

/** Platform-wide default apex for Mode B auto URLs (e.g. from NEARZERO_PLATFORM_DOMAIN). */
export function getPlatformDefaultDomain(): string | null {
	const raw = process.env.NEARZERO_PLATFORM_DOMAIN?.trim()
		.toLowerCase()
		.replace(/\.$/, "");
	return raw || null;
}

export function isStripeConfigured() {
	return Boolean(process.env.STRIPE_SECRET_KEY?.trim());
}

/** Stripe/plan limits only apply to hosted Cloud mode in production unless bypassed. */
export function shouldEnforceCloudBilling() {
	const edition = tryGetEdition();
	if (edition) {
		return edition.shouldEnforceCloudBilling();
	}
	if (process.env.COMMUNITY !== "false") return false;
	if (!isStripeConfigured()) return false;
	if (
		process.env.NEARZERO_DEV_BYPASS_BILLING === "true" ||
		process.env.NEARZERO_DEV_BYPASS_BILLING === "1"
	) {
		return false;
	}
	return process.env.NODE_ENV === "production";
}
