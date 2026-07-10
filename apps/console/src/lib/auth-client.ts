import { apiKeyClient } from "@better-auth/api-key/client";
import {
	adminClient,
	inferAdditionalFields,
	organizationClient,
	twoFactorClient,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/client";

export const authClient = createAuthClient({
	plugins: [
		organizationClient(),
		twoFactorClient(),
		apiKeyClient(),
		adminClient(),
		inferAdditionalFields({
			user: {
				lastName: {
					type: "string",
				},
			},
		}),
	],
});
