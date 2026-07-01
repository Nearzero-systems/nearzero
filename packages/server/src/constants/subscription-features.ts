import {
	EDITION_FEATURES,
	type EditionFeature,
	isEditionFeatureEnabled,
} from "../services/edition-policy";

/**
 * Subscription-gated product features.
 * Keep Community-core runtime features enabled; only paid product features map
 * to edition gates here.
 */
export const SUBSCRIPTION_FEATURES = {
	dockerLogs: "dockerLogs",
	dockerTerminal: "dockerTerminal",
	dockerStats: "dockerStats",
	hostTerminal: "hostTerminal",
	deploymentLogs: "deploymentLogs",
	hostSchedules: "hostSchedules",
	appMonitoring: "appMonitoring",
	deploymentCancel: "deploymentCancel",
	whitelabeling: "whitelabeling",
	infrastructure: "infrastructure",
} as const;

export type SubscriptionFeature =
	(typeof SUBSCRIPTION_FEATURES)[keyof typeof SUBSCRIPTION_FEATURES];

export type SubscriptionFeatureContext = {
	organizationId?: string | null;
	userId?: string | null;
};

const subscriptionEditionFeatureMap: Partial<
	Record<SubscriptionFeature, EditionFeature>
> = {
	whitelabeling: EDITION_FEATURES.whitelabeling,
};

/** Returns whether the active subscription includes this feature. */
export function isSubscriptionFeatureEnabled(
	feature: SubscriptionFeature,
	ctx?: SubscriptionFeatureContext,
): boolean {
	const editionFeature = subscriptionEditionFeatureMap[feature];
	if (editionFeature) {
		return isEditionFeatureEnabled(editionFeature, ctx);
	}
	return true;
}

/** UI helper — hide controls when the subscription does not include a feature. */
export function shouldHideSubscriptionFeature(
	feature: SubscriptionFeature,
	ctx?: SubscriptionFeatureContext,
): boolean {
	return !isSubscriptionFeatureEnabled(feature, ctx);
}
