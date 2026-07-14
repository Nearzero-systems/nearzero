import { getDocker } from "@nearzero/server/constants";
import { db } from "@nearzero/server/db";
import {
	type apiCreateApplication,
	applications,
	buildAppName,
} from "@nearzero/server/db/schema";
import { getAdvancedStats } from "@nearzero/server/monitoring/utils";
import {
	getBuildCommand,
	mechanizeDockerContainer,
	resolveApplicationRuntimePort,
} from "@nearzero/server/utils/builders";
import { getBuildPathPreflightCommand } from "@nearzero/server/utils/builders/preflight";
import {
	getRailpackPackageManagerValidationCommand,
	getRailpackPrepareCommand,
	type RailpackPackageManager,
} from "@nearzero/server/utils/builders/railpack";
import {
	prepareBuildInput,
	wrapBuildCommand,
} from "@nearzero/server/utils/builders/utils";
import { SwarmServiceStabilityError } from "@nearzero/server/utils/docker/utils";
import { sendBuildErrorNotifications } from "@nearzero/server/utils/notifications/build-error";
import { sendBuildSuccessNotifications } from "@nearzero/server/utils/notifications/build-success";
import { cloneBitbucketRepository } from "@nearzero/server/utils/providers/bitbucket";
import { buildRemoteDocker } from "@nearzero/server/utils/providers/docker";
import {
	cloneGitRepository,
	getGitCommitInfo,
} from "@nearzero/server/utils/providers/git";
import { cloneGiteaRepository } from "@nearzero/server/utils/providers/gitea";
import { cloneGithubRepository } from "@nearzero/server/utils/providers/github";
import { cloneGitlabRepository } from "@nearzero/server/utils/providers/gitlab";
import { createTraefikConfig } from "@nearzero/server/utils/traefik/application";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import { getConsoleUrl } from "./admin";
import {
	createApplicationBuildPlan,
	fallbackApplicationBuildPlanToNixpacks,
} from "./application-build-plan";
import {
	type ApplicationExecutionPlacement,
	assertApplicationExecutionPlacement,
	assertApplicationExecutionPlacementSnapshot,
} from "./build-execution";
import {
	createDeployment,
	createDeploymentPreview,
	updateDeployment,
	updateDeploymentStatus,
} from "./deployment";
import {
	appendDeploymentLog,
	assertApplicationDeployCapabilities,
	type BuildPhase,
	DeploymentPhaseError,
	runDeploymentPhases,
} from "./deployment-runner";
import { type Domain, getDomainHost } from "./domain";
import {
	createPreviewDeploymentComment,
	getIssueComment,
	issueCommentExists,
	updateIssueComment,
} from "./github";
import { generateApplyPatchesCommand } from "./patch";
import {
	findPreviewDeploymentById,
	updatePreviewDeployment,
} from "./preview-deployment";
import { validUniqueServerAppName } from "./project";
export type Application = typeof applications.$inferSelect;

type ApplicationNested = Awaited<ReturnType<typeof findApplicationById>>;
type ApplicationBuildPlanResult = Awaited<
	ReturnType<typeof createApplicationBuildPlan>
>;
type ApplicationSourceCommand = { command: string; input?: string };

const resolveDeploymentPlacement = (
	application: Awaited<ReturnType<typeof findApplicationById>>,
	expected?: ApplicationExecutionPlacement,
) => {
	const current = assertApplicationExecutionPlacement(application);
	if (expected) {
		assertApplicationExecutionPlacementSnapshot(current, expected);
		return expected;
	}
	return current;
};

const getApplicationSourceCommand = async (
	application: ApplicationNested,
	placement: ApplicationExecutionPlacement,
): Promise<ApplicationSourceCommand> => {
	const target = { targetServerId: placement.buildServerId };
	if (application.sourceType === "github") {
		return cloneGithubRepository(application, target);
	}
	if (application.sourceType === "gitlab") {
		return cloneGitlabRepository(application, target);
	}
	if (application.sourceType === "gitea") {
		return cloneGiteaRepository(application, target);
	}
	if (application.sourceType === "bitbucket") {
		return cloneBitbucketRepository(application, target);
	}
	if (application.sourceType === "git") {
		return cloneGitRepository(application, target);
	}
	if (application.sourceType === "docker") {
		return {
			command: await buildRemoteDocker(application, placement.buildServerId),
		};
	}
	return { command: "" };
};

