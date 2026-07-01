import { apiKeyClient } from "@better-auth/api-key/client";
import { ssoClient } from "@better-auth/sso/client";
import {
	adminClient,
	inferAdditionalFields,
	organizationClient,
	twoFactorClient,
} from "better-auth/client/plugins";
import { emailOTPClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/client";

export const authClient = createAuthClient({
	plugins: [
		organizationClient(),
		twoFactorClient(),
		apiKeyClient(),
		ssoClient(),
		adminClient(),
		emailOTPClient(),
		inferAdditionalFields({
			user: {
				lastName: {
					type: "string",
				},
			},
		}),
	],
});
