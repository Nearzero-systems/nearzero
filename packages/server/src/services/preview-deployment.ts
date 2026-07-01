import { db } from "@nearzero/server/db";
import {
	type apiCreatePreviewDeployment,
	deployments,
	previewDeployments,
} from "@nearzero/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import type { z } from "zod";
import { generatePassword } from "../templates";
import { removeService } from "../utils/docker/utils";
import { removeDirectoryCode } from "../utils/filesystem/directory";
import { authGithub } from "../utils/providers/github";
import { removeTraefikConfig } from "../utils/traefik/application";
import { findApplicationById } from "./application";
import { removeDeploymentsByPreviewDeploymentId } from "./deployment";
import {
	ensurePreviewDeploymentDomain,
	resolvePreviewDomainPlan,
} from "./managed-domain-provision";
import { type Github, getIssueComment } from "./github";

export type PreviewDeployment = typeof previewDeployments.$inferSelect;

export const findPreviewDeploymentById = async (
	previewDeploymentId: string,
) => {
	const application = await db.query.previewDeployments.findFirst({
		where: eq(previewDeployments.previewDeploymentId, previewDeploymentId),
		with: {
			domain: true,
			application: {
				columns: {
					applicationId: true,
					serverId: true,
				},
			},
		},
	});
	if (!application) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Preview Deployment not found",
		});
	}
	return application;
};

export const removePreviewDeployment = async (previewDeploymentId: string) => {
	try {
		const previewDeployment =
			await findPreviewDeploymentById(previewDeploymentId);
		if (previewDeployment.domainId) {
			const { deleteManagedDnsRecordForDomain } = await import("./dns");
			await deleteManagedDnsRecordForDomain(previewDeployment.domainId);
		}
		const application = await findApplicationById(
			previewDeployment.applicationId,
		);

		application.appName = previewDeployment.appName;
		const cleanupOperations = [
			async () =>
				await removeService(application?.appName, application?.serverId),
			async () =>
				await removeDeploymentsByPreviewDeploymentId(previewDeployment),
			async () =>
				await removeDirectoryCode(application?.appName, application?.serverId),
			async () =>
				await removeTraefikConfig(application?.appName, application?.serverId),
			async () =>
				await db
					.delete(previewDeployments)
					.where(
						eq(previewDeployments.previewDeploymentId, previewDeploymentId),
					)
					.returning(),
		];
		for (const operation of cleanupOperations) {
			try {
				await operation();
			} catch (error) {
				console.error(error);
			}
		}
		return previewDeployment;
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "Error deleting this preview deployment";
		throw new TRPCError({
			code: "BAD_REQUEST",
			message,
		});
	}
};
// testing-tesoitnmg-ddq0ul-preview-ihl44o
export const updatePreviewDeployment = async (
	previewDeploymentId: string,
	previewDeploymentData: Partial<PreviewDeployment>,
) => {
	const application = await db
		.update(previewDeployments)
		.set({
			...previewDeploymentData,
		})
		.where(eq(previewDeployments.previewDeploymentId, previewDeploymentId))
		.returning();

	return application;
};

export const findPreviewDeploymentsByApplicationId = async (
	applicationId: string,
) => {
	const deploymentsList = await db.query.previewDeployments.findMany({
		where: eq(previewDeployments.applicationId, applicationId),
		orderBy: desc(previewDeployments.createdAt),
		with: {
			deployments: {
				orderBy: desc(deployments.createdAt),
			},
			domain: true,
		},
	});
	return deploymentsList;
};

export const createPreviewDeployment = async (
	schema: z.infer<typeof apiCreatePreviewDeployment>,
) => {
	const application = await findApplicationById(schema.applicationId);
	const appName = `preview-${application.appName}-${generatePassword(6)}`;
	const environment = application.environment;
	const domainPlan = await resolvePreviewDomainPlan({
		applicationId: application.applicationId,
		environmentId: environment.environmentId,
		serviceName: application.name,
		projectName: environment.project.name,
		pullRequestNumber: schema.pullRequestNumber,
		serverId: application.serverId,
		previewWildcard: application.previewWildcard,
		previewHttps: application.previewHttps,
		previewCertificateType: application.previewCertificateType,
	});
	const generateDomain = domainPlan.host;

	const octokit = authGithub(application?.github as Github);

	const previewUrl = `${domainPlan.https ? "https" : "http"}://${generateDomain}`;
	const dnsNote = environment.dnsZoneId
		? "\n\nManaged DNS and SSL will be provisioned for this preview."
		: "";
	const runningComment = getIssueComment(
		application.name,
		"initializing",
		previewUrl,
	);

	const issue = await octokit.rest.issues.createComment({
		owner: application?.owner || "",
		repo: application?.repository || "",
		issue_number: Number.parseInt(schema.pullRequestNumber),
		body: `### Nearzero Preview Deployment\n\n${runningComment}${dnsNote}\n\nPreview URL: ${previewUrl}`,
	});

	const previewDeployment = await db
		.insert(previewDeployments)
		.values({
			...schema,
			appName: appName,
			pullRequestCommentId: `${issue.data.id}`,
		})
		.returning()
		.then((value) => value[0]);

	if (!previewDeployment) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating the preview deployment",
		});
	}

	const newDomain = await ensurePreviewDeploymentDomain({
		previewDeploymentId: previewDeployment.previewDeploymentId,
		applicationId: application.applicationId,
		serviceName: application.name,
		environmentId: environment.environmentId,
		projectName: environment.project.name,
		appName,
		pullRequestNumber: schema.pullRequestNumber,
		port: application.previewPort ?? 3000,
		serverId: application.serverId,
		path: application.previewPath,
		previewWildcard: application.previewWildcard,
		previewHttps: application.previewHttps,
		previewCertificateType: application.previewCertificateType,
		previewCustomCertResolver: application.previewCustomCertResolver,
	});

	await db
		.update(previewDeployments)
		.set({
			domainId: newDomain.domainId,
		})
		.where(
			eq(
				previewDeployments.previewDeploymentId,
				previewDeployment.previewDeploymentId,
			),
		);

	return previewDeployment;
};

export const findPreviewDeploymentsByPullRequestId = async (
	pullRequestId: string,
) => {
	const previewDeploymentResult = await db.query.previewDeployments.findMany({
		where: eq(previewDeployments.pullRequestId, pullRequestId),
	});

	return previewDeploymentResult;
};

export const findPreviewDeploymentByApplicationId = async (
	applicationId: string,
	pullRequestId: string,
) => {
	const previewDeploymentResult = await db.query.previewDeployments.findFirst({
		where: and(
			eq(previewDeployments.applicationId, applicationId),
			eq(previewDeployments.pullRequestId, pullRequestId),
		),
	});

	return previewDeploymentResult;
};
