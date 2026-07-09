import { getEdition } from "@nearzero/edition-contract";
import type { AuditAction, AuditResourceType } from "@nearzero/server/db/schema";

export type { AuditAction, AuditResourceType };

export interface CreateAuditLogInput {
	organizationId: string;
	userId: string;
	userEmail: string;
	userRole: string;
	action: AuditAction;
	resourceType: AuditResourceType;
	resourceId?: string;
	resourceName?: string;
	metadata?: Record<string, unknown>;
}

/**
 * Creates an audit log entry when the active edition supports audit logs.
 * Fire-and-forget safe — errors are swallowed so logging never breaks the main operation.
 */
export const createAuditLog = async (input: CreateAuditLogInput) => {
	try {
		await getEdition().createAuditLog(input);
	} catch (err) {
		console.error("[audit-log] Failed to create audit log entry:", err);
	}
};
