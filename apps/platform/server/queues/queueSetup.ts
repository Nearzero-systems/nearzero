import {
	execAsync,
	execAsyncRemote,
} from "@nearzero/server/utils/process/execAsync";
import type { Job } from "bullmq";
import { Queue } from "bullmq";
import { deploymentWorker } from "./deployments-queue";
import type { ResolvedDeploymentJob } from "./queue-types";
import { redisConfig } from "./redis-connection";


const myQueue = new Queue<ResolvedDeploymentJob>("deployments", {
	connection: redisConfig,
});

export const getJobsByApplicationId = async (applicationId: string) => {
	const jobs = await myQueue.getJobs();
	return jobs.filter(
		(job) =>
			job.data.applicationType !== "compose" &&
			job.data.applicationId === applicationId,
	);
};

export const getJobsByComposeId = async (composeId: string) => {
	const jobs = await myQueue.getJobs();
	return jobs.filter(
		(job) =>
			job.data.applicationType === "compose" &&
			job.data.composeId === composeId,
	);
};

const removableDeploymentStates = new Set([
	"waiting",
	"delayed",
	"paused",
	"prioritized",
	"waiting-children",
]);

/**
 * Prevent a queued deployment from racing a service/parent deletion.
 * Active jobs are never treated as cancelled merely because their abort signal
 * was requested: deployment processors may still be unwinding remote work.
 */
export const prepareDeploymentJobsForServiceDeletion = async (
	jobs: Job<ResolvedDeploymentJob>[],
) => {
	const states = await Promise.all(jobs.map((job) => job.getState()));
	if (states.includes("active")) return false;
	for (const [index, job] of jobs.entries()) {
		if (removableDeploymentStates.has(states[index] ?? "")) {
			await job.remove();
		}
	}
	return true;
};

process.on("SIGTERM", () => {
	myQueue.close();
	process.exit(0);
});

myQueue.on("error", (error) => {
	if ((error as any).code === "ECONNREFUSED") {
		console.error(
			"Redis connection failed. Set REDIS_URL in apps/platform/.env to your hosted Redis URL.",
			error,
		);
	}
});

export const cleanQueuesByApplication = async (applicationId: string) => {
	const jobs = await myQueue.getJobs(["waiting", "delayed"]);

	for (const job of jobs) {
		if (
			job.data.applicationType !== "compose" &&
			job.data.applicationId === applicationId
		) {
			await job.remove();
			console.log(`Removed job ${job.id} for application ${applicationId}`);
		}
	}
};

export const cleanAllDeploymentQueue = async () => {
	deploymentWorker.cancelAllJobs("User requested cancellation");
	return true;
};

export const cleanQueuesByCompose = async (composeId: string) => {
	const jobs = await myQueue.getJobs(["waiting", "delayed"]);

	for (const job of jobs) {
		if (
			job.data.applicationType === "compose" &&
			job.data.composeId === composeId
		) {
			await job.remove();
			console.log(`Removed job ${job.id} for compose ${composeId}`);
		}
	}
};

export const killDockerBuild = async (
	type: "compose",
	serverId: string | null,
) => {
	try {
		if (type === "compose") {
			const command = `pkill -2 -f "docker compose"`;

			if (serverId) {
				await execAsyncRemote(serverId, command);
			} else {
				await execAsync(command);
			}
		}
	} catch (error) {
		console.error(error);
	}
};

export { myQueue };
