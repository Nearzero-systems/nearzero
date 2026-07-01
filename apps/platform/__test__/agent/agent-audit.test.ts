import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createAuditLog: vi.fn(),
}));

vi.mock("@nearzero/server/services/proprietary/audit-log", () => ({
	createAuditLog: mocks.createAuditLog,
}));

const { auditAgentAction } = await import(
	"@nearzero/server/services/agent-audit"
);

describe("agent audit attribution", () => {
	it("records Agent as the visible actor while retaining initiating user metadata", async () => {
		mocks.createAuditLog.mockResolvedValueOnce(undefined);

		await auditAgentAction({
			organizationId: "org-1",
			userId: "user-1",
			userEmail: "owner@example.com",
			userRole: "owner",
			threadId: "thread-1",
			action: "create",
			resourceType: "project",
			resourceId: "project-1",
			resourceName: "Paper",
			metadata: { policyAction: "agent.project.create" },
		});

		expect(mocks.createAuditLog).toHaveBeenCalledWith(
			expect.objectContaining({
				userEmail: "Agent",
				userRole: "agent",
				metadata: expect.objectContaining({
					actorType: "agent",
					initiatedByUserEmail: "owner@example.com",
					agentThreadId: "thread-1",
					policyAction: "agent.project.create",
				}),
			}),
		);
	});
});
