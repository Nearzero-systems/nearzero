/** Browser-safe env for Astro client scripts. */
export const clientEnv = {
	PUBLIC_METRICS_URL: import.meta.env.PUBLIC_METRICS_URL ?? "",
	PUBLIC_METRICS_TOKEN: import.meta.env.PUBLIC_METRICS_TOKEN ?? "",
} as const;
