const ENABLED_MARKETING_HOME_VALUES = new Set(["true", "1", "yes", "on"]);

export function isEnabledMarketingHomeValue(
	value: string | null | undefined,
): boolean {
	return ENABLED_MARKETING_HOME_VALUES.has(value?.trim().toLowerCase() ?? "");
}

export function resolveMarketingHomeEnabled(
	runtimeValue: string | undefined,
	buildValue: string | undefined,
): boolean {
	return isEnabledMarketingHomeValue(runtimeValue ?? buildValue);
}

/**
 * The public marketing homepage is opt-in so self-hosted installations continue
 * to use `/` as their authenticated console entry point by default.
 */
export function isMarketingHomeEnabled(): boolean {
	const runtimeValue =
		typeof process !== "undefined"
			? process.env.NEARZERO_MARKETING_HOME
			: undefined;

	return resolveMarketingHomeEnabled(
		runtimeValue,
		import.meta.env.NEARZERO_MARKETING_HOME,
	);
}
