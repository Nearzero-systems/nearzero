/** Framework preset stubs for the projects flow (console-local). */

export type DeployType =
	| "static"
	| "serverless"
	| "image"
	| "server"
	| "service"
	| "worker"
	| "container";

export type FrameworkPresetOption = { id: string; label: string };

export type DeploySpec = Record<string, unknown>;

export const nearzeroSpecVersion = "v1" as const;
export const nearzeroDefaultRegion = "global" as const;

const FRAMEWORK_PRESETS: FrameworkPresetOption[] = [
	{ id: "astro", label: "Astro" },
	{ id: "nextjs", label: "Next.js" },
	{ id: "nuxt", label: "Nuxt" },
	{ id: "remix", label: "Remix" },
	{ id: "sveltekit", label: "SvelteKit" },
	{ id: "gatsby", label: "Gatsby" },
	{ id: "docusaurus", label: "Docusaurus" },
	{ id: "vite", label: "Vite" },
	{ id: "react", label: "React" },
	{ id: "vue", label: "Vue" },
	{ id: "angular", label: "Angular" },
	{ id: "solidstart", label: "SolidStart" },
	{ id: "nodejs", label: "Node.js" },
	{ id: "nestjs", label: "NestJS" },
	{ id: "express", label: "Express" },
	{ id: "fastify", label: "Fastify" },
	{ id: "hono", label: "Hono" },
	{ id: "docker", label: "Docker" },
	{ id: "worker", label: "Worker" },
	{ id: "python", label: "Python" },
	{ id: "django", label: "Django" },
	{ id: "fastapi", label: "FastAPI" },
	{ id: "flask", label: "Flask" },
	{ id: "go", label: "Go" },
	{ id: "rust", label: "Rust" },
	{ id: "php", label: "PHP" },
	{ id: "laravel", label: "Laravel" },
	{ id: "rails", label: "Ruby on Rails" },
	{ id: "java", label: "Java" },
	{ id: "dotnet", label: ".NET" },
	{ id: "other", label: "Other" },
];

export function listFrameworkPresetOptions(): FrameworkPresetOption[] {
	return FRAMEWORK_PRESETS;
}

export function getFrameworkPresetDefaults(preset: string) {
	const match = FRAMEWORK_PRESETS.find(
		(p) => p.id === preset || p.label === preset,
	);
	const label = match?.label ?? (preset || "Other");
	const suggestedType: DeployType =
		label === "Docker" || label === "Worker"
			? "container"
			: label === "Node.js" ||
				  label === "NestJS" ||
				  label === "Express" ||
				  label === "Fastify" ||
				  label === "Hono" ||
				  label === "Python" ||
				  label === "Django" ||
				  label === "FastAPI" ||
				  label === "Flask" ||
				  label === "Go" ||
				  label === "Rust" ||
				  label === "PHP" ||
				  label === "Laravel" ||
				  label === "Ruby on Rails" ||
				  label === "Java" ||
				  label === ".NET"
				? "service"
				: "static";
	return {
		label,
		suggestedType,
		buildCommand: "bun run build",
		startCommand: "bun run start",
		outputDirectory: "dist",
	};
}

export function suggestDeployTypeFromPreset(_preset: string): DeployType {
	return "static";
}

export function defaultOutputDirForPreset(_preset: string) {
	return "dist";
}

export function defaultBuildCommandForPreset(_preset: string) {
	return "bun run build";
}

export function defaultStartCommandForPreset(_preset: string) {
	return "bun run start";
}

export function createNearzeroSpec(input: Record<string, unknown>) {
	return input;
}

export function validateNearzeroSpec(_input: unknown) {
	return { valid: true, errors: [] as string[] };
}

export function normalizeNearzeroSpec(input: DeploySpec) {
	return input;
}
