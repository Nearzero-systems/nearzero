import { findAllDeploymentsByApplicationId } from "@nearzero/server/services/deployment";
import {
	loginDockerRegistry,
	type Registry,
} from "@nearzero/server/services/registry";
import { createRollback } from "@nearzero/server/services/rollbacks";
import type { ApplicationNested } from "../builders";

export const uploadImageRemoteCommand = async (
	application: ApplicationNested,
	buildServerId?: string | null,
) => {
	const registry = application.registry;
	const rollbackRegistry = application.rollbackRegistry;

	if (!registry && !rollbackRegistry) {
		throw new Error("No registry found");
	}

	const { appName } = application;
	const imageName =
		application.sourceType === "docker"
			? application.dockerImage || ""
			: `${appName}:latest`;

	const commands: string[] = [];
	if (registry) {
		const registryTag = getRegistryTag(registry, imageName);
		if (registryTag) {
			await loginDockerRegistry({
				registryUrl: registry.registryUrl,
				username: registry.username,
				password: registry.password,
				serverId: buildServerId,
			});
			commands.push(`echo "📦 [Enabled Registry Swarm]"`);
			commands.push(getRegistryCommands(imageName, registryTag));
		}
	}

	if (rollbackRegistry && application.rollbackActive) {
		const deployment = await findAllDeploymentsByApplicationId(
			application.applicationId,
		);
		if (!deployment || !deployment[0]) {
			throw new Error("Deployment not found");
		}
		const deploymentId = deployment[0].deploymentId;
		const rollback = await createRollback({
			appName: appName,
			deploymentId: deploymentId,
		});

		const rollbackRegistryTag = getRegistryTag(
			rollbackRegistry,
			rollback?.image || "",
		);
		if (rollbackRegistryTag) {
			await loginDockerRegistry({
				registryUrl: rollbackRegistry.registryUrl,
				username: rollbackRegistry.username,
				password: rollbackRegistry.password,
				serverId: buildServerId,
			});
			commands.push(`echo "🔄 [Enabled Rollback Registry]"`);
			commands.push(
				getRegistryCommands(imageName, rollbackRegistryTag),
			);
		}
	}
	try {
		return commands.join("\n");
	} catch (error) {
		throw error;
	}
};
/**
 * Extract the repository name from imageName by taking the last part after '/'
 * Examples:
 * - "nginx" -> "nginx"
 * - "nginx:latest" -> "nginx:latest"
 * - "myuser/myrepo" -> "myrepo"
 * - "myuser/myrepo:tag" -> "myrepo:tag"
 * - "docker.io/myuser/myrepo" -> "myrepo"
 */
const extractRepositoryName = (imageName: string): string => {
	const lastSlashIndex = imageName.lastIndexOf("/");

	// If no '/', return the imageName as is
	if (lastSlashIndex === -1) {
		return imageName;
	}

	// Extract everything after the last '/'
	return imageName.substring(lastSlashIndex + 1);
};

export const getRegistryTag = (registry: Registry, imageName: string) => {
	const { registryUrl, imagePrefix, username } = registry;

	// Extract the repository name (last part after '/')
	const repositoryName = extractRepositoryName(imageName);

	// Build the final tag using registry's username/prefix (must be lowercase for valid image refs)
	const targetPrefix = (imagePrefix || username).toLowerCase();
	const finalRegistry = registryUrl || "";

	return finalRegistry
		? `${finalRegistry}/${targetPrefix}/${repositoryName}`
		: `${targetPrefix}/${repositoryName}`;
};

const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

const getRegistryCommands = (imageName: string, registryTag: string): string => {
	const source = shellQuote(imageName);
	const target = shellQuote(registryTag);
	return `
echo "📦 [Enabled Registry] Uploading image" ;
docker tag ${source} ${target} || {
	echo "❌ Error tagging image" ;
	exit 1;
}
echo "✅ Image Tagged" ;
docker push ${target} || {
	echo "❌ Error pushing image" ;
	exit 1;
}
echo "✅ Image Pushed" ;
`;
};
