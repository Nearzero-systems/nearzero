import type { CreateServiceOptions } from "dockerode";
import { getDocker } from "../constants";
import { pullImage } from "../utils/docker/utils";
export const initializePostgres = async () => {
	const imageName = "postgres:16";
	const containerName = "nearzero-postgres";
	const settings: CreateServiceOptions = {
		Name: containerName,
		TaskTemplate: {
			ContainerSpec: {
				Image: imageName,
				Env: [
					"POSTGRES_USER=nearzero",
					"POSTGRES_DB=nearzero",
					`POSTGRES_PASSWORD=${process.env.POSTGRES_PASSWORD ?? "nearzero-local-password"}`,
				],
				Mounts: [
					{
						Type: "volume",
						Source: "nearzero-postgres",
						Target: "/var/lib/postgresql/data",
					},
				],
			},
			Networks: [{ Target: "nearzero-network" }],
			Placement: {
				Constraints: ["node.role==manager"],
			},
		},
		Mode: {
			Replicated: {
				Replicas: 1,
			},
		},
		...(process.env.NODE_ENV === "development" && {
			EndpointSpec: {
				Ports: [
					{
						TargetPort: 5432,
						PublishedPort: 5432,
						Protocol: "tcp",
						PublishMode: "host",
					},
				],
			},
		}),
	};
	try {
		await pullImage(imageName);

		const service = getDocker().getService(containerName);
		const inspect = await service.inspect();
		await service.update({
			version: Number.parseInt(inspect.Version.Index),
			...settings,
		});
		console.log("Postgres Started ✅");
	} catch (_) {
		try {
			await getDocker().createService(settings);
		} catch (error: any) {
			if (error?.statusCode !== 409) {
				throw error;
			}
			console.log("Postgres service already exists, continuing...");
		}
		console.log("Postgres Not Found: Starting ✅");
	}
};
