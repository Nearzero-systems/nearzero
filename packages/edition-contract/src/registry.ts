import type { EditionCapabilities } from "./types";

let activeEdition: EditionCapabilities | null = null;

export function setEdition(edition: EditionCapabilities): void {
	activeEdition = edition;
}

export function getEdition(): EditionCapabilities {
	if (!activeEdition) {
		throw new Error(
			"Edition capabilities are not initialized. Call bootstrapEdition() during platform startup.",
		);
	}
	return activeEdition;
}

export function tryGetEdition(): EditionCapabilities | null {
	return activeEdition;
}
