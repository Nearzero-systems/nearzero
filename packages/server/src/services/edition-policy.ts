import { isCloudMode, isCommunityMode } from "./runtime-mode";

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

export type RuntimeEdition = "community" | "cloud";

export type EditionFeatureContext = {
	organizationId?: string | null;
	userId?: string | null;
};

export class EditionFeatureError extends Error {
	readonly feature: EditionFeature;

	constructor(feature: EditionFeature) {
		super(
			`${getEditionFeatureLabel(feature)} is not available in Community mode.`,
		);
		this.name = "EditionFeatureError";
		this.feature = feature;
	}
}

export function getRuntimeEdition(): RuntimeEdition {
	return isCloudMode() ? "cloud" : "community";
}

export function getEditionFeatureLabel(feature: EditionFeature): string {
	switch (feature) {
		case EDITION_FEATURES.sso:
			return "SSO";
		case EDITION_FEATURES.customRoles:
			return "Custom roles";
		case EDITION_FEATURES.auditLogs:
			return "Audit logs";
		case EDITION_FEATURES.whitelabeling:
			return "Whitelabeling";
		case EDITION_FEATURES.cloudBilling:
			return "Cloud billing";
		case EDITION_FEATURES.managedSupport:
			return "Managed support";
		default:
			return "This feature";
	}
}

export function isEditionFeatureEnabled(
	_feature: EditionFeature,
	_ctx?: EditionFeatureContext,
): boolean {
	if (isCommunityMode()) {
		return false;
	}
	return true;
}

export function requireEditionFeature(
	feature: EditionFeature,
	ctx?: EditionFeatureContext,
) {
	if (!isEditionFeatureEnabled(feature, ctx)) {
		throw new EditionFeatureError(feature);
	}
}

export function hasAnyPaidEditionFeature(ctx?: EditionFeatureContext): boolean {
	return Object.values(EDITION_FEATURES).some((feature) =>
		isEditionFeatureEnabled(feature, ctx),
	);
}
