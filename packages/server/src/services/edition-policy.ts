import {
	EDITION_FEATURES,
	EditionFeatureError,
	getEdition,
	getEditionFeatureLabel,
	type EditionFeature,
	type EditionFeatureContext,
	type RuntimeEdition,
} from "@nearzero/edition-contract";

export {
	EDITION_FEATURES,
	EditionFeatureError,
	getEditionFeatureLabel,
	type EditionFeature,
	type EditionFeatureContext,
	type RuntimeEdition,
};

export function getRuntimeEdition(): RuntimeEdition {
	return getEdition().edition;
}

export function isEditionFeatureEnabled(
	feature: EditionFeature,
	ctx?: EditionFeatureContext,
): boolean {
	return getEdition().isFeatureEnabled(feature, ctx);
}

export function requireEditionFeature(
	feature: EditionFeature,
	ctx?: EditionFeatureContext,
) {
	if (!isEditionFeatureEnabled(feature, ctx)) {
		throw new EditionFeatureError(feature, getEditionFeatureLabel(feature));
	}
}

export function hasAnyPaidEditionFeature(ctx?: EditionFeatureContext): boolean {
	return Object.values(EDITION_FEATURES).some((feature) =>
		isEditionFeatureEnabled(feature, ctx),
	);
}
