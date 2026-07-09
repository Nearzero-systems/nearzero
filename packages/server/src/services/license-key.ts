import { getEdition } from "@nearzero/edition-contract";

export const hasValidLicense = async (organizationId: string) =>
	getEdition().hasValidLicense(organizationId);

export const validateLicenseKey = async (_licenseKey: string) => ({
	valid: false,
	message: "License validation is not available in Community mode.",
});
