import { z } from "zod";
import { branchProblem, normalizeBuildPath } from "./deploy-rules.ts";
import {
  composePathProblem,
  DEFAULT_COMPOSE_PATH,
  DEFAULT_GITEA_URL,
  DEFAULT_GITLAB_URL,
  GIT_PROVIDER_KINDS,
  githubOrganizationProblem,
  isConsoleReturnPath,
  repositoryNameProblem,
} from "./git-provider-rules.ts";

/**
 * Request schemas for Git providers (spec 16) and provider sources on services (spec 6.3, 7.1).
 * The control plane validates with these; the console's dialogs use the same words.
 */

export * from "./git-provider-rules.ts";

const nameField = z
  .string({ error: "Enter a name for this provider." })
  .trim()
  .min(1, "Enter a name for this provider.")
  .max(100, "Use at most 100 characters.");

/** A provider's own address (self-hosted GitLab or Gitea): http(s), no credentials or query. */
function addressField(example: string, required: boolean) {
  const message = `Enter the address, like ${example}.`;
  return z
    .string()
    .trim()
    .max(500, "Use at most 500 characters.")
    .default(required ? example : "")
    .transform((value, context) => {
      if (value === "") {
        if (!required) return "";
        context.addIssue({ code: "custom", message });
        return z.NEVER;
      }
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        context.addIssue({ code: "custom", message });
        return z.NEVER;
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        context.addIssue({ code: "custom", message });
        return z.NEVER;
      }
      if (url.username || url.password || url.search || url.hash) {
        context.addIssue({
          code: "custom",
          message: "Enter only the address, without a user name, password or query.",
        });
        return z.NEVER;
      }
      return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    });
}

const secretField = z.string().max(8192, "That is too long to be a key.").default("");
const optionalText = (max: number) => z.string().trim().max(max).default("");

const returnToField = z
  .string()
  .max(500)
  .optional()
  .transform((value) => (value && isConsoleReturnPath(value) ? value : undefined));

export const githubManifestRequestSchema = z.object({
  organization: z
    .string()
    .trim()
    .default("")
    .superRefine((value, context) => {
      const problem = githubOrganizationProblem(value);
      if (problem) context.addIssue({ code: "custom", message: problem });
    }),
  returnTo: returnToField,
});

export const githubCompleteRequestSchema = z.object({
  code: z.string().trim().min(1, "GitHub didn't send a code back.").max(200),
  state: z.string().trim().min(1, "GitHub didn't send the connection's state back.").max(200),
});

export const githubInstallationRequestSchema = z.object({
  installationId: z.coerce
    .number({ error: "GitHub didn't say which installation this is." })
    .int()
    .positive(),
  state: z.string().trim().max(200).optional(),
  setupAction: z.string().trim().max(40).optional(),
});

export const oauthCompleteRequestSchema = z.object({
  kind: z.enum(["gitlab", "gitea"]),
  code: z.string().trim().max(2000).default(""),
  state: z.string().trim().min(1, "The provider didn't send the connection's state back.").max(200),
  /** Set when the provider sent the person back with an error (they declined, for example). */
  error: z.string().trim().max(200).optional(),
});

export const gitlabProviderRequestSchema = z.object({
  name: nameField,
  url: addressField(DEFAULT_GITLAB_URL, true),
  internalUrl: addressField("http://gitlab.internal:8080", false),
  applicationId: optionalText(200),
  applicationSecret: secretField,
  /** Instead of OAuth: a personal, group or project access token (API scope). */
  accessToken: secretField,
  group: optionalText(255),
  returnTo: returnToField,
});

export const giteaProviderRequestSchema = z.object({
  name: nameField,
  url: addressField(DEFAULT_GITEA_URL, true),
  internalUrl: addressField("http://gitea.internal:3000", false),
  clientId: optionalText(200),
  clientSecret: secretField,
  /** Instead of OAuth: a Gitea access token with repository and user scopes. */
  accessToken: secretField,
  organization: optionalText(255),
  returnTo: returnToField,
});

export const bitbucketProviderRequestSchema = z.object({
  name: nameField,
  username: z
    .string()
    .trim()
    .min(1, "Enter your Bitbucket user name.")
    .max(255, "Use at most 255 characters."),
  email: optionalText(254),
  apiToken: secretField,
  /** Legacy: connections that still use an app password are marked "Deprecated". */
  appPassword: secretField,
  workspace: optionalText(255),
  returnTo: returnToField,
});

/** Edit (spec 16.1): every field; a blank secret keeps the saved one. */
export const gitlabProviderUpdateSchema = gitlabProviderRequestSchema.omit({ returnTo: true });
export const giteaProviderUpdateSchema = giteaProviderRequestSchema.omit({ returnTo: true });
export const bitbucketProviderUpdateSchema = bitbucketProviderRequestSchema.omit({
  returnTo: true,
});
export const githubProviderUpdateSchema = z.object({ name: nameField });

export const providerShareRequestSchema = z.object({
  shared: z.boolean({ error: "Say whether to share the provider with the workspace." }),
});

export const providerFlowRequestSchema = z.object({ returnTo: returnToField });

export const gitProviderKindSchema = z.enum(GIT_PROVIDER_KINDS);

const repositoryField = z
  .string({ error: "Choose a repository." })
  .trim()
  .superRefine((value, context) => {
    const problem = repositoryNameProblem(value);
    if (problem) context.addIssue({ code: "custom", message: problem });
  });

const branchField = z
  .string()
  .trim()
  .default("")
  .superRefine((value, context) => {
    if (value === "") return;
    const problem = branchProblem(value);
    if (problem) context.addIssue({ code: "custom", message: problem });
  });

const buildPathField = z
  .string()
  .max(500)
  .default("")
  .transform((value, context) => {
    const result = normalizeBuildPath(value === "/" ? "" : value);
    if (typeof result === "string") return result;
    context.addIssue({ code: "custom", message: result.problem });
    return z.NEVER;
  });

const watchPathsField = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(200, "Use at most 200 characters for a watch path.")
      .refine((value) => !value.includes("\0"), "That isn't a valid path."),
  )
  .max(50, "Use at most 50 watch paths.")
  .default([]);

/**
 * A service's source from a connected provider (spec 6.3 provider tabs, 7.1 "From a
 * repository"). Applications use the build path; Compose services the Compose file path. An empty
 * branch means the repository's default branch.
 */
export const providerSourceRequestSchema = z.object({
  providerId: z.string({ error: "Choose an account." }).trim().min(1, "Choose an account.").max(64),
  repository: repositoryField,
  branch: branchField,
  buildPath: buildPathField,
  composePath: z
    .string()
    .trim()
    .max(500)
    .default(DEFAULT_COMPOSE_PATH)
    .superRefine((value, context) => {
      const problem = composePathProblem(value);
      if (problem) context.addIssue({ code: "custom", message: problem });
    }),
  trigger: z.enum(["push", "tag"]).default("push"),
  watchPaths: watchPathsField,
  submodules: z.boolean().default(false),
});
export type ProviderSourceRequest = z.output<typeof providerSourceRequestSchema>;
