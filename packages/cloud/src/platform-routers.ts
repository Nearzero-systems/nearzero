import type { AnyRouter } from "@trpc/server";
import { auditLogRouter } from "./routers/proprietary/audit-log";
import { customRoleRouter } from "./routers/proprietary/custom-role";
import { licenseKeyRouter } from "./routers/proprietary/license-key";
import { ssoRouter } from "./routers/proprietary/sso";
import { whitelabelingRouter } from "./routers/proprietary/whitelabeling";
import { stripeRouter } from "./routers/stripe";

export function getCloudPlatformRouters(): Record<string, AnyRouter> {
	return {
		stripe: stripeRouter,
		licenseKey: licenseKeyRouter,
		sso: ssoRouter,
		whitelabeling: whitelabelingRouter,
		customRole: customRoleRouter,
		auditLog: auditLogRouter,
	};
}
