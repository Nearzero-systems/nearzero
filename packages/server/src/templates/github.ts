import { parse } from "toml";

const DEFAULT_TEMPLATE_BASE_URL = "https://templates.nearzero.dev";
const TEMPLATE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function resolveTemplateBaseUrl(requested?: string) {
	const configured = process.env.NEARZERO_TEMPLATE_BASE_URL?.trim();
	const selected = requested?.trim() || configured || DEFAULT_TEMPLATE_BASE_URL;
	let normalized: string;
	try {
		const url = new URL(selected);
		if (url.username || url.password || url.search || url.hash) throw new Error();
		normalized = url.toString().replace(/\/$/, "");
	} catch {
		throw new Error("Invalid template source URL");
	}

	const allowed = [DEFAULT_TEMPLATE_BASE_URL, configured]
		.filter((value): value is string => Boolean(value))
		.map((value) => {
			try {
				return new URL(value).toString().replace(/\/$/, "");
			} catch {
				return "";
			}
		});
	if (!allowed.includes(normalized)) {
		throw new Error("Template source is not allowed");
	}
	return normalized;
}

function assertTemplateId(templateId: string) {
	if (!TEMPLATE_ID_PATTERN.test(templateId) || templateId.includes("..")) {
		throw new Error("Invalid template identifier");
	}
}

/**
 * Complete template interface that includes both metadata and configuration
 */
export interface CompleteTemplate {
	metadata: {
		id: string;
		name: string;
		description: string;
		tags: string[];
		version: string;
		logo: string;
		links: {
			github: string;
			website?: string;
			docs?: string;
		};
	};
	variables: {
		[key: string]: string;
	};
	config: {
		isolated?: boolean;
		domains: Array<{
			serviceName: string;
			port: number;
			path?: string;
			host?: string;
		}>;
		env: Record<string, string>;
		mounts?: Array<{
			filePath: string;
			content: string;
		}>;
	};
}

interface TemplateMetadata {
	id: string;
	name: string;
	description: string;
	version: string;
	logo: string;
	links: {
		github: string;
		website?: string;
		docs?: string;
	};
	tags: string[];
}

/**
 * Fetches the list of available templates from meta.json
 */
export async function fetchTemplatesList(
	baseUrl?: string,
): Promise<TemplateMetadata[]> {
	const templateBaseUrl = resolveTemplateBaseUrl(baseUrl);
	const response = await fetch(`${templateBaseUrl}/meta.json`, {
		signal: AbortSignal.timeout(10000),
	});
	if (!response.ok) {
		throw new Error(`Failed to fetch templates: ${response.statusText}`);
	}
	const templates = (await response.json()) as TemplateMetadata[];
	return templates.map((template) => ({
		id: template.id,
		name: template.name,
		description: template.description,
		version: template.version,
		logo: template.logo,
		links: template.links,
		tags: template.tags,
	}));
}

/**
 * Fetches a specific template's files
 */
export async function fetchTemplateFiles(
	templateId: string,
	baseUrl?: string,
): Promise<{ config: CompleteTemplate; dockerCompose: string }> {
	assertTemplateId(templateId);
	const templateBaseUrl = resolveTemplateBaseUrl(baseUrl);
	const timeout = AbortSignal.timeout(10000);
	const [templateYmlResponse, dockerComposeResponse] = await Promise.all([
		fetch(`${templateBaseUrl}/blueprints/${templateId}/template.toml`, {
			signal: timeout,
		}),
		fetch(`${templateBaseUrl}/blueprints/${templateId}/docker-compose.yml`, {
			signal: timeout,
		}),
	]);

	if (!templateYmlResponse.ok || !dockerComposeResponse.ok) {
		throw new Error("Template files not found");
	}

	const [templateYml, dockerCompose] = await Promise.all([
		templateYmlResponse.text(),
		dockerComposeResponse.text(),
	]);

	const config = parse(templateYml) as CompleteTemplate;

	return { config, dockerCompose };
}