const getApplicationPreparationPhases = async (
	application: ApplicationNested,
	placement: ApplicationExecutionPlacement,
	options: { includeSource: boolean },
) => {
	const phases: BuildPhase[] = [];

	if (options.includeSource) {
		const source = await getApplicationSourceCommand(application, placement);
		if (source.command.trim()) {
			phases.push({
				id: "source",
				label:
					application.sourceType === "docker"
						? "Prepare image source"
						: "Fetch source",
				script: source.command,
				input: source.input,
				sensitiveValues: source.input ? [source.input] : undefined,
				errorCode: "source_fetch_failed",
				retryPolicy: "transient",
				timeoutSeconds: 900,
				requiredCapabilities:
					application.sourceType === "docker" ? ["docker"] : ["git"],
			});
		}
	}

	if (application.sourceType !== "docker") {
		const patchScript = await generateApplyPatchesCommand({
			id: application.applicationId,
			type: "application",
			serverId: placement.buildServerId,
		});
		if (patchScript.trim()) {
			phases.push({
				id: "patches",
				label: "Apply patches",
				script: patchScript,
				errorCode: "app_build_failed",
				timeoutSeconds: 120,
			});
		}

		phases.push({
			id: "preflight",
			label: "Validate build path",
			script: getBuildPathPreflightCommand(
				application,
				placement.buildServerId,
				"railpack",
			),
			errorCode: "build_path_missing",
			timeoutSeconds: 120,
		});
	}

	return phases;
};

const formatApplicationBuildPlanLog = (plan: ApplicationBuildPlanResult) => {
	const diagnostics = plan.diagnostics ?? [];
	const dockerfileAuthoritative =
		plan.selectedBuilder === "dockerfile" ||
		diagnostics.some(
			(diagnostic) => diagnostic.code === "dockerfile_authoritative",
		);
	const lines = [
		"Nearzero build detection",
		`- Selection mode: ${plan.selectionMode}`,
		`- Builder: ${plan.selectedBuilder}${plan.fallbackReason ? ` (${plan.fallbackReason})` : ""}`,
		`- Build authority: ${
			dockerfileAuthoritative
				? "repository Dockerfile"
				: "Nearzero managed builder"
		}`,
		`- Selected app: ${plan.selectedAppPath}`,
		`- Apps detected: ${plan.appCount}`,
		plan.framework ? `- Framework: ${plan.framework}` : null,
		plan.packageManager
			? `- ${dockerfileAuthoritative ? "Repository package-manager hint" : "Package manager"}: ${plan.packageManager}`
			: null,
		dockerfileAuthoritative
			? "- Nearzero will not override Dockerfile install, build, or start commands."
			: null,
		!dockerfileAuthoritative && plan.commands.install
			? `- Install: ${plan.commands.install}`
			: null,
		!dockerfileAuthoritative && plan.commands.build
			? `- Build: ${plan.commands.build}`
			: null,
		!dockerfileAuthoritative && plan.commands.start
			? `- Start: ${plan.commands.start}`
			: null,
		...diagnostics
			.filter((diagnostic) => diagnostic.code !== "dockerfile_authoritative")
			.map(
				(diagnostic) =>
					`- ${diagnostic.severity === "warning" ? "Warning" : "Info"}: ${diagnostic.message}`,
			),
		...plan.healingHints.map((hint) => `- Hint: ${hint}`),
	].filter(Boolean);
	return `${lines.join("\n")}\n`;
};

const isRailpackPackageManager = (
	value: string | null,
): value is RailpackPackageManager =>
	value === "npm" || value === "pnpm" || value === "yarn" || value === "bun";

