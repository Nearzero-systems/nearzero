import { beforeEach, describe, expect, it, vi } from "vitest";

let serverRow:
	| {
			serverId: string;
			organizationId: string;
			name: string;
			serverStatus: "active" | "inactive";
			setupStatus: "not_started" | "running" | "ready" | "failed";
	  }
	| undefined;

vi.mock("@nearzero/edition-contract", async (importOriginal) => ({
	...(await importOriginal<typeof import("@nearzero/edition-contract")>()),
	tryGetEdition: () => null,
}));

vi.mock("@nearzero/server/db", () => ({
	db: {
		query: {
			server: {
				findFirst: vi.fn(() => Promise.resolve(serverRow)),
				findMany: vi.fn(() => Promise.resolve([])),
			},
		},
	},
}));

vi.mock("@nearzero/server/services/audit-log", () => ({
	createAuditLog: vi.fn(() => Promise.resolve()),
}));

const { evaluateRuntimePlacementPolicy } = await import(
	"@nearzero/server/services/runtime-policy"
);

const actor = {
	organizationId: "org-1",
	userId: "user-1",
	userEmail: "owner@example.com",
	userRole: "owner",
} as const;

beforeEach(() => {
	serverRow = undefined;
});

describe("Community remote runtime placement", () => {
	it("allows the local runtime when no remote server is selected", async () => {
		const result = await evaluateRuntimePlacementPolicy(actor, "domain.assign");
		expect(result.allowed).toBe(true);
	});

	it("rejects a selected server owned by another organization", async () => {
		serverRow = {
			serverId: "server-2",
			organizationId: "org-2",
			name: "Other tenant server",
			serverStatus: "active",
			setupStatus: "ready",
		};
		const result = await evaluateRuntimePlacementPolicy(
			actor,
			"domain.assign",
			{ serverId: "server-2" },
		);
		expect(result.allowed).toBe(false);
		expect(result.code).toBe("server_missing");
	});

	it("rejects an explicit remote server until setup is ready", async () => {
		serverRow = {
			serverId: "server-1",
			organizationId: "org-1",
			name: "Pending server",
			serverStatus: "active",
			setupStatus: "running",
		};
		const result = await evaluateRuntimePlacementPolicy(
			actor,
			"domain.assign",
			{ serverId: "server-1" },
		);
		expect(result.allowed).toBe(false);
		expect(result.code).toBe("server_not_ready");
	});

	it("allows a ready server owned by the active organization", async () => {
		serverRow = {
			serverId: "server-1",
			organizationId: "org-1",
			name: "Ready server",
			serverStatus: "active",
			setupStatus: "ready",
		};
		const result = await evaluateRuntimePlacementPolicy(
			actor,
			"domain.assign",
			{ serverId: "server-1" },
		);
		expect(result.allowed).toBe(true);
		expect(result.code).toBe("ok");
	});
});
