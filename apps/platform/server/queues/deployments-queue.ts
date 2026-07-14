import {
	DeploymentPhaseError,
	deployApplication,
	deployCompose,
	deployPreviewApplication,
	rebuildApplication,
	rebuildCompose,
	rebuildPreviewApplication,
	sanitizePublicErrorMessage,
	updateApplicationStatus,
	updateCompose,
	updatePreviewDeployment,
} from "@nearzero/server";
import { type Job, Worker } from "bullmq";
import type { ResolvedDeploymentJob } from "./queue-types";
import { redisConfig } from "./redis-connection";

const isDeploymentCancellation = (error: unknown) =>
	error instanceof DeploymentPhaseError &&
	error.code === "deployment_cancelled";

const markDeploymentJobErrored = async (
	job: Job<ResolvedDeploymentJob>,
	error: unknown,
) => {
	if (isDeploymentCancellation(error)) {
		if (job.data.applicationType === "application") {
			await updateApplicationStatus(job.data.applicationId, "idle");
		}
		if (job.data.applicationType === "application-preview") {
			await updatePreviewDeployment(job.data.previewDeploymentId, {
				previewStatus: "idle",
			});
		}
		return;
	}
	if (job.data.applicationType === "application") {
		await updateApplicationStatus(job.data.applicationId, "error");
		return;
	}

	if (job.data.applicationType === "compose") {
		await updateCompose(job.data.composeId, {
			composeStatus: "error",
		});
		return;
	}

	if (job.data.applicationType === "application-preview") {
		await updatePreviewDeployment(job.data.previewDeploymentId, {
			previewStatus: "error",
		});
	}
};

const createDeploymentWorker = () =>
	new Worker(
		"deployments",
		async (job: Job<ResolvedDeploymentJob>) => {
			try {
				if (job.data.applicationType === "application") {
					await updateApplicationStatus(job.data.applicationId, "running");

					if (job.data.type === "redeploy") {
						await rebuildApplication({
							applicationId: job.data.applicationId,
							titleLog: job.data.titleLog,
							descriptionLog: job.data.descriptionLog,
							placement: job.data.executionPlacement,
						});
					} else if (job.data.type === "deploy") {
						await deployApplication({
							applicationId: job.data.applicationId,
							titleLog: job.data.titleLog,
							descriptionLog: job.data.descriptionLog,
							placement: job.data.executionPlacement,
						});
					}
				} else if (job.data.applicationType === "compose") {
					await updateCompose(job.data.composeId, {
						composeStatus: "running",
					});
					if (job.data.type === "deploy") {
						await deployCompose({
							composeId: job.data.composeId,
							titleLog: job.data.titleLog,
							descriptionLog: job.data.descriptionLog,
						});
					} else if (job.data.type === "redeploy") {
						await rebuildCompose({
							composeId: job.data.composeId,
							titleLog: job.data.titleLog,
							descriptionLog: job.data.descriptionLog,
						});
					}
				} else if (job.data.applicationType === "application-preview") {
					await updatePreviewDeployment(job.data.previewDeploymentId, {
						previewStatus: "running",
					});

					if (job.data.type === "redeploy") {
						await rebuildPreviewApplication({
							applicationId: job.data.applicationId,
							titleLog: job.data.titleLog,
							descriptionLog: job.data.descriptionLog,
							previewDeploymentId: job.data.previewDeploymentId,
							placement: job.data.executionPlacement,
						});
					} else if (job.data.type === "deploy") {
						await deployPreviewApplication({
							applicationId: job.data.applicationId,
							titleLog: job.data.titleLog,
							descriptionLog: job.data.descriptionLog,
							previewDeploymentId: job.data.previewDeploymentId,
							placement: job.data.executionPlacement,
						});
					}
				}
			} catch (error) {
				try {
					await markDeploymentJobErrored(job, error);
				} catch (statusError) {
					console.error(
						"Failed to mark deployment job as errored:",
						sanitizePublicErrorMessage(statusError, "status update failed"),
					);
				}
				const publicFailure = isDeploymentCancellation(error)
					? "Deployment was cancelled"
					: sanitizePublicErrorMessage(
							error instanceof DeploymentPhaseError
								? error.toUserMessage()
								: error,
							"Deployment failed. Check the deployment logs.",
						);
				console.error("Deployment worker failed:", publicFailure);
				// BullMQ persists thrown messages as `failedReason`. Never attach the
				// original error/cause because it can contain SQL parameters, commands,
				// environment values, or provider credentials.
				throw new Error(publicFailure);
			}
		},
		{
			autorun: false,
			connection: redisConfig,
		},
	);
export const deploymentWorker = createDeploymentWorker();