const runApplicationBuildPipeline = async (input: {
	application: ApplicationNested;
	placement: ApplicationExecutionPlacement;
	deploymentId: string;
	logPath: string;
	includeSource: boolean;
}) => {
	const preparationPhases = await getApplicationPreparationPhases(
		input.application,
		input.placement,
		{ includeSource: input.includeSource },
	);
	if (preparationPhases.length > 0) {
		await runDeploymentPhases({
			deploymentId: input.deploymentId,
			logPath: input.logPath,
			serverId: input.placement.buildServerId,
			executionMode: input.placement.mode,
			executionLocation: input.placement.buildLocation,
			phases: preparationPhases,
		});
	}

	if (input.application.sourceType === "docker") {
		return;
	}

	let plan: Awaited<ReturnType<typeof createApplicationBuildPlan>>;
	try {
		plan = await createApplicationBuildPlan({
			application: input.application,
			buildServerId: input.placement.buildServerId,
		});
	} catch (cause) {
		throw new DeploymentPhaseError({
			code: "detection_failed",
			phaseId: "detect",
			phaseLabel: "Detect application build",
			message: "Nearzero could not inspect the checked-out application source.",
			cause,
		});
	}
	await updateDeployment(input.deploymentId, { buildPlan: plan });
	await appendDeploymentLog({
		logPath: input.logPath,
		serverId: input.placement.buildServerId,
		message: formatApplicationBuildPlanLog(plan),
	});

	if (plan.selectedBuilder === "railpack") {
		const railpackBuildInput = prepareBuildInput(input.application);
		const plannedPackageManager = isRailpackPackageManager(plan.packageManager)
			? plan.packageManager
			: null;
		const selectedTarget = plan.detectedApps.find(
			(target) => target.path === plan.selectedAppPath,
		);
		const railpackRequiresNode = Object.values(
			selectedTarget?.scripts ?? {},
		).some(
			(command) =>
				typeof command === "string" &&
				/(^|[\s;&|()])node(?=$|[\s;&|()])/.test(command),
		);
		try {
			await runDeploymentPhases({
				deploymentId: input.deploymentId,
				logPath: input.logPath,
				serverId: input.placement.buildServerId,
				executionMode: input.placement.mode,
				executionLocation: input.placement.buildLocation,
				phases: [
					{
						id: "plan",
						label: "Prepare Railpack build plan",
						script: wrapBuildCommand(
							getRailpackPrepareCommand(
								input.application,
								input.placement.buildServerId,
								plannedPackageManager,
							),
						),
						input: railpackBuildInput.input,
						sensitiveValues: railpackBuildInput.sensitiveValues,
						errorCode: "build_plan_failed",
						timeoutSeconds: 300,
						requiredCapabilities: ["railpack", "docker"],
					},
					...(plan.selectionMode === "automatic" && plannedPackageManager
						? [
								{
									id: "plan-contract",
									label: "Validate Railpack package-manager contract",
									script: getRailpackPackageManagerValidationCommand(
										input.application,
										input.placement.buildServerId,
										plannedPackageManager,
										railpackRequiresNode,
									),
									errorCode: "build_plan_failed" as const,
									timeoutSeconds: 60,
								},
							]
						: []),
				],
			});
		} catch (error) {
			if (
				!(error instanceof DeploymentPhaseError) ||
				error.code !== "build_plan_failed"
			) {
				throw error;
			}
			plan = fallbackApplicationBuildPlanToNixpacks(
				plan,
				"Railpack could not produce a compatible build plan.",
			);
			await updateDeployment(input.deploymentId, { buildPlan: plan });
			await appendDeploymentLog({
				logPath: input.logPath,
				serverId: input.placement.buildServerId,
				message:
					"Railpack planning failed before compilation. Retrying with Nixpacks.\n",
			});
		}
	}

	const preparedBuild = await getBuildCommand(input.application, {
		buildServerId: input.placement.buildServerId,
		buildType: plan.selectedBuilder,
		railpackPrepared: plan.selectedBuilder === "railpack",
	});
	await runDeploymentPhases({
		deploymentId: input.deploymentId,
		logPath: input.logPath,
		serverId: input.placement.buildServerId,
		executionMode: input.placement.mode,
		executionLocation: input.placement.buildLocation,
		phases: [
			{
				id: "build-target",
				label: "Validate selected build target",
				script: getBuildPathPreflightCommand(
					input.application,
					input.placement.buildServerId,
					plan.selectedBuilder,
				),
				errorCode: "build_path_missing",
				timeoutSeconds: 120,
			},
			{
				id: "build",
				label: `Build image with ${plan.selectedBuilder}`,
				script:
					typeof preparedBuild === "string"
						? preparedBuild
						: preparedBuild.script,
				...(typeof preparedBuild === "string"
					? {}
					: {
							input: preparedBuild.input,
							sensitiveValues: preparedBuild.sensitiveValues,
						}),
				errorCode: "app_build_failed",
				timeoutSeconds: 3600,
				// Image builds pull base images and Nix/registry layers over the
				// network, so transient infra failures (registry 5xx, SSH/network
				// drops, timeouts) are common. Retry ONLY those — real compile
				// errors are non-transient and fail immediately via the classifier.
				retryPolicy: "transient",
				requiredCapabilities: [plan.selectedBuilder, "docker"],
			},
		],
	});
};

const deployApplicationToPlacement = async (input: {
	application: ApplicationNested;
	placement: ApplicationExecutionPlacement;
	deploymentId: string;
	logPath: string;
	phaseLabel: string;
	failureMessage: string;
}) => {
	await assertApplicationDeployCapabilities({
		deploymentId: input.deploymentId,
		logPath: input.logPath,
		buildServerId: input.placement.buildServerId,
		deployServerId: input.placement.deployServerId,
		executionMode: input.placement.mode,
	});
	await appendDeploymentLog({
		logPath: input.logPath,
		serverId: input.placement.deployServerId,
		message: `\n--- ${input.phaseLabel} ---\n`,
	});
	try {
		await mechanizeDockerContainer(input.application, {
			deployServerId: input.placement.deployServerId,
			onProgress: async (progress) => {
				await appendDeploymentLog({
					logPath: input.logPath,
					serverId: input.placement.deployServerId,
					message: `${progress.message}\n`,
				}).catch(() => undefined);
			},
		});
		await appendDeploymentLog({
			logPath: input.logPath,
			serverId: input.placement.deployServerId,
			message:
				"✅ Service deployment completed on the selected application server.\n",
		});
	} catch (cause) {
		const healthFailure = cause instanceof SwarmServiceStabilityError;
		throw new DeploymentPhaseError({
			code: healthFailure ? "deploy_health_failed" : "service_deploy_failed",
			phaseId: healthFailure ? "health" : "deploy",
			phaseLabel: healthFailure
				? "Verify deployed service health"
				: input.phaseLabel,
			message: healthFailure
				? "The service was created, but its Swarm tasks did not become healthy."
				: input.failureMessage,
			cause,
		});
	}
};

