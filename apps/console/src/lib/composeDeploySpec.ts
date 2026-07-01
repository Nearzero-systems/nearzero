import type { DeploySpec, DeployType } from "@nearzero/spec";
import {
  defaultBuildCommandForPreset,
  defaultOutputDirForPreset,
  defaultStartCommandForPreset,
  getFrameworkPresetDefaults,
  nearzeroDefaultRegion,
  nearzeroSpecVersion,
  normalizeNearzeroSpec,
  suggestDeployTypeFromPreset,
  validateNearzeroSpec,
} from "@nearzero/spec";

export type ComposeDeployWizardInput = {
  projectName: string;
  preset: string;
  suggestedType?: string;
  root: string;
  buildCommand: string;
  outputDir: string;
  envEntries: Array<{ key: string; value: string }>;
};

function parseSuggestedType(value: string): DeployType | undefined {
  const normalized = String(value || "").trim().toLowerCase();
  if (
    normalized === "static" ||
    normalized === "service" ||
    normalized === "worker" ||
    normalized === "container" ||
    normalized === "serverless"
  ) {
    return normalized;
  }
  return undefined;
}

function envRecordFromEntries(
  entries: Array<{ key: string; value: string }>,
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const e of entries) {
    const k = String(e?.key || "").trim();
    if (!k) continue;
    out[k] = String(e?.value ?? "");
  }
  return Object.keys(out).length ? out : undefined;
}

/** Builds a validated Nearzero deploy spec from the console “new project” wizard fields. */
export function buildComposeDeploySpec(
  input: ComposeDeployWizardInput,
): { spec: DeploySpec | null; errors: string[] } {
  const name = String(input.projectName || "").trim();
  if (!name) {
    return { spec: null, errors: ["projectName is required"] };
  }

  const presetDefaults = getFrameworkPresetDefaults(String(input.preset || "Other").trim() || "Other");
  const preset = presetDefaults.label;
  const type =
    parseSuggestedType(String(input.suggestedType || "")) ||
    presetDefaults.suggestedType ||
    suggestDeployTypeFromPreset(preset);
  const rootRaw = String(input.root ?? ".").trim() || ".";
  const root = rootRaw === "." ? undefined : rootRaw;
  const buildCmd = String(input.buildCommand || "").trim();
  const defaultBuild = defaultBuildCommandForPreset(preset);
  const defaultStart = defaultStartCommandForPreset(preset);
  const defaultOutput = defaultOutputDirForPreset(preset);
  const output = String(input.outputDir || defaultOutput).trim() || defaultOutput;
  const env = envRecordFromEntries(
    Array.isArray(input.envEntries) ? input.envEntries : [],
  );

  const projectMeta =
    preset === "Other"
      ? undefined
      : { framework: preset, detectedAt: new Date().toISOString() };

  let draft: DeploySpec = {
    version: nearzeroSpecVersion,
    name,
    type,
    region: nearzeroDefaultRegion,
    ...(root ? { root } : {}),
    ...(env ? { env } : {}),
    ...(projectMeta ? { project: projectMeta } : {}),
  };

  const resolvedBuildCommand = buildCmd || defaultBuild;

  if (type === "static") {
    draft = {
      ...draft,
      build: {
        command: resolvedBuildCommand || "npm run build",
        output,
      },
      assets: {
        publicDir: output,
        cacheControl: "public, max-age=31536000, immutable",
      },
    };
  } else if (type === "worker") {
    draft = {
      ...draft,
      build: {
        command: resolvedBuildCommand || "npm run build",
        output,
      },
      worker: {
        entry: `${output}/index.js`,
        module: true,
      },
    };
  } else if (type === "service") {
    draft = {
      ...draft,
      ...(resolvedBuildCommand ? { build: { command: resolvedBuildCommand } } : {}),
      start: {
        command: defaultStart || "npm run start",
      },
      runtime: { port: 3000 },
    };
  } else if (type === "container") {
    draft = {
      ...draft,
      ...(resolvedBuildCommand ? { build: { command: resolvedBuildCommand } } : {}),
      docker: {
        dockerfile: "Dockerfile",
        context: root || ".",
      },
    };
  }

  const first = validateNearzeroSpec(draft);
  if (!first.valid) {
    return { spec: null, errors: first.errors };
  }
  const normalized = normalizeNearzeroSpec(draft as DeploySpec);
  const second = validateNearzeroSpec(normalized);
  if (!second.valid) {
    return { spec: null, errors: second.errors };
  }
  return { spec: normalized, errors: [] };
}

export function parseIdempotencySegment(value: string): string {
  const raw = String(value || "").trim();
  if (!raw) return "x";
  return raw.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 120);
}
