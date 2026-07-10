import { getDocker } from "../constants";

export const initializeSwarm = async () => {
	const swarmInitialized = await dockerSwarmInitialized();
	if (swarmInitialized) {
		console.log("Swarm is already initialized");
	} else {
		await getDocker().swarmInit({
			AdvertiseAddr: "127.0.0.1",
			ListenAddr: "0.0.0.0",
		});
		console.log("Swarm was initialized");
	}
};

export const dockerSwarmInitialized = async () => {
	try {
		await getDocker().swarmInspect();

		return true;
	} catch {
		return false;
	}
};

export const initializeNetwork = async () => {
	const networkInitialized = await dockerNetworkInitialized();
	if (networkInitialized) {
		console.log("Network is already initialized");
	} else {
		await getDocker().createNetwork({
			Attachable: true,
			Name: "nearzero-network",
			Driver: "overlay",
		});
		console.log("Network was initialized");
	}
};

/**
 * Attach the combined self-hosted container to Traefik's network. The stable
 * alias lets the file provider route both the console and its API proxy
 * without depending on a Compose-generated container name.
 */
export const connectCurrentContainerToNetwork = async () => {
	const containerId = process.env.HOSTNAME?.trim();
	if (!containerId) return;

	const network = getDocker().getNetwork("nearzero-network");
	try {
		const details = await network.inspect();
		const alreadyConnected = Object.keys(details.Containers ?? {}).some(
			(id) => id === containerId || id.startsWith(containerId),
		);
		if (alreadyConnected) return;

		await network.connect({
			Container: containerId,
			EndpointConfig: { Aliases: ["nearzero"] },
		});
		console.log("Nearzero container connected to nearzero-network");
	} catch (error) {
		console.error("Could not connect Nearzero to nearzero-network", error);
		throw error;
	}
};

export const dockerNetworkInitialized = async () => {
	try {
		await getDocker().getNetwork("nearzero-network").inspect();
		return true;
	} catch {
		return false;
	}
};
