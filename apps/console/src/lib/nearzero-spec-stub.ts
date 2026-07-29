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

function resolveFrameworkPresetLabel(preset: string): string {
	const match = FRAMEWORK_PRESETS.find(
		(option) => option.id === preset || option.label === preset,
	);
	return match?.label ?? (preset || "Other");
}

const SERVICE_PRESETS = new Set([
	"Next.js",
	"Nuxt",
	"Remix",
	"SvelteKit",
	"SolidStart",
	"Node.js",
	"NestJS",
	"Express",
	"Fastify",
	"Hono",
	"Python",
	"Django",
	"FastAPI",
	"Flask",
	"Go",
	"Rust",
	"PHP",
	"Laravel",
	"Ruby on Rails",
	"Java",
	".NET",
]);

export function getFrameworkPresetDefaults(preset: string) {
	const label = resolveFrameworkPresetLabel(preset);
	const suggestedType: DeployType =
		label === "Docker" || label === "Worker"
			? "container"
			: SERVICE_PRESETS.has(label)
				? "service"
				: "static";
	return {
		label,
		suggestedType,
		buildCommand: defaultBuildCommandForPreset(label),
		startCommand: defaultStartCommandForPreset(label),
		outputDirectory: defaultOutputDirForPreset(label),
	};
}

export function suggestDeployTypeFromPreset(preset: string): DeployType {
	return getFrameworkPresetDefaults(preset).suggestedType;
}

export function defaultOutputDirForPreset(_preset: string) {
	return "dist";
}

export function defaultBuildCommandForPreset(preset: string) {
	const label = resolveFrameworkPresetLabel(preset);
	if (label === "FastAPI" || label === "Django" || label === "Flask") {
		return "";
	}
	if (label === "Next.js") {
		return "npm run build";
	}
	return "bun run build";
}

export function defaultStartCommandForPreset(preset: string) {
	const label = resolveFrameworkPresetLabel(preset);
	if (label === "FastAPI") {
		return "python -m uvicorn main:app --host 0.0.0.0 --port 3000";
	}
	if (label === "Next.js") {
		return "npm run start";
	}
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
