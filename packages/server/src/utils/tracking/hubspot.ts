import { tryGetEdition } from "@nearzero/edition-contract";

interface HubSpotFormField {
	objectTypeId: string;
	name: string;
	value: string;
}

interface HubSpotFormData {
	fields: HubSpotFormField[];
	context: {
		pageUri: string;
		pageName: string;
		hutk?: string;
	};
}

interface SignUpFormData {
	firstName?: string;
	lastName?: string;
	email?: string;
}

export function getHubSpotUTK(cookieHeader?: string): string | null {
	if (!cookieHeader) return null;

	const name = "hubspotutk=";
	const decodedCookie = decodeURIComponent(cookieHeader);
	const cookieArray = decodedCookie.split(";");

	for (let i = 0; i < cookieArray.length; i++) {
		const cookie = cookieArray[i]?.trim();
		if (!cookie) continue;
		if (cookie.indexOf(name) === 0) {
			return cookie.substring(name.length, cookie.length);
		}
	}
	return null;
}

export function formatContactDataForHubSpot(
	contactData: SignUpFormData,
	hutk?: string | null,
): HubSpotFormData {
	const formData: HubSpotFormData = {
		fields: [
			{
				objectTypeId: "0-1",
				name: "firstname",
				value: contactData.firstName || "",
			},
			{
				objectTypeId: "0-1",
				name: "lastname",
				value: contactData.lastName || "",
			},
			{
				objectTypeId: "0-1",
				name: "email",
				value: contactData.email || "",
			},
		],
		context: {
			pageUri: "https://app.nearzero.dev/register",
			pageName: "Sign Up",
		},
	};

	if (hutk) {
		formData.context.hutk = hutk;
	}

	return formData;
}

/** Community edition does not submit signup data to hosted CRM integrations. */
export async function submitToHubSpot(
	_contactData: SignUpFormData,
	_cookieHeader?: string,
): Promise<boolean> {
	const edition = tryGetEdition();
	if (!edition || edition.edition === "community") {
		return true;
	}
	return false;
}
