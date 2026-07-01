export type EnvPickRow = {
	environmentId: string;
	name: string;
	isDefault?: boolean | null;
};

/** Prefer development, then the default env, for project entry links. */
export function pickAccessibleEnvironment<T extends EnvPickRow>(
	environments: T[],
): T | undefined {
	if (environments.length === 0) return undefined;
	const byName = (name: string) =>
		environments.find(
			(env) => env.name.trim().toLowerCase() === name.toLowerCase(),
		);
	return (
		byName("development") ??
		environments.find((env) => env.isDefault) ??
		environments[0]
	);
}
