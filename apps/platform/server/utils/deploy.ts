import {
	assertApplicationExecutionPlacement,
	findApplicationById,
	findServerById,
} from "@nearzero/server";
import type {
	DeploymentJob,
	ResolvedDeploymentJob,
} from "../queues/queue-types";
import { myQueue } from "../queues/queueSetup";

const getDeploymentDeduplicationId = (jobData: ResolvedDeploymentJob) => {
	if (jobData.applicationType === "application-preview") {
		return `application-preview-${jobData.previewDeploymentId}`;
	}
	if (jobData.applicationType === "application") {
		return `application-${jobData.applicationId}`;
	}
	return undefined;
};

const addDeploymentJob = async (jobData: ResolvedDeploymentJob) => {
	const deduplicationId = getDeploymentDeduplicationId(jobData);
	const job = await myQueue.add(
		"deployments",
		{ ...jobData },
		{
			removeOnComplete: true,
			removeOnFail: { age: 60 * 60 * 24, count: 100 },
			...(deduplicationId ? { deduplication: { id: deduplicationId } } : {}),
		},
	);
	return { message: "Deployment queued", jobId: String(job.id) };
};

const assertRuntimeServerReady = async (serverId?: string | null) => {
	if (!serverId) return;
	const server = await findServerById(serverId);
	if (server.serverStatus === "inactive") {
		throw new Error("Server is inactive");
	}
	if (server.setupStatus !== "ready") {
		throw new Error(
			"Server setup is not ready. Complete and validate server setup before deploying.",
		);
	}
};

const resolveQueuedApplicationPlacement = async (
	jobData: DeploymentJob,
): Promise<ResolvedDeploymentJob> => {
	if (
		jobData.applicationType !== "application" &&
		jobData.applicationType !== "application-preview"
	) {
		await assertRuntimeServerReady(jobData.serverId);
		return jobData;
	}

	const application = await findApplicationById(jobData.applicationId);
	const executionPlacement = assertApplicationExecutionPlacement(application);
	const targetServerIds = new Set(
		[
			executionPlacement.buildServerId,
			executionPlacement.deployServerId,
		].filter((serverId): serverId is string => Boolean(serverId)),
	);

	for (const serverId of targetServerIds) {
		await assertRuntimeServerReady(serverId);
	}

	return {
		...jobData,
		serverId: executionPlacement.deployServerId ?? undefined,
		executionPlacement,
	};
};

export const enqueueDeployment = async (jobData: DeploymentJob) => {
	const resolvedJob = await resolveQueuedApplicationPlacement(jobData);
	return addDeploymentJob(resolvedJob);
};

type CancelDeploymentData =
	| { applicationId: string; applicationType: "application" }
	| { composeId: string; applicationType: "compose" };

export const cancelQueuedDeployment = async (
	cancelData: CancelDeploymentData,
) => {
	const jobs = await myQueue.getJobs(["waiting", "delayed"]);
	for (const job of jobs) {
		if (
			"applicationId" in cancelData &&
			job.data.applicationType !== "compose" &&
			job.data.applicationId === cancelData.applicationId
		) {
			await job.remove();
		}
		if (
			"composeId" in cancelData &&
			job.data.applicationType === "compose" &&
			job.data.composeId === cancelData.composeId
		) {
			await job.remove();
		}
	}

	return { message: "Deployment cancellation requested" };
};
