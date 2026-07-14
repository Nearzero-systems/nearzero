import { loginDockerRegistry } from "@nearzero/server/services/registry";
import type { ApplicationNested } from "../builders";

const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

export const buildRemoteDocker = async (
	application: ApplicationNested,
	buildServerId?: string | null,
) => {
	const { registryUrl, dockerImage, username, password } = application;

	try {
		if (!dockerImage) {
			throw new Error("Docker image not found");
		}
		if (username && password) {
			await loginDockerRegistry({
				registryUrl: registryUrl ?? undefined,
				username,
				password,
				serverId: buildServerId,
			});
		}

		const image = shellQuote(dockerImage);
		return `
echo "Pulling container image";
docker pull ${image} 2>&1 || {
  echo "❌ Pulling image failed";
  exit 1;
}

echo "✅ Pulling image completed.";
`;
	} catch (error) {
		throw error;
	}
};
