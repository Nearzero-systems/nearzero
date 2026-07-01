import type { ApplicationExecutionPlacement } from "@nearzero/server";

type DeploymentJobBase = {
	titleLog: string;
	descriptionLog: string;
	server?: boolean;
	type: "deploy" | "redeploy";
	serverId?: string;
};

type ApplicationDeploymentJob = DeploymentJobBase & {
	applicationId: string;
	applicationType: "application";
};

type ComposeDeploymentJob = DeploymentJobBase & {
	composeId: string;
	applicationType: "compose";
};

type PreviewDeploymentJob = DeploymentJobBase & {
	applicationId: string;
	applicationType: "application-preview";
	previewDeploymentId: string;
};

export type DeploymentJob =
	| ApplicationDeploymentJob
	| ComposeDeploymentJob
	| PreviewDeploymentJob;

export type ResolvedDeploymentJob =
	| (ApplicationDeploymentJob & {
			executionPlacement: ApplicationExecutionPlacement;
	  })
	| ComposeDeploymentJob
	| (PreviewDeploymentJob & {
			executionPlacement: ApplicationExecutionPlacement;
	  });