const appendDeploymentFailure = async (input: {
	error: unknown;
	logPath: string;
	serverId?: string | null;
}) => {
	if (isDeploymentCancellation(input.error)) {
		await appendDeploymentLog({
			logPath: input.logPath,
			serverId: input.serverId,
			message: "\nDeployment cancelled by the user.\n",
		});
		return;
	}
	const code =
		input.error instanceof DeploymentPhaseError
			? input.error.code
			: "service_deploy_failed";
	const message =
		input.error instanceof Error ? input.error.message : String(input.error);
	await appendDeploymentLog({
		logPath: input.logPath,
		serverId: input.serverId,
		message: `\nDeployment failed. Code: ${code}\n${message}\n\nError occurred, check the logs for details.\n`,
	});
};

const isDeploymentCancellation = (error: unknown) =>
	error instanceof DeploymentPhaseError &&
	error.code === "deployment_cancelled";

const appendEnvironmentVariable = (
	value: string | null | undefined,
	key: string,
	variableValue: string,
) => [value?.trim(), `${key}=${variableValue}`].filter(Boolean).join("\n");

const persistDeploymentFailureDiagnostic = async (
	deploymentId: string,
	error: unknown,
) => {
	if (!(error instanceof DeploymentPhaseError) || !error.diagnostic) return;
	await updateDeployment(deploymentId, {
		errorMessage: error.diagnostic.message,
	});
};

const ensureDefaultDomainAfterDeploy = async (input: {
	serviceType: "application";
	serviceId: string;
	appName: string;
	port: number;
	logPath: string;
	serverId?: string | null;
}) => {
	try {
		const { ensureDefaultServiceDomain } = await import(
			"./managed-domain-provision"
		);
		const domain = await ensureDefaultServiceDomain({
			serviceType: input.serviceType,
			serviceId: input.serviceId,
			port: input.port,
			serverId: input.serverId,
		});
		await appendDeploymentLog({
			logPath: input.logPath,
			serverId: input.serverId,
			message: domain
				? `Public route configured: ${getDomainHost(domain)}\n`
				: "No public domain was assigned. The service is running remotely; add a domain to make it publicly reachable.\n",
		});
		if (domain) {
			const { verifyApplicationDomainRoute } = await import(
				"./managed-domain-provision"
			);
			const verification = await verifyApplicationDomainRoute({
				appName: input.appName,
				serverId: input.serverId,
				domain,
			});
			await appendDeploymentLog({
				logPath: input.logPath,
				serverId: input.serverId,
				message: `${verification.messages.join("\n")}\n`,
			}).catch(() => undefined);
		}
	} catch (error) {
		const rawMessage = error instanceof Error ? error.message : String(error);
		// Keep the deployment log readable: managed DNS being unconfigured is an
		// expected, non-fatal condition — the service is already running. Surface
		// a short reason (first line only) instead of dumping a full SQL query.
		const shortReason = rawMessage.split("\n")[0]?.slice(0, 200) ?? "";
		await appendDeploymentLog({
			logPath: input.logPath,
			serverId: input.serverId,
			message: `\nNo public domain was auto-assigned (managed DNS is not configured). The service is running — add a domain to make it publicly reachable.${
				shortReason ? `\nReason: ${shortReason}` : ""
			}\n`,
		}).catch(() => undefined);
	}
};

const ensurePreviewDomainAfterDeploy = async (input: {
	application: ApplicationNested;
	previewDeployment: Awaited<ReturnType<typeof findPreviewDeploymentById>>;
	port: number;
	logPath: string;
	serverId?: string | null;
}) => {
	try {
		const { ensurePreviewDeploymentDomain, verifyApplicationDomainRoute } =
			await import("./managed-domain-provision");
		const domain = await ensurePreviewDeploymentDomain({
			previewDeploymentId: input.previewDeployment.previewDeploymentId,
			applicationId: input.application.applicationId,
			serviceName: input.application.name,
			environmentId: input.application.environmentId,
			projectName: input.application.environment.project.name,
			appName: input.previewDeployment.appName,
			pullRequestNumber: input.previewDeployment.pullRequestNumber,
			port: input.port,
			serverId: input.serverId,
			path: input.application.previewPath,
			previewWildcard: input.application.previewWildcard,
			previewHttps: input.application.previewHttps,
			previewCertificateType: input.application.previewCertificateType,
			previewCustomCertResolver: input.application.previewCustomCertResolver,
		});
		await appendDeploymentLog({
			logPath: input.logPath,
			serverId: input.serverId,
			message: `Preview route configured: ${getDomainHost(domain)}\n`,
		});
		const verification = await verifyApplicationDomainRoute({
			appName: input.previewDeployment.appName,
			serverId: input.serverId,
			domain,
		});
		await appendDeploymentLog({
			logPath: input.logPath,
			serverId: input.serverId,
			message: `${verification.messages.join("\n")}\n`,
		}).catch(() => undefined);
		return domain;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await appendDeploymentLog({
			logPath: input.logPath,
			serverId: input.serverId,
			message: `\nPreview domain assignment skipped. Code: preview_domain_not_ready\n${message}\n`,
		}).catch(() => undefined);
		return input.previewDeployment.domain as Domain;
	}
};

