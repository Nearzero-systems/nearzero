import {
	EDITION_FEATURES,
	type EditionFeature,
	isEditionFeatureEnabled,
} from "@/lib/edition-policy";

/**
 * Client-side subscription feature visibility.
 * Mirror server gates here for nav/UI hiding — do not delete gated UI, only hide it.
 */
export type SubscriptionFeature =
	| "dockerLogs"
	| "dockerTerminal"
	| "dockerStats"
	| "hostTerminal"
	| "deploymentLogs"
	| "hostSchedules"
	| "appMonitoring"
	| "deploymentCancel"
	| "whitelabeling"
	| "infrastructure";

const subscriptionEditionFeatureMap: Partial<
	Record<SubscriptionFeature, EditionFeature>
> = {
	whitelabeling: EDITION_FEATURES.whitelabeling,
};

export function isSubscriptionFeatureEnabled(
	feature: SubscriptionFeature,
): boolean {
	const editionFeature = subscriptionEditionFeatureMap[feature];
	if (editionFeature) {
		return isEditionFeatureEnabled(editionFeature);
	}
	return true;
}

export function shouldHideSubscriptionFeature(
	feature: SubscriptionFeature,
): boolean {
	return !isSubscriptionFeatureEnabled(feature);
}
