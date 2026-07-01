import { EDITION_FEATURES } from "@nearzero/server/services/edition-policy";
import { getAuditLogs } from "@nearzero/server/services/proprietary/audit-log";
import { z } from "zod";
import {
	createTRPCRouter,
	paidFeatureMiddleware,
	withPermission,
} from "../../trpc";

export const auditLogRouter = createTRPCRouter({
	all: withPermission("auditLog", "read")
		.use(paidFeatureMiddleware(EDITION_FEATURES.auditLogs))
		.input(
			z.object({
				userId: z.string().optional(),
				search: z.string().optional(),
				userEmail: z.string().optional(),
				resourceName: z.string().optional(),
				action: z
					.enum([
						"create",
						"update",
						"delete",
						"deploy",
						"cancel",
						"redeploy",
						"login",
						"logout",
					])
					.optional(),
				resourceType: z
					.enum([
						"project",
						"service",
						"environment",
						"deployment",
						"user",
						"customRole",
						"domain",
						"certificate",
						"registry",
						"server",
						"sshKey",
						"gitProvider",
						"notification",
						"settings",
						"session",
					])
					.optional(),
				from: z.date().optional(),
				to: z.date().optional(),
				limit: z.number().min(1).max(500).default(50),
				offset: z.number().min(0).default(0),
			}),
		)
		.query(async ({ ctx, input }) => {
			return getAuditLogs({
				organizationId: ctx.session.activeOrganizationId,
				...input,
			});
		}),
});