const resolveRuntimePortAfterBuild = async (input: {
	application: ApplicationNested;
	placement: ApplicationExecutionPlacement;
	logPath: string;
}) => {
	await appendDeploymentLog({
		logPath: input.logPath,
		serverId: input.placement.buildServerId,
		message: "Detecting application runtime port...\n",
	});
	const port = await resolveApplicationRuntimePort(
		input.application,
		input.placement.buildServerId,
	);
	await appendDeploymentLog({
		logPath: input.logPath,
		serverId: input.placement.buildServerId,
		message: `Application runtime port detected: ${port}\n`,
	});
	return port;
};

export const createApplication = async (
	input: z.infer<typeof apiCreateApplication>,
) => {
	const appName = buildAppName("app", input.appName);

	const valid = await validUniqueServerAppName(appName);
	if (!valid) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Application with this 'AppName' already exists",
		});
	}

	return await db.transaction(async (tx) => {
		const newApplication = await tx
			.insert(applications)
			.values({
				...input,
				appName,
			})
			.returning({
				applicationId: applications.applicationId,
				name: applications.name,
				appName: applications.appName,
			})
			.then((value) => value[0]);

		if (!newApplication) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error creating the application",
			});
		}

		if (process.env.NODE_ENV === "development") {
			createTraefikConfig(newApplication.appName);
		}

		return newApplication;
	});
};

export const findApplicationById = async (applicationId: string) => {
	const application = await db.query.applications.findFirst({
		where: eq(applications.applicationId, applicationId),
		with: {
			environment: {
				with: {
					project: true,
				},
			},
			domains: true,
			deployments: true,
			mounts: true,
			redirects: true,
			security: true,
			ports: true,
			registry: true,
			gitlab: true,
			github: true,
			bitbucket: true,
			gitea: true,
			server: true,
			previewDeployments: true,
			rollbackRegistry: true,
		},
	});
	if (!application) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Application not found",
		});
	}
	return application;
};

export const findApplicationByName = async (appName: string) => {
	const application = await db.query.applications.findFirst({
		where: eq(applications.appName, appName),
	});

	return application;
};

export const updateApplication = async (
	applicationId: string,
	applicationData: Partial<Application>,
) => {
	const { appName, ...rest } = applicationData;
	const application = await db
		.update(applications)
		.set({
			...rest,
		})
		.where(eq(applications.applicationId, applicationId))
		.returning();

	return application[0];
};

export const updateApplicationStatus = async (
	applicationId: string,
	applicationStatus: Application["applicationStatus"],
) => {
	const application = await db
		.update(applications)
		.set({
			applicationStatus: applicationStatus,
		})
		.where(eq(applications.applicationId, applicationId))
		.returning();

	return application;
};

