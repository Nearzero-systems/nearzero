export function isCommunityMode(): boolean {
	return process.env.COMMUNITY !== "false";
}

export function isCloudMode(): boolean {
	return !isCommunityMode();
}

export function requiresRemoteRuntimeServer(): boolean {
	return isCloudMode();
}
