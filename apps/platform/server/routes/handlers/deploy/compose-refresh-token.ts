import { shouldDeploy } from "@nearzero/server";
import { db } from "@nearzero/server/db";
import { eq } from "drizzle-orm";
import type { ApiRequest, ApiResponse } from "@/server/types/api";
import { compose } from "@/server/db/schema";
import type { DeploymentJob } from "@/server/queues/queue-types";
import { enqueueDeployment } from "@/server/utils/deploy";
import {
	extractBranchName,
	extractCommitMessage,
	extractCommittedPaths,
	extractHash,
	getProviderByHeader,
	logWebhookError,
} from "./refresh-token";

export default async function handler(
	req: ApiRequest,
	res: ApiResponse,
) {
	const { refreshToken } = req.query;
	try {
		if (req.headers["x-github-event"] === "ping") {
			res.status(200).json({ message: "Ping received, webhook is active" });
			return;
		}
		const composeResult = await db.query.compose.findFirst({
			where: eq(compose.refreshToken, refreshToken as string),
			with: {
				environment: {
					with: {
						project: true,
					},
				},
				bitbucket: true,
			},
		});

		if (!composeResult) {
			res.status(404).json({ message: "Compose Not Found" });
			return;
		}
		if (!composeResult?.autoDeploy) {
			res.status(400).json({
				message: "Automatic deployments are disabled for this compose",
			});
			return;
		}

		const deploymentTitle = extractCommitMessage(req.headers, req.body);
		const deploymentHash = extractHash(req.headers, req.body);
		const sourceType = composeResult.sourceType;

		if (sourceType === "github") {
			const branchName = extractBranchName(req.headers, req.body);
			const normalizedCommits = req.body?.commits?.flatMap(
				(commit: any) => commit.modified,
			);

			const shouldDeployPaths = shouldDeploy(
				composeResult.watchPaths,
				normalizedCommits,
			);

			if (!shouldDeployPaths) {
				res.status(301).json({ message: "Watch Paths Not Match" });
				return;
			}

			if (!branchName || branchName !== composeResult.branch) {
				res.status(301).json({ message: "Branch Not Match" });
				return;
			}
		} else if (sourceType === "gitlab") {
			const branchName = extractBranchName(req.headers, req.body);
			const normalizedCommits = req.body?.commits?.flatMap(
				(commit: any) => commit.modified,
			);

			const shouldDeployPaths = shouldDeploy(
				composeResult.watchPaths,
				normalizedCommits,
			);

			if (!shouldDeployPaths) {
				res.status(301).json({ message: "Watch Paths Not Match" });
				return;
			}
			if (!branchName || branchName !== composeResult.gitlabBranch) {
				res.status(301).json({ message: "Branch Not Match" });
				return;
			}
		} else if (sourceType === "bitbucket") {
			const branchName = extractBranchName(req.headers, req.body);
			if (!branchName || branchName !== composeResult.bitbucketBranch) {
				res.status(301).json({ message: "Branch Not Match" });
				return;
			}

			const committedPaths = await extractCommittedPaths(
				req.body,
				composeResult.bitbucket,
				composeResult.bitbucketRepositorySlug ||
					composeResult.bitbucketRepository ||
					"",
			);

			const shouldDeployPaths = shouldDeploy(
				composeResult.watchPaths,
				committedPaths,
			);

			if (!shouldDeployPaths) {
				res.status(301).json({ message: "Watch Paths Not Match" });
				return;
			}
		} else if (sourceType === "git") {
			const branchName = extractBranchName(req.headers, req.body);
			if (!branchName || branchName !== composeResult.customGitBranch) {
				res.status(301).json({ message: "Branch Not Match" });
				return;
			}
			const provider = getProviderByHeader(req.headers);
			let normalizedCommits: string[] = [];

			if (provider === "github") {
				normalizedCommits = req.body?.commits?.flatMap(
					(commit: any) => commit.modified,
				);
			} else if (provider === "gitlab") {
				normalizedCommits = req.body?.commits?.flatMap(
					(commit: any) => commit.modified,
				);
			} else if (provider === "gitea") {
				normalizedCommits = req.body?.commits?.flatMap(
					(commit: any) => commit.modified,
				);
			}

			const shouldDeployPaths = shouldDeploy(
				composeResult.watchPaths,
				normalizedCommits,
			);

			if (!shouldDeployPaths) {
				res.status(301).json({ message: "Watch Paths Not Match" });
				return;
			}
		} else if (sourceType === "gitea") {
			const branchName = extractBranchName(req.headers, req.body);

			const normalizedCommits = req.body?.commits?.flatMap(
				(commit: any) => commit.modified,
			);

			const shouldDeployPaths = shouldDeploy(
				composeResult.watchPaths,
				normalizedCommits,
			);

			if (!shouldDeployPaths) {
				res.status(301).json({ message: "Watch Paths Not Match" });
				return;
			}

			if (!branchName || branchName !== composeResult.giteaBranch) {
				res.status(301).json({ message: "Branch Not Match" });
				return;
			}
		}

		try {
			const jobData: DeploymentJob = {
				composeId: composeResult.composeId as string,
				titleLog: deploymentTitle,
				type: "deploy",
				applicationType: "compose",
				descriptionLog: `Hash: ${deploymentHash}`,
				server: !!composeResult.serverId,
			};

			if (composeResult.serverId) {
				jobData.serverId = composeResult.serverId;
			}
			await enqueueDeployment(jobData);
		} catch (error) {
			logWebhookError("Error deploying Compose:", error);
			res.status(400).json({ message: "Error deploying Compose" });
			return;
		}

		res.status(200).json({ message: "Compose deployed successfully" });
	} catch (error) {
		logWebhookError("Error deploying Compose:", error);
		res.status(400).json({ message: "Error deploying Compose" });
	}
}