export const deployApplication = async ({
	applicationId,
	titleLog = "Manual deployment",
	descriptionLog = "",
	placement: expectedPlacement,
}: {
	applicationId: string;
	titleLog: string;
	descriptionLog: string;
	placement?: ApplicationExecutionPlacement;
}) => {
	const application = await findApplicationById(applicationId);
	const placement = resolveDeploymentPlacement(application, expectedPlacement);

	const buildLink = `${await getConsoleUrl()}/dashboard/project/${application.environment.projectId}/environment/${application.environmentId}/services/application/${application.applicationId}?tab=deployments`;
	const deployment = await createDeployment(
		{
			applicationId: applicationId,
			title: titleLog,
			description: descriptionLog,
		},
		placement,
	);

	try {
		await runApplicationBuildPipeline({
			application,
			placement,
			deploymentId: deployment.deploymentId,
			logPath: deployment.logPath,
			includeSource: true,
		});
		const runtimePort = await resolveRuntimePortAfterBuild({
			application,
			placement,
			logPath: deployment.logPath,
		});

		await deployApplicationToPlacement({
			application,
			placement,
			deploymentId: deployment.deploymentId,
			logPath: deployment.logPath,
			phaseLabel: "Deploy service",
			failureMessage: "Deploying the built image to Docker Swarm failed.",
		});
		await updateDeploymentStatus(deployment.deploymentId, "done");
		await updateApplicationStatus(applicationId, "done");
		await ensureDefaultDomainAfterDeploy({
			serviceType: "application",
			serviceId: applicationId,
			appName: application.appName,
			port: runtimePort,
			logPath: deployment.logPath,
			serverId: placement.deployServerId,
		});

		await sendBuildSuccessNotifications({
			projectName: application.environment.project.name,
			applicationName: application.name,
			applicationType: "application",
			buildLink,
			organizationId: application.environment.project.organizationId,
			domains: application.domains,
			environmentName: application.environment.name,
		});
	} catch (error) {
		await appendDeploymentFailure({
			error,
			logPath: deployment.logPath,
			serverId: placement.buildServerId,
		}).catch(() => undefined);
		const cancelled = isDeploymentCancellation(error);
		if (!cancelled) {
			await persistDeploymentFailureDiagnostic(
				deployment.deploymentId,
				error,
			).catch(() => undefined);
		}
		await updateDeploymentStatus(
			deployment.deploymentId,
			cancelled ? "cancelled" : "error",
		);
		await updateApplicationStatus(applicationId, cancelled ? "idle" : "error");

		if (!cancelled) {
			await sendBuildErrorNotifications({
				projectName: application.environment.project.name,
				applicationName: application.name,
				applicationType: "application",
				errorMessage: error instanceof Error ? error.message : "Error building",
				buildLink,
				organizationId: application.environment.project.organizationId,
			});
		}

		throw error;
	} finally {
		// Only extract commit info for non-docker sources
		if (application.sourceType !== "docker") {
			const commitInfo = await getGitCommitInfo({
				appName: application.appName,
				type: "application",
				serverId: placement.buildServerId,
			});
			if (commitInfo) {
				await updateDeployment(deployment.deploymentId, {
					title: commitInfo.message,
					description: `Commit: ${commitInfo.hash}`,
				});
			}
		}
	}
	return true;
};

export const rebuildApplication = async ({
	applicationId,
	titleLog = "Rebuild deployment",
	descriptionLog = "",
	placement: expectedPlacement,
}: {
	applicationId: string;
	titleLog: string;
	descriptionLog: string;
	placement?: ApplicationExecutionPlacement;
}) => {
	const application = await findApplicationById(applicationId);
	const placement = resolveDeploymentPlacement(application, expectedPlacement);
	const buildLink = `${await getConsoleUrl()}/dashboard/project/${application.environment.projectId}/environment/${application.environmentId}/services/application/${application.applicationId}?tab=deployments`;

	const deployment = await createDeployment(
		{
			applicationId: applicationId,
			title: titleLog,
			description: descriptionLog,
		},
		placement,
	);

	try {
		await runApplicationBuildPipeline({
			application,
			placement,
			deploymentId: deployment.deploymentId,
			logPath: deployment.logPath,
			includeSource: false,
		});
		const runtimePort = await resolveRuntimePortAfterBuild({
			application,
			placement,
			logPath: deployment.logPath,
		});
		await deployApplicationToPlacement({
			application,
			placement,
			deploymentId: deployment.deploymentId,
			logPath: deployment.logPath,
			phaseLabel: "Deploy service",
			failureMessage: "Deploying the rebuilt image to Docker Swarm failed.",
		});
		await updateDeploymentStatus(deployment.deploymentId, "done");
		await updateApplicationStatus(applicationId, "done");
		await ensureDefaultDomainAfterDeploy({
			serviceType: "application",
			serviceId: applicationId,
			appName: application.appName,
			port: runtimePort,
			logPath: deployment.logPath,
			serverId: placement.deployServerId,
		});

		await sendBuildSuccessNotifications({
			projectName: application.environment.project.name,
			applicationName: application.name,
			applicationType: "application",
			buildLink,
			organizationId: application.environment.project.organizationId,
			domains: application.domains,
			environmentName: application.environment.name,
		});
	} catch (error) {
		await appendDeploymentFailure({
			error,
			logPath: deployment.logPath,
			serverId: placement.buildServerId,
		}).catch(() => undefined);
		const cancelled = isDeploymentCancellation(error);
		if (!cancelled) {
			await persistDeploymentFailureDiagnostic(
				deployment.deploymentId,
				error,
			).catch(() => undefined);
		}
		await updateDeploymentStatus(
			deployment.deploymentId,
			cancelled ? "cancelled" : "error",
		);
		await updateApplicationStatus(applicationId, cancelled ? "idle" : "error");
		throw error;
	}

	return true;
};

