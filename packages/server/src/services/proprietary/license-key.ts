import { hasAnyPaidEditionFeature } from "../edition-policy";

export const hasValidLicense = async (_organizationId: string) => {
	return hasAnyPaidEditionFeature({ organizationId: _organizationId });
};
