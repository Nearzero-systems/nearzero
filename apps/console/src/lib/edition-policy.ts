import {
	EDITION_FEATURES,
	type EditionFeature,
} from "@nearzero/edition-contract";

export { EDITION_FEATURES, type EditionFeature };

export type EditionManifest = {
	edition: "community" | "cloud";
	features: Record<EditionFeature, boolean>;
	agent: {
		requiresOrgProviderKey: boolean;
		allowsEnvProviderKey: boolean;
	};
	gitProviders: {
		allowsByo: boolean;
		allowsManaged: boolean;
	};
	billing: {
		enforced: boolean;
	};
};

let cachedManifest: EditionManifest | null = null;

export function setEditionManifest(manifest: EditionManifest): void {
	cachedManifest = manifest;
}

export function getClientEditionManifest(): EditionManifest {
	if (cachedManifest) return cachedManifest;
	return {
		edition: "community",
		features: {
			[EDITION_FEATURES.sso]: false,
			[EDITION_FEATURES.customRoles]: false,
			[EDITION_FEATURES.auditLogs]: false,
			[EDITION_FEATURES.whitelabeling]: false,
			[EDITION_FEATURES.cloudBilling]: false,
			[EDITION_FEATURES.managedSupport]: false,
		},
		agent: {
			requiresOrgProviderKey: true,
			allowsEnvProviderKey: false,
		},
		gitProviders: {
			allowsByo: true,
			allowsManaged: false,
		},
		billing: {
			enforced: false,
		},
	};
}

export function isEditionFeatureEnabled(feature: EditionFeature): boolean {
	return getClientEditionManifest().features[feature] ?? false;
}
