import {
	assertApplicationExecutionPlacement,
	findApplicationById,
	findServerById,
} from "@nearzero/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { myQueue } from "@/server/queues/queueSetup";
import { enqueueDeployment } from "@/server/utils/deploy";

vi.mock("@nearzero/server", () => ({
	assertApplicationExecutionPlacement: vi.fn(),
	findApplicationById: vi.fn(),
	findServerById: vi.fn(),
}));

vi.mock("@/server/queues/queueSetup", () => ({
	myQueue: {
		add: vi.fn(),
		getJobs: vi.fn(),
	},
}));

describe("enqueueDeployment", () => {
	const jobData = {
		applicationId: "app-1",
		titleLog: "Deploy",
		descriptionLog: "",
		type: "deploy" as const,
		applicationType: "application" as const,
		server: true,
		serverId: "server-1",
	};

	beforeEach(() => {
		vi.clearAllMocks();
		(findServerById as ReturnType<typeof vi.fn>).mockResolvedValue({
			serverId: "server-1",
			serverStatus: "active",
			setupStatus: "ready",
		});
		(findApplicationById as ReturnType<typeof vi.fn>).mockResolvedValue({
			applicationId: "app-1",
			serverId: "server-1",
		});
		(
			assertApplicationExecutionPlacement as ReturnType<typeof vi.fn>
		).mockReturnValue({
			mode: "cloud",
			buildServerId: "server-1",
			deployServerId: "server-1",
			buildLocation: "remote",
			requiresRegistryTransfer: false,
		});
		(myQueue.add as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: "job-1",
		});
	});

	it("queues deployments in the built-in worker", async () => {
		const result = await enqueueDeployment(jobData);

		expect(findServerById).toHaveBeenCalledWith("server-1");
		expect(myQueue.add).toHaveBeenCalledWith(
			"deployments",
			{
				...jobData,
				executionPlacement: {
					mode: "cloud",
					buildServerId: "server-1",
					deployServerId: "server-1",
					buildLocation: "remote",
					requiresRegistryTransfer: false,
				},
			},
			{
				removeOnComplete: true,
				removeOnFail: { age: 60 * 60 * 24, count: 100 },
				deduplication: { id: "application-app-1" },
			},
		);
		expect(result).toEqual({
			message: "Deployment queued",
			jobId: "job-1",
		});
	});

	it("deduplicates preview deployments independently", async () => {
		await enqueueDeployment({
			...jobData,
			applicationType: "application-preview",
			previewDeploymentId: "preview-1",
		});

		expect(myQueue.add).toHaveBeenCalledWith(
			"deployments",
			expect.objectContaining({
				applicationType: "application-preview",
				previewDeploymentId: "preview-1",
			}),
			expect.objectContaining({
				deduplication: { id: "application-preview-preview-1" },
			}),
		);
	});

	it("rejects inactive servers before queueing", async () => {
		(findServerById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			serverId: "server-1",
			serverStatus: "inactive",
			setupStatus: "ready",
		});

		await expect(enqueueDeployment(jobData)).rejects.toThrow(
			"Server is inactive",
		);
		expect(myQueue.add).not.toHaveBeenCalled();
	});

	it("rejects servers whose setup contract is not ready", async () => {
		(findServerById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			serverId: "server-1",
			serverStatus: "active",
			setupStatus: "failed",
		});

		await expect(enqueueDeployment(jobData)).rejects.toThrow(
			"Server setup is not ready",
		);
		expect(myQueue.add).not.toHaveBeenCalled();
	});
});
