import { IS_COMMUNITY } from "@/lib/branding";

export const EDITION_FEATURES = {
	sso: "sso",
	customRoles: "customRoles",
	auditLogs: "auditLogs",
	whitelabeling: "whitelabeling",
	cloudBilling: "cloudBilling",
	managedSupport: "managedSupport",
} as const;

export type EditionFeature =
	(typeof EDITION_FEATURES)[keyof typeof EDITION_FEATURES];

export function isEditionFeatureEnabled(_feature: EditionFeature): boolean {
	return !IS_COMMUNITY;
}
