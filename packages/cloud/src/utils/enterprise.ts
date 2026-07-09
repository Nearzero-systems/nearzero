import {
	EDITION_FEATURES,
	isEditionFeatureEnabled,
} from "@nearzero/server/services/edition-policy";

export const validateLicenseKey = async (_licenseKey: string) => {
	return isEditionFeatureEnabled(EDITION_FEATURES.managedSupport);
};

export const activateLicenseKey = async (_licenseKey: string) => {
	if (!isEditionFeatureEnabled(EDITION_FEATURES.managedSupport)) {
		throw new Error("Enterprise licensing is not available in Community mode.");
	}
	return { success: true };
};

export const deactivateLicenseKey = async (_licenseKey: string) => {
	return { success: true };
};