export const deployPreviewApplication = async ({
	applicationId,
	titleLog = "Preview Deployment",
	descriptionLog = "",
	previewDeploymentId,
	placement: expectedPlacement,
}: {
	applicationId: string;
	titleLog: string;
	descriptionLog: string;
	previewDeploymentId: string;
	placement?: ApplicationExecutionPlacement;
}) => {
	const application = await findApplicationById(applicationId);
	const placement = resolveDeploymentPlacement(application, expectedPlacement);

	const deployment = await createDeploymentPreview(
		{
			title: titleLog,
			description: descriptionLog,
			previewDeploymentId: previewDeploymentId,
		},
		placement,
	);

	const previewDeployment =
		await findPreviewDeploymentById(previewDeploymentId);

	await updatePreviewDeployment(previewDeploymentId, {
		createdAt: new Date().toISOString(),
	});

	let previewDomain = getDomainHost(previewDeployment?.domain as Domain);
	const issueParams = {
		owner: application?.owner || "",
		repository: application?.repository || "",
		issue_number: previewDeployment.pullRequestNumber,
		comment_id: Number.parseInt(previewDeployment.pullRequestCommentId),
		githubId: application?.githubId || "",
	};
	try {
		const commentExists = await issueCommentExists({
			...issueParams,
		});
		if (!commentExists) {
			const result = await createPreviewDeploymentComment({
				...issueParams,
				previewDomain,
				appName: previewDeployment.appName,
				githubId: application?.githubId || "",
				previewDeploymentId,
			});

			if (!result) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Pull request comment not found",
				});
			}

			issueParams.comment_id = Number.parseInt(result?.pullRequestCommentId);
		}
		const buildingComment = getIssueComment(
			application.name,
			"running",
			previewDomain,
		);
		await updateIssueComment({
			...issueParams,
			body: `### Nearzero Preview Deployment\n\n${buildingComment}`,
		});
		const previewDeployUrl = previewDeployment.domain
			? getDomainHost(previewDeployment.domain as Domain)
			: "";
		application.appName = previewDeployment.appName;
		application.branch = previewDeployment.branch;
		application.env = appendEnvironmentVariable(
			application.previewEnv,
			"NEARZERO_DEPLOY_URL",
			previewDeployUrl,
		);
		application.buildArgs = appendEnvironmentVariable(
			application.previewBuildArgs,
			"NEARZERO_DEPLOY_URL",
			previewDeployUrl,
		);
		application.buildSecrets = appendEnvironmentVariable(
			application.previewBuildSecrets,
			"NEARZERO_DEPLOY_URL",
			previewDeployUrl,
		);
		application.rollbackActive = false;
		application.rollbackRegistry = null;
		application.registry = null;

		if (application.sourceType === "github") {
			await runApplicationBuildPipeline({
				application,
				placement,
				deploymentId: deployment.deploymentId,
				logPath: deployment.logPath,
				includeSource: true,
			});
			const runtimePort = await resolveRuntimePortAfterBuild({
				application,
				placement,
				logPath: deployment.logPath,
			});
			await deployApplicationToPlacement({
				application: {
					...application,
					appName: previewDeployment.appName,
				},
				placement,
				deploymentId: deployment.deploymentId,
				logPath: deployment.logPath,
				phaseLabel: "Deploy preview service",
				failureMessage: "Deploying the preview image to Docker Swarm failed.",
			});
			const domain = await ensurePreviewDomainAfterDeploy({
				application,
				previewDeployment,
				port: runtimePort,
				logPath: deployment.logPath,
				serverId: placement.deployServerId,
			});
			previewDomain = getDomainHost(domain);
		}
		const successComment = getIssueComment(
			application.name,
			"success",
			previewDomain,
		);
		await updateIssueComment({
			...issueParams,
			body: `### Nearzero Preview Deployment\n\n${successComment}`,
		});
		await updateDeploymentStatus(deployment.deploymentId, "done");
		await updatePreviewDeployment(previewDeploymentId, {
			previewStatus: "done",
		});
	} catch (error) {
		await appendDeploymentFailure({
			error,
			logPath: deployment.logPath,
			serverId: placement.buildServerId,
		}).catch(() => undefined);
		const cancelled = isDeploymentCancellation(error);
		if (!cancelled) {
			await persistDeploymentFailureDiagnostic(
				deployment.deploymentId,
				error,
			).catch(() => undefined);
		}
		if (!cancelled) {
			const comment = getIssueComment(application.name, "error", previewDomain);
			await updateIssueComment({
				...issueParams,
				body: `### Nearzero Preview Deployment\n\n${comment}`,
			});
		}
		await updateDeploymentStatus(
			deployment.deploymentId,
			cancelled ? "cancelled" : "error",
		);
		await updatePreviewDeployment(previewDeploymentId, {
			previewStatus: cancelled ? "idle" : "error",
		});
		throw error;
	}

	return true;
};

