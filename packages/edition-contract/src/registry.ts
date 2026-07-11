import type { EditionCapabilities } from "./types";

const EDITION_REGISTRY_KEY = "__nearzeroEditionCapabilities_v1__" as const;
type EditionGlobal = typeof globalThis & {
	[EDITION_REGISTRY_KEY]?: EditionCapabilities;
};

function editionGlobal() {
	return globalThis as EditionGlobal;
}

export function setEdition(edition: EditionCapabilities): void {
	editionGlobal()[EDITION_REGISTRY_KEY] = edition;
}

export function getEdition(): EditionCapabilities {
	const activeEdition = editionGlobal()[EDITION_REGISTRY_KEY];
	if (!activeEdition) {
		throw new Error(
			"Edition capabilities are not initialized. Call bootstrapEdition() during platform startup.",
		);
	}
	return activeEdition;
}

export function tryGetEdition(): EditionCapabilities | null {
	return editionGlobal()[EDITION_REGISTRY_KEY] ?? null;
}
