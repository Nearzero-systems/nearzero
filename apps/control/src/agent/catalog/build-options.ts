import { buildSettingsRequestSchema, HEROKU_STACKS, RAILPACK_VERSIONS } from "@nearzero/shared";
import { z } from "zod";
import { InputRefusal } from "../context.ts";
import { secretLookingInput } from "../redact.ts";
import { asRequest } from "./common.ts";

/**
 * How an app builds, as the model sets it (spec 20.3): the builder with its options and the
 * install, build and start commands. change_app_build and the two Git create actions take the
 * same fields (30d R4-06), with the same refusal of commands that carry secrets.
 */

export const BUILDERS = [
  "automatic",
  "dockerfile",
  "railpack",
  "nixpacks",
  "heroku",
  "paketo",
  "static",
] as const;

export const buildFields = {
  builder: z.enum(BUILDERS),
  dockerfilePath: z.string().trim().max(500).optional(),
  contextPath: z.string().trim().max(500).optional(),
  stage: z.string().trim().max(128).optional(),
  publishDirectory: z.string().trim().max(500).optional(),
  spa: z.boolean().optional(),
  railpackVersion: z
    .enum(RAILPACK_VERSIONS)
    .optional()
    .describe("For railpack: the Railpack version, as the console offers (31d G4-08)."),
  herokuStack: z
    .enum(HEROKU_STACKS)
    .optional()
    .describe('For heroku: the Heroku stack, "24" or "22".'),
  installCommand: z.string().max(2000).optional(),
  buildCommand: z.string().max(2000).optional(),
  startCommand: z.string().max(2000).optional(),
};

/** The same fields, all optional, for actions that create an app. */
export const optionalBuildFields = {
  ...buildFields,
  builder: buildFields.builder
    .optional()
    .describe(
      "How it builds; automatic when left out. Use dockerfile for a repository's Dockerfile.",
    ),
};

export interface BuildInput {
  builder?: (typeof BUILDERS)[number] | undefined;
  dockerfilePath?: string | undefined;
  contextPath?: string | undefined;
  stage?: string | undefined;
  publishDirectory?: string | undefined;
  spa?: boolean | undefined;
  railpackVersion?: (typeof RAILPACK_VERSIONS)[number] | undefined;
  herokuStack?: (typeof HEROKU_STACKS)[number] | undefined;
  installCommand?: string | undefined;
  buildCommand?: string | undefined;
  startCommand?: string | undefined;
}

/** Refuses commands that look like they carry a secret, before anything is created or changed. */
export function refuseSecretCommands(input: BuildInput): void {
  for (const command of [input.installCommand, input.buildCommand, input.startCommand]) {
    const problem = command ? secretLookingInput(command) : null;
    if (problem) throw new InputRefusal(problem);
  }
}

/** True when the input sets anything about the build. */
export function setsBuild(input: BuildInput): boolean {
  return (
    input.builder !== undefined ||
    input.installCommand !== undefined ||
    input.buildCommand !== undefined ||
    input.startCommand !== undefined
  );
}

/**
 * The build settings request for `input`, keeping the commands it doesn't name. `builder`
 * defaults to the current one (automatic for a new app).
 */
export function buildRequest(
  input: BuildInput,
  current: {
    builder: { type: string };
    commands: { install: string; build: string; start: string };
  },
) {
  const type = input.builder ?? current.builder.type;
  const builder: Record<string, unknown> =
    input.builder === undefined ? { ...current.builder } : { type };
  if (type === "dockerfile") {
    if (input.dockerfilePath) builder.dockerfilePath = input.dockerfilePath;
    if (input.contextPath) builder.contextPath = input.contextPath;
    if (input.stage) builder.stage = input.stage;
  }
  if (type === "nixpacks" && input.publishDirectory)
    builder.publishDirectory = input.publishDirectory;
  if (type === "static" && input.spa !== undefined) builder.spa = input.spa;
  if (type === "railpack" && input.railpackVersion) builder.version = input.railpackVersion;
  if (type === "heroku" && input.herokuStack) builder.stack = input.herokuStack;
  return asRequest(buildSettingsRequestSchema, {
    builder,
    commands: {
      install: input.installCommand ?? current.commands.install,
      build: input.buildCommand ?? current.commands.build,
      start: input.startCommand ?? current.commands.start,
    },
  });
}