export const rebuildPreviewApplication = async ({
	applicationId,
	titleLog = "Rebuild Preview Deployment",
	descriptionLog = "",
	previewDeploymentId,
	placement: expectedPlacement,
}: {
	applicationId: string;
	titleLog: string;
	descriptionLog: string;
	previewDeploymentId: string;
	placement?: ApplicationExecutionPlacement;
}) => {
	const application = await findApplicationById(applicationId);
	const placement = resolveDeploymentPlacement(application, expectedPlacement);
	const previewDeployment =
		await findPreviewDeploymentById(previewDeploymentId);

	const deployment = await createDeploymentPreview(
		{
			title: titleLog,
			description: descriptionLog,
			previewDeploymentId: previewDeploymentId,
		},
		placement,
	);

	let previewDomain = getDomainHost(previewDeployment?.domain as Domain);
	const issueParams = {
		owner: application?.owner || "",
		repository: application?.repository || "",
		issue_number: previewDeployment.pullRequestNumber,
		comment_id: Number.parseInt(previewDeployment.pullRequestCommentId),
		githubId: application?.githubId || "",
	};

	try {
		const commentExists = await issueCommentExists({
			...issueParams,
		});
		if (!commentExists) {
			const result = await createPreviewDeploymentComment({
				...issueParams,
				previewDomain,
				appName: previewDeployment.appName,
				githubId: application?.githubId || "",
				previewDeploymentId,
			});

			if (!result) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Pull request comment not found",
				});
			}

			issueParams.comment_id = Number.parseInt(result?.pullRequestCommentId);
		}

		const buildingComment = getIssueComment(
			application.name,
			"running",
			previewDomain,
		);
		await updateIssueComment({
			...issueParams,
			body: `### Nearzero Preview Deployment\n\n${buildingComment}`,
		});

		// Set application properties for preview deployment
		const previewDeployUrl = previewDeployment.domain
			? getDomainHost(previewDeployment.domain as Domain)
			: "";
		application.appName = previewDeployment.appName;
		application.branch = previewDeployment.branch;
		application.env = appendEnvironmentVariable(
			application.previewEnv,
			"NEARZERO_DEPLOY_URL",
			previewDeployUrl,
		);
		application.buildArgs = appendEnvironmentVariable(
			application.previewBuildArgs,
			"NEARZERO_DEPLOY_URL",
			previewDeployUrl,
		);
		application.buildSecrets = appendEnvironmentVariable(
			application.previewBuildSecrets,
			"NEARZERO_DEPLOY_URL",
			previewDeployUrl,
		);
		application.rollbackActive = false;
		application.rollbackRegistry = null;
		application.registry = null;

		await runApplicationBuildPipeline({
			application,
			placement,
			deploymentId: deployment.deploymentId,
			logPath: deployment.logPath,
			includeSource: false,
		});
		const runtimePort = await resolveRuntimePortAfterBuild({
			application,
			placement,
			logPath: deployment.logPath,
		});
		await deployApplicationToPlacement({
			application,
			placement,
			deploymentId: deployment.deploymentId,
			logPath: deployment.logPath,
			phaseLabel: "Deploy preview service",
			failureMessage:
				"Deploying the rebuilt preview image to Docker Swarm failed.",
		});
		const domain = await ensurePreviewDomainAfterDeploy({
			application,
			previewDeployment,
			port: runtimePort,
			logPath: deployment.logPath,
			serverId: placement.deployServerId,
		});
		previewDomain = getDomainHost(domain);

		const successComment = getIssueComment(
			application.name,
			"success",
			previewDomain,
		);
		await updateIssueComment({
			...issueParams,
			body: `### Nearzero Preview Deployment\n\n${successComment}`,
		});
		await updateDeploymentStatus(deployment.deploymentId, "done");
		await updatePreviewDeployment(previewDeploymentId, {
			previewStatus: "done",
		});
	} catch (error) {
		await appendDeploymentFailure({
			error,
			logPath: deployment.logPath,
			serverId: placement.buildServerId,
		}).catch(() => undefined);

		const cancelled = isDeploymentCancellation(error);
		if (!cancelled) {
			await persistDeploymentFailureDiagnostic(
				deployment.deploymentId,
				error,
			).catch(() => undefined);
		}
		if (!cancelled) {
			const comment = getIssueComment(application.name, "error", previewDomain);
			await updateIssueComment({
				...issueParams,
				body: `### Nearzero Preview Deployment\n\n${comment}`,
			});
		}
		await updateDeploymentStatus(
			deployment.deploymentId,
			cancelled ? "cancelled" : "error",
		);
		await updatePreviewDeployment(previewDeploymentId, {
			previewStatus: cancelled ? "idle" : "error",
		});
		throw error;
	}

	return true;
};

export const getApplicationStats = async (appName: string) => {
	if (appName === "nearzero") {
		return await getAdvancedStats(appName);
	}
	const filter = {
		status: ["running"],
		label: [`com.docker.swarm.service.name=${appName}`],
	};

	const containers = await getDocker().listContainers({
		filters: JSON.stringify(filter),
	});

	const container = containers[0];
	if (!container || container?.State !== "running") {
		return null;
	}

	const data = await getAdvancedStats(appName);

	return data;
};
