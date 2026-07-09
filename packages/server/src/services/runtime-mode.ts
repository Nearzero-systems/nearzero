import { getEdition, tryGetEdition } from "@nearzero/edition-contract";

export function isCommunityMode(): boolean {
	const edition = tryGetEdition();
	if (edition) {
		return edition.edition === "community";
	}
	return process.env.COMMUNITY !== "false";
}

export function isCloudMode(): boolean {
	return !isCommunityMode();
}

export function requiresRemoteRuntimeServer(): boolean {
	const edition = tryGetEdition();
	if (edition) {
		return edition.requiresRemoteRuntimeServer();
	}
	return process.env.COMMUNITY === "false";
}
