export * from "./registry";
export * from "./types";

export class EditionFeatureError extends Error {
	readonly feature: import("./types").EditionFeature;

	constructor(feature: import("./types").EditionFeature, label: string) {
		super(`${label} is not available in Community mode.`);
		this.name = "EditionFeatureError";
		this.feature = feature;
	}
}

export function getEditionFeatureLabel(feature: import("./types").EditionFeature): string {
	switch (feature) {
		case "sso":
			return "SSO";
		case "customRoles":
			return "Custom roles";
		case "auditLogs":
			return "Audit logs";
		case "whitelabeling":
			return "Whitelabeling";
		case "cloudBilling":
			return "Cloud billing";
		case "managedSupport":
			return "Managed support";
		default:
			return "This feature";
	}
}
