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

export const dockerNetworkInitialized = async () => {
	try {
		await getDocker().getNetwork("nearzero-network").inspect();
		return true;
	} catch {
		return false;
	}
};
