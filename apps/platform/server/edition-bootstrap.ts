import { bootstrapCommunityEdition, assertCommunityOnlyMode } from "@nearzero/edition-community";

export function bootstrapEdition(): void {
	bootstrapCommunityEdition();
	assertCommunityOnlyMode();
}
