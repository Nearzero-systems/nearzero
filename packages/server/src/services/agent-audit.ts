import { createAuditLog } from "@nearzero/server/services/proprietary/audit-log";
import type { AuditAction, AuditResourceType } from "@nearzero/server/db/schema";

export interface AgentAuditInput {
	organizationId: string;
	userId: string;
	userEmail: string;
	userRole: string;
	threadId?: string | null;
	action: AuditAction;
	resourceType: AuditResourceType;
	resourceId?: string;
	resourceName?: string;
	metadata?: Record<string, unknown>;
}

export async function auditAgentAction(input: AgentAuditInput): Promise<void> {
	await createAuditLog({
		organizationId: input.organizationId,
		userId: input.userId,
		userEmail: "Agent",
		userRole: "agent",
		action: input.action,
		resourceType: input.resourceType,
		resourceId: input.resourceId,
		resourceName: input.resourceName,
		metadata: {
			actorType: "agent",
			initiatedByUserId: input.userId,
			initiatedByUserEmail: input.userEmail,
			initiatedByUserRole: input.userRole,
			...(input.threadId ? { agentThreadId: input.threadId } : {}),
			...(input.metadata ?? {}),
		},
	});
}
