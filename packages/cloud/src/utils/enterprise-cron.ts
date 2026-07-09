import {
	EDITION_FEATURES,
	isEditionFeatureEnabled,
} from "../../services/edition-policy";

export const LICENSE_KEY_URL = "https://licenses-api.nearzero.dev";

export const initEnterpriseBackupCronJobs = async () => {
	// License re-validation disabled for self-hosted fork.
};

export const validateLicenseKey = async (_licenseKey: string) => {
	return isEditionFeatureEnabled(EDITION_FEATURES.managedSupport);
};
