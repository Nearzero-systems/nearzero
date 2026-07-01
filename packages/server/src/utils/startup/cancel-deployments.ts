import {
	applications,
	compose,
	deployments,
	previewDeployments,
} from "@nearzero/server/db/schema";
import { and, eq, lt } from "drizzle-orm";
import { db } from "../../db/index";
import { appendDeploymentLog } from "../../services/deployment-runner";

const getPositiveNumber = (value: string | undefined, fallback: number) => {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const STALE_DEPLOYMENT_TIMEOUT_MS = getPositiveNumber(
	process.env.STALE_DEPLOYMENT_TIMEOUT_MS,
	6 * 60 * 60 * 1000,
);
const STALE_DEPLOYMENT_WATCHDOG_INTERVAL_MS = getPositiveNumber(
	process.env.STALE_DEPLOYMENT_WATCHDOG_INTERVAL_MS,
	5 * 60 * 1000,
);

let staleDeploymentWatchdog: ReturnType<typeof setInterval> | null = null;

async function hasRunningDeploymentFor(
	field: "applicationId" | "composeId" | "previewDeploymentId",
	id: string,
) {
	const row = await db.query.deployments.findFirst({
		where: and(eq(deployments.status, "running"), eq(deployments[field], id)),
		columns: {
			deploymentId: true,
		},
	});
	return Boolean(row);
}

async function markOwnerErroredIfIdle(
	deployment: typeof deployments.$inferSelect,
) {
	if (deployment.applicationId) {
		if (
			await hasRunningDeploymentFor("applicationId", deployment.applicationId)
		) {
			return;
		}
		await db
			.update(applications)
			.set({ applicationStatus: "error" })
			.where(
				and(
					eq(applications.applicationId, deployment.applicationId),
					eq(applications.applicationStatus, "running"),
				),
			);
		return;
	}

	if (deployment.composeId) {
		if (await hasRunningDeploymentFor("composeId", deployment.composeId)) {
			return;
		}
		await db
			.update(compose)
			.set({ composeStatus: "error" })
			.where(
				and(
					eq(compose.composeId, deployment.composeId),
					eq(compose.composeStatus, "running"),
				),
			);
		return;
	}

	if (deployment.previewDeploymentId) {
		if (
			await hasRunningDeploymentFor(
				"previewDeploymentId",
				deployment.previewDeploymentId,
			)
		) {
			return;
		}
		await db
			.update(previewDeployments)
			.set({ previewStatus: "error" })
			.where(
				and(
					eq(
						previewDeployments.previewDeploymentId,
						deployment.previewDeploymentId,
					),
					eq(previewDeployments.previewStatus, "running"),
				),
			);
	}
}

export const expireStaleDeployments = async () => {
	const cutoff = new Date(Date.now() - STALE_DEPLOYMENT_TIMEOUT_MS).toISOString();
	const message = `Deployment exceeded the ${Math.round(
		STALE_DEPLOYMENT_TIMEOUT_MS / 60_000,
	)} minute stale timeout and was marked failed by the watchdog.`;

	const staleDeployments = await db
		.update(deployments)
		.set({
			status: "error",
			finishedAt: new Date().toISOString(),
			errorMessage: message,
		})
		.where(
			and(
				eq(deployments.status, "running"),
				lt(deployments.startedAt, cutoff),
			),
		)
		.returning();

	for (const deployment of staleDeployments) {
		await appendDeploymentLog({
			logPath: deployment.logPath,
			serverId: deployment.buildServerId ?? deployment.serverId,
			message: `\n${message}\n`,
		}).catch(() => undefined);
		await markOwnerErroredIfIdle(deployment).catch((error) => {
			console.error(
				`Failed to mark owner errored for stale deployment ${deployment.deploymentId}`,
				error,
			);
		});
	}

	if (staleDeployments.length > 0) {
		console.warn(`Expired ${staleDeployments.length} stale deployments`);
	}

	return staleDeployments.length;
};

export const initStaleDeploymentWatchdog = async () => {
	await expireStaleDeployments().catch((error) => {
		console.error("Failed to expire stale deployments on startup", error);
	});

	if (staleDeploymentWatchdog) return;
	staleDeploymentWatchdog = setInterval(() => {
		void expireStaleDeployments().catch((error) => {
			console.error("Failed to expire stale deployments", error);
		});
	}, STALE_DEPLOYMENT_WATCHDOG_INTERVAL_MS);
	staleDeploymentWatchdog.unref?.();
};

export const initCancelDeployments = async () => {
	try {
		console.log("Setting up cancel deployments....");

		const result = await db
			.update(deployments)
			.set({
				status: "cancelled",
			})
			.where(eq(deployments.status, "running"))
			.returning();

		console.log(`Cancelled ${result.length} deployments`);
	} catch (error) {
		console.error(error);
	}
};
