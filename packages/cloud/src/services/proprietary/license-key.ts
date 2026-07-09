import { hasAnyPaidEditionFeature } from "@nearzero/server/services/edition-policy";

export const hasValidLicense = async (_organizationId: string) => {
	return hasAnyPaidEditionFeature({ organizationId: _organizationId });
};
