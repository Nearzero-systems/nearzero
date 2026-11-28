import {
  AppError,
  appSourceRequestSchema,
  createServiceRequestSchema,
  deploySettingsRequestSchema,
  isVariableName,
  mountsRequestSchema,
  PORT_MODES,
  portNumberSchema,
  portsRequestSchema,
  providerSourceRequestSchema,
} from "@nearzero/shared";
import { z } from "zod";
import { generateForService } from "../../domains/hostnames.ts";
import { getRepository, usableProviders } from "../../git-providers/reads.ts";
import { gitSourceView, saveProviderSource } from "../../git-providers/sources.ts";
import { readAppSettings } from "../../service-runtime/app-settings.ts";
import {
  saveBuild,
  saveDeploySettings,
  saveMounts,
  savePorts,
  saveSource,
} from "../../service-runtime/settings.ts";
import { createService, loadService } from "../../services/records.ts";
import { currentWebhookToken } from "../../webhooks/tokens.ts";
import { defineCapability, serverChoiceOutcome } from "../capability.ts";
import {
  type AgentContext,
  agentCreateOptions,
  type CapabilityOutcome,
  InputRefusal,
  requirePolicy,
  requireProductionAllowed,
  ServerChoiceNeeded,
} from "../context.ts";
import { PUSHES_DONT_REDEPLOY } from "../flows/deploy-loop.ts";
import { CONNECT_RETURN_MS } from "../flows/git-import.ts";
import {
  ACCESS_WAIT_LABEL,
  accessCard,
  candidateAccounts,
  chosenBranch,
} from "../flows/git-link.ts";
import { type RepositoryLink, repositoryLink } from "../flows/parse.ts";
import { HOST_LABELS, publicCloneUrl } from "../flows/public-repo.ts";
import { matchByName, ResolveFailure } from "../resolve.ts";
import { agentSettings } from "../settings.ts";
import {
  type BuildInput,
  buildFields,
  buildRequest,
  optionalBuildFields,
  refuseSecretCommands,
  setsBuild,
} from "./build-options.ts";
import {
  asRequest,
  count,
  describeService,
  findProjectEnvironment,
  findService,
  guardService,
  nameRef,
  onServer,
  placeService,
  serviceInput,
  serviceRefs,
} from "./common.ts";

/** Spec 20.2 (finding services) and 20.3 (applications). */

export const findServiceCapability = defineCapability({
  name: "find_service",
  area: "finding",
  description:
    "Find a service across all projects by name (typos tolerated), internal app name, a deployment log path, a container name, or id. When nothing matches, returns the real candidates.",
  input: z.object(serviceInput),
  policies: [],
  changes: false,
  label: { running: "Finding service", done: "Found service" },
  startTarget: (input) => input.service,
  async run(ctx, input) {
    const service = await findService(ctx, input);
    return {
      target: onServer(service),
      refs: serviceRefs(service),
      result: { service: describeService(service) },
    };
  },
});

const newServiceFields = {
  project: nameRef("project"),
  environment: z
    .string()
    .trim()
    .max(100)
    .optional()
    .describe('Defaults to "development", else the first non-production environment.'),
  name: z.string().trim().min(1).max(100).describe("The new service's name."),
  server: z
    .string()
    .trim()
    .max(300)
    .optional()
    .describe(
      'The server\'s name or address, or "host" for the Nearzero host. Ask the person when several are ready.',
    ),
};

interface Created {
  serviceId: string;
  name: string;
  serverName: string;
  copies: string[];
  notes: string[];
}

async function createRecord(
  ctx: AgentContext,
  input: {
    project: string;
    environment?: string | undefined;
    name: string;
    server?: string | undefined;
  },
  kind:
    | "application"
    | "compose"
    | "postgres"
    | "mysql"
    | "mariadb"
    | "mongodb"
    | "redis"
    | "libsql",
  settings: Record<string, unknown>,
): Promise<Created> {
  const { environment } = await findProjectEnvironment(ctx, input);
  requireProductionAllowed(ctx, environment.name);
  const place = await placeService(ctx, input.server);
  const created = await createService(
    ctx.services,
    ctx.actor,
    environment.id,
    asRequest(createServiceRequestSchema, {
      kind,
      name: input.name,
      serverId: place.id,
      settings,
      variables: [],
    }),
    agentCreateOptions(ctx),
  );
  return {
    serviceId: created.service.id,
    name: created.service.name,
    serverName: place.name,
    copies: created.alsoAddedTo.map((copy) => copy.environmentName),
    notes: [
      ...(place.note ? [place.note] : []),
      ...(created.message ? [created.message] : []),
      ...created.notes,
      ...created.notAddedTo.map((left) => `${left.environmentName}: ${left.reason}`),
    ],
  };
}

/** Every Git import gets a default hostname when "Assign domains" allows it (spec 20.3). */
async function defaultHostname(ctx: AgentContext, serviceId: string): Promise<string | null> {
  if (!ctx.policies["services.assign-domains"]) return null;
  try {
    const given = await generateForService(ctx.services, ctx.actor, serviceId, { path: "/" });
    return `${given.hostname.url} (not live until the service is deployed)`;
  } catch {
    return null;
  }
}

function createdResult(created: Created, extra: Record<string, unknown> = {}) {
  return {
    created: { id: created.serviceId, name: created.name, server: created.serverName },
    alsoAddedTo: created.copies,
    notes: created.notes,
    next: "It isn't deployed yet. Ask for variables if it needs any, then deploy it and follow the deployment.",
    ...extra,
  };
}

export const createAppFromImage = defineCapability({
  name: "create_app_from_image",
  area: "applications",
  description:
    "Create an app that runs a container image (for example nginx:1.27 or ghcr.io/acme/web:latest).",
  input: z.object({
    ...newServiceFields,
    image: z.string().trim().min(1).max(500),
    port: portNumberSchema
      .optional()
      .describe("The port the app listens on inside its container (default 3000)."),
  }),
  policies: ["services.configure"],
  changes: true,
  label: { running: "Creating app", done: "Created app" },
  startTarget: (input) => input.name,
  async run(ctx, input) {
    const created = await createRecord(ctx, input, "application", {
      image: input.image,
      ...(input.port ? { servicePort: input.port } : {}),
    });
    return {
      target: `${created.name} on ${created.serverName}`,
      refs: [{ kind: "service", id: created.serviceId }],
      result: createdResult(created),
    };
  },
});

/** A bare host/owner/repo becomes an https URL; anything with a user name or token is refused. */
export function normalizeGitUrl(raw: string): string {
  const value = raw.trim();
  if (
    /^[a-z0-9.-]+\.[a-z]{2,}\/[^\s]+$/i.test(value) &&
    !value.includes("://") &&
    !value.includes("@")
  ) {
    return `https://${value}`;
  }
  return value;
}

async function sshKeyFor(ctx: AgentContext, key: string | undefined): Promise<string | null> {
  if (!key?.trim()) return null;
  const rows = await ctx.services.db
    .selectFrom("ssh_key")
    .select(["id", "name"])
    .where("workspace_id", "=", ctx.actor.workspace.id)
    .execute();
  const match = matchByName(rows, key);
  if (match.kind !== "one") {
    if (!ctx.policies["ssh-keys.read"]) requirePolicy(ctx, "ssh-keys.read");
    // The key names are the person's to see only when they may use the keys (B1-59).
    await ctx.actor.access.require("ssh-keys.use");
    throw new ResolveFailure(
      `No saved SSH key matches "${key}".`,
      rows.map((row) => row.name),
    );
  }
  // A key added through this chat's form needs no "Read SSH keys" (spec 19.8, 19.12).
  if (!ctx.sessionKeys.has(match.item.id)) requirePolicy(ctx, "ssh-keys.read");
  return match.item.id;
}

/** A new app's build settings before anything is saved, for validating a request up front. */
const NEW_APP_BUILD = {
  builder: { type: "automatic" },
  commands: { install: "", build: "", start: "" },
};

/**
 * The build settings a create action was given, checked before anything is created (C1-19): a
 * two-line command or a bad Dockerfile stage is refused with nothing left behind.
 */
function checkedBuild(input: BuildInput) {
  return setsBuild(input) ? buildRequest(input, NEW_APP_BUILD) : null;
}

/** A Git URL on one of the four public hosts, read the way a pasted link is (31d R4-01). */
export function publicRepositoryOf(url: string): RepositoryLink | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const link = repositoryLink(`${host}${parsed.pathname}`);
  return link && link.host === host ? link : null;
}

type GitUrlInput = z.output<typeof gitUrlInput>;

/**
 * Creating an app from a link to GitHub, GitLab, Bitbucket or Codeberg, checked like the pasted
 * link (31d R4-01): a connected account that can see the repository is used, so pushes redeploy
 * it; otherwise a public repository is created from its URL on its real default branch (or the
 * branch asked for, when it has it); otherwise nothing is created and the person gets the card
 * that gives Nearzero access.
 */
async function createFromPublicHost(
  ctx: AgentContext,
  input: GitUrlInput,
  link: RepositoryLink,
): Promise<CapabilityOutcome> {
  const build = checkedBuild(input);
  const hostLabel = HOST_LABELS[link.host];
  const accounts = await candidateAccounts(ctx, link.host);
  for (const account of accounts) {
    let repo: Awaited<ReturnType<typeof getRepository>>;
    try {
      repo = await getRepository(ctx.services, ctx.actor, account.id, link.fullName);
    } catch (error) {
      if (error instanceof AppError) continue;
      throw error;
    }
    const wanted = input.branch ?? link.branch;
    const request = asRequest(providerSourceRequestSchema, {
      providerId: account.id,
      repository: repo.fullName,
      ...(wanted ? { branch: wanted } : {}),
      ...(input.path ? { buildPath: input.path } : {}),
    });
    const created = await createRecord(ctx, input, "application", {});
    const saved = await saveProviderSource(ctx.services, ctx.actor, created.serviceId, request);
    if (build) await saveBuild(ctx.services, ctx.actor, created.serviceId, build);
    const hostname = await defaultHostname(ctx, created.serviceId);
    return {
      target: `${created.name} from ${repo.fullName}`,
      refs: [{ kind: "service", id: created.serviceId }],
      result: createdResult(created, {
        repository: repo.fullName,
        through: `The connected ${hostLabel} account "${account.name}", which can see the repository, so pushes redeploy it.`,
        ...(build ? { builder: build.builder.type } : {}),
        notes: [...created.notes, ...saved.notes],
        push: saved.push.message,
        hostname,
      }),
    };
  }
  const url = publicCloneUrl(link.host, link.fullName);
  const refs = await agentSettings(ctx.services).publicRepositories.refs(url);
  if (refs.kind === "unreachable") {
    throw new InputRefusal(
      `I couldn't reach ${link.host} to check ${link.fullName}: ${refs.reason} Nothing was created. Try again in a moment.`,
    );
  }
  if (refs.kind === "public") {
    if (refs.branches.length === 0) {
      throw new InputRefusal(
        `${link.fullName} on ${hostLabel} is public, but it has no branches yet. Push some code to it, then ask again.`,
      );
    }
    if (input.branch && !refs.branches.includes(input.branch)) {
      throw new ResolveFailure(
        `${link.fullName} has no branch called "${input.branch}". Nothing was created.`,
        refs.branches.slice(0, 50),
      );
    }
    const branch = chosenBranch(input.branch ?? link.branch, refs.defaultBranch, refs.branches);
    if (!branch) {
      throw new ResolveFailure(
        `${link.fullName} has no default branch. Ask the person which branch to deploy.`,
        refs.branches.slice(0, 50),
      );
    }
    const source = asRequest(appSourceRequestSchema, {
      type: "git",
      url,
      branch,
      ...(input.path ? { buildPath: input.path } : {}),
    });
    const created = await createRecord(ctx, input, "application", {});
    const saved = await saveSource(ctx.services, ctx.actor, created.serviceId, source);
    if (build) await saveBuild(ctx.services, ctx.actor, created.serviceId, build);
    const hostname = await defaultHostname(ctx, created.serviceId);
    return {
      target: `${created.name} on ${created.serverName}`,
      refs: [{ kind: "service", id: created.serviceId }],
      result: createdResult(created, {
        source: url,
        branch,
        ...(build ? { builder: build.builder.type } : {}),
        notes: [...created.notes, ...saved.notes],
        push: PUSHES_DONT_REDEPLOY,
        hostname,
      }),
    };
  }
  const card = await accessCard(ctx, link, accounts);
  if (!card.form) throw new InputRefusal(card.text);
  return {
    target: link.fullName,
    result: {
      waiting: `${card.text} The person sees a card to give Nearzero access. Nothing was created; it is created once the repository can be read.`,
    },
    form: {
      form: card.form,
      waitLabel: ACCESS_WAIT_LABEL,
      context: {
        gitAccess: { input },
        connectUntil: new Date(Date.now() + CONNECT_RETURN_MS).toISOString(),
      },
    },
  };
}

const gitUrlInput = z.object({
  ...newServiceFields,
  url: z.string().trim().min(1).max(1000),
  branch: z.string().trim().max(255).optional(),
  path: z.string().trim().max(500).optional().describe("The app's folder inside a monorepo."),
  sshKey: z
    .string()
    .trim()
    .max(200)
    .optional()
    .describe("The saved SSH key's name or reference, for SSH URLs."),
  ...optionalBuildFields,
});

export const createAppFromGitUrl = defineCapability({
  name: "create_app_from_git_url",
  area: "applications",
  description:
    "Create an app from a Git URL: https://host/owner/repo, a bare host/owner/repo, or SSH (git@host:owner/repo or ssh://…) with a saved deploy key. URLs with a user name or token, query strings or fragments are refused. A link to github.com, gitlab.com, bitbucket.org or codeberg.org is checked first: a connected account that can see it is used (pushes then redeploy it), otherwise a public repository is created on its real default branch, otherwise nothing is created and the person is shown how to give Nearzero access.",
  input: gitUrlInput,
  policies: ["services.configure", "services.import-git"],
  changes: true,
  label: { running: "Creating app", done: "Created app" },
  startTarget: (input) => input.name,
  async run(ctx, input) {
    refuseSecretCommands(input);
    const url = normalizeGitUrl(input.url);
    const link = input.sshKey ? null : publicRepositoryOf(url);
    if (link) return createFromPublicHost(ctx, input, link);
    const sshKeyId = await sshKeyFor(ctx, input.sshKey);
    const source = asRequest(appSourceRequestSchema, {
      type: "git",
      url,
      ...(input.branch ? { branch: input.branch } : {}),
      ...(input.path ? { buildPath: input.path } : {}),
      sshKeyId,
    });
    const build = checkedBuild(input);
    const created = await createRecord(ctx, input, "application", {});
    const saved = await saveSource(ctx.services, ctx.actor, created.serviceId, source);
    if (build) await saveBuild(ctx.services, ctx.actor, created.serviceId, build);
    const builder = build ? build.builder.type : null;
    const hostname = await defaultHostname(ctx, created.serviceId);
    return {
      target: `${created.name} on ${created.serverName}`,
      refs: [{ kind: "service", id: created.serviceId }],
      result: createdResult(created, {
        source: url,
        ...(builder ? { builder } : {}),
        notes: [...created.notes, ...saved.notes],
        hostname,
      }),
    };
  },
  /** The access card was answered (Check again, or back from connecting): look again. */
  async answer(ctx, context, answer) {
    const saved = (context as { gitAccess?: { input?: unknown } }).gitAccess;
    const parsed = gitUrlInput.safeParse(saved?.input);
    const link = parsed.success ? publicRepositoryOf(normalizeGitUrl(parsed.data.url)) : null;
    const again = answer.outcome === "connected" || answer.option === "check";
    if (!parsed.success || !link || !again) {
      return {
        target: "",
        result: { outcome: "The person closed the card, so nothing was created." },
      };
    }
    try {
      return await createFromPublicHost(ctx, parsed.data, link);
    } catch (error) {
      if (error instanceof ServerChoiceNeeded) {
        return serverChoiceOutcome("", parsed.data, error);
      }
      throw error;
    }
  },
});

export const createAppFromProvider = defineCapability({
  name: "create_app_from_provider",
  area: "applications",
  description:
    "Create an app from a repository of a connected Git provider (GitHub, GitLab, Bitbucket, Gitea). Use list_git_providers and list_repositories first.",
  input: z.object({
    ...newServiceFields,
    provider: z.string().trim().min(1).max(200).describe("The connected provider's name or id."),
    repository: z.string().trim().min(1).max(300).describe("owner/name"),
    branch: z.string().trim().max(255).optional(),
    path: z.string().trim().max(500).optional(),
    ...optionalBuildFields,
  }),
  policies: ["services.configure", "services.import-git"],
  changes: true,
  label: { running: "Creating app", done: "Created app" },
  startTarget: (input) => `${input.name} from ${input.repository}`,
  async run(ctx, input) {
    refuseSecretCommands(input);
    const providers = (await usableProviders(ctx.services, ctx.actor)).filter((item) => item.ready);
    const match = matchByName(providers, input.provider);
    if (match.kind !== "one") {
      throw new ResolveFailure(
        `No connected Git provider matches "${input.provider}".`,
        providers.map((item) => `${item.name} (${item.kindLabel})`),
      );
    }
    const request = asRequest(providerSourceRequestSchema, {
      providerId: match.item.id,
      repository: input.repository,
      ...(input.branch ? { branch: input.branch } : {}),
      ...(input.path ? { buildPath: input.path } : {}),
    });
    const build = checkedBuild(input);
    // The repository is read before anything is created, so a typo leaves nothing behind (C1-19).
    await getRepository(ctx.services, ctx.actor, match.item.id, input.repository);
    const created = await createRecord(ctx, input, "application", {});
    const saved = await saveProviderSource(ctx.services, ctx.actor, created.serviceId, request);
    if (build) await saveBuild(ctx.services, ctx.actor, created.serviceId, build);
    const builder = build ? build.builder.type : null;
    const hostname = await defaultHostname(ctx, created.serviceId);
    return {
      target: `${created.name} from ${input.repository}`,
      refs: [{ kind: "service", id: created.serviceId }],
      result: createdResult(created, {
        repository: input.repository,
        ...(builder ? { builder } : {}),
        notes: [...created.notes, ...saved.notes],
        push: saved.push.message,
        hostname,
      }),
    };
  },
});

export const changeAppSource = defineCapability({
  name: "change_app_source",
  area: "applications",
  description:
    "Change where an app's code comes from: a container image, a Git URL (with branch, folder, watch paths, submodules), or a connected provider's repository and branch.",
  input: z.object({
    ...serviceInput,
    image: z.string().trim().max(500).optional(),
    gitUrl: z.string().trim().max(1000).optional(),
    provider: z.string().trim().max(200).optional(),
    repository: z.string().trim().max(300).optional(),
    branch: z.string().trim().max(255).optional(),
    path: z.string().trim().max(500).optional(),
    watchPaths: z.array(z.string().max(200)).max(50).optional(),
    submodules: z.boolean().optional(),
    sshKey: z.string().trim().max(200).optional(),
  }),
  policies: ["services.configure"],
  changes: true,
  label: { running: "Changing source", done: "Changed source" },
  startTarget: (input) => input.service,
  async run(ctx, input) {
    const service = await findService(ctx, input);
    guardService(ctx, service);
    let notes: string[] = [];
    if (input.image) {
      const saved = await saveSource(
        ctx.services,
        ctx.actor,
        service.id,
        asRequest(appSourceRequestSchema, { type: "image", image: input.image }),
      );
      notes = saved.notes;
    } else if (input.gitUrl) {
      requirePolicy(ctx, "services.import-git");
      const saved = await saveSource(
        ctx.services,
        ctx.actor,
        service.id,
        asRequest(appSourceRequestSchema, {
          type: "git",
          url: normalizeGitUrl(input.gitUrl),
          ...(input.branch ? { branch: input.branch } : {}),
          ...(input.path ? { buildPath: input.path } : {}),
          ...(input.watchPaths ? { watchPaths: input.watchPaths } : {}),
          ...(input.submodules !== undefined ? { submodules: input.submodules } : {}),
          sshKeyId: await sshKeyFor(ctx, input.sshKey),
        }),
      );
      notes = saved.notes;
    } else if (input.repository) {
      requirePolicy(ctx, "services.import-git");
      const providers = (await usableProviders(ctx.services, ctx.actor)).filter(
        (item) => item.ready,
      );
      const match = input.provider
        ? matchByName(providers, input.provider)
        : providers.length === 1
          ? { kind: "one" as const, item: providers[0] as (typeof providers)[number], exact: true }
          : { kind: "none" as const };
      if (match.kind !== "one") {
        throw new ResolveFailure(
          "Say which connected Git provider to use.",
          providers.map((item) => item.name),
        );
      }
      const saved = await saveProviderSource(
        ctx.services,
        ctx.actor,
        service.id,
        asRequest(providerSourceRequestSchema, {
          providerId: match.item.id,
          repository: input.repository,
          ...(input.branch ? { branch: input.branch } : {}),
          ...(input.path ? { buildPath: input.path } : {}),
          ...(input.watchPaths ? { watchPaths: input.watchPaths } : {}),
          ...(input.submodules !== undefined ? { submodules: input.submodules } : {}),
        }),
      );
      notes = saved.notes;
    } else {
      throw new InputRefusal("Give an image, a Git URL, or a provider repository to switch to.");
    }
    return {
      target: onServer(service),
      refs: serviceRefs(service),
      result: { changed: service.name, notes, next: "Deploy to apply it." },
    };
  },
});

export const changeAppBuild = defineCapability({
  name: "change_app_build",
  area: "applications",
  description:
    "Change how an app builds: the builder (automatic, dockerfile, railpack, nixpacks, heroku, paketo, static) with its options (Dockerfile path, context, stage, publish folder, single-page app, the Railpack version, the Heroku stack) and install, build and start commands. Commands that contain secrets are refused.",
  input: z.object({ ...serviceInput, ...buildFields }),
  policies: ["services.configure"],
  changes: true,
  label: { running: "Changing build", done: "Changed build" },
  startTarget: (input) => input.service,
  async run(ctx, input) {
    refuseSecretCommands(input);
    const service = await findService(ctx, input);
    guardService(ctx, service);
    const row = await loadService(ctx.services.db, ctx.actor.workspace.id, service.id);
    const current = readAppSettings(row?.settings ?? null);
    // A new builder starts from its own options; the commands it doesn't name stay.
    await saveBuild(
      ctx.services,
      ctx.actor,
      service.id,
      buildRequest(input, { builder: { type: input.builder }, commands: current.commands }),
    );
    return {
      target: onServer(service),
      refs: serviceRefs(service),
      result: { changed: service.name, builder: input.builder, next: "Deploy to apply it." },
    };
  },
});

export const addPort = defineCapability({
  name: "add_port",
  area: "applications",
  description:
    "Publish a container port of an app on its server (TCP or UDP), routed through the server's router (the default) or in host mode, straight on the server's own port, as the console offers. Web traffic doesn't need this; hostnames route it. Apps only.",
  input: z.object({
    ...serviceInput,
    containerPort: portNumberSchema,
    publishedPort: portNumberSchema,
    protocol: z.enum(["tcp", "udp"]).optional(),
    mode: z.enum(PORT_MODES).optional().describe('"routed" (the default) or "host" (31d G4-08).'),
  }),
  policies: ["services.configure"],
  changes: true,
  label: { running: "Adding port", done: "Added port" },
  startTarget: (input) => `${input.publishedPort} on ${input.service}`,
  async run(ctx, input) {
    const service = await findService(ctx, input);
    guardService(ctx, service);
    if (service.kind !== "application") throw new InputRefusal("Port mappings are for apps only.");
    const row = await loadService(ctx.services.db, ctx.actor.workspace.id, service.id);
    const ports = readAppSettings(row?.settings ?? null).ports;
    const saved = await savePorts(
      ctx.services,
      ctx.actor,
      service.id,
      asRequest(portsRequestSchema, {
        ports: [
          ...ports,
          {
            containerPort: input.containerPort,
            publishedPort: input.publishedPort,
            ...(input.protocol ? { protocol: input.protocol } : {}),
            ...(input.mode ? { mode: input.mode } : {}),
          },
        ],
      }),
    );
    return {
      target: `${input.publishedPort}/${(input.protocol ?? "tcp").toUpperCase()} on ${service.name}`,
      refs: serviceRefs(service),
      result: {
        added: {
          containerPort: input.containerPort,
          publishedPort: input.publishedPort,
          mode: input.mode ?? "routed",
        },
        notes: saved.notes,
      },
    };
  },
});

export const addMount = defineCapability({
  name: "add_mount",
  area: "applications",
  description:
    "Add a mount to an app: a named volume, a bind mount of a host path, or a file path. File contents are never accepted here (they may be secret): a file mount is created empty and the person fills it in on the service's Advanced tab.",
  input: z.object({
    ...serviceInput,
    type: z.enum(["volume", "bind", "file"]),
    containerPath: z.string().trim().min(1).max(500),
    name: z.string().trim().max(63).optional().describe("The volume's name (volume mounts)."),
    hostPath: z
      .string()
      .trim()
      .max(500)
      .optional()
      .describe("The absolute host path (bind mounts)."),
    readOnly: z.boolean().optional(),
    content: z.string().optional().describe("Never pass this: file contents are refused."),
  }),
  policies: ["services.configure"],
  changes: true,
  label: { running: "Adding mount", done: "Added mount" },
  startTarget: (input) => `${input.containerPath} on ${input.service}`,
  async run(ctx, input) {
    if (input.content !== undefined) {
      throw new InputRefusal(
        "File contents can't go through the Agent because they may be secret. Create the mount, and the person adds its contents on the service's Advanced tab.",
      );
    }
    const service = await findService(ctx, input);
    guardService(ctx, service);
    if (service.kind !== "application") throw new InputRefusal("Mounts here are for apps only.");
    const row = await loadService(ctx.services.db, ctx.actor.workspace.id, service.id);
    const mounts = readAppSettings(row?.settings ?? null).mounts;
    const added =
      input.type === "volume"
        ? { type: "volume", name: input.name ?? "data", containerPath: input.containerPath }
        : input.type === "bind"
          ? {
              type: "bind",
              hostPath: input.hostPath ?? "",
              containerPath: input.containerPath,
              readOnly: input.readOnly ?? false,
            }
          : { type: "file", containerPath: input.containerPath, content: "" };
    const saved = await saveMounts(
      ctx.services,
      ctx.actor,
      service.id,
      asRequest(mountsRequestSchema, { mounts: [...mounts, added] }),
    );
    return {
      target: `${input.containerPath} on ${service.name}`,
      refs: serviceRefs(service),
      result: {
        added: { type: input.type, containerPath: input.containerPath },
        notes: [
          ...saved.notes,
          ...(input.type === "file"
            ? ["The file is empty: the person fills it in on the service's Advanced tab."]
            : []),
        ],
      },
    };
  },
});

export const requestVariables = defineCapability({
  name: "request_variables",
  area: "applications",
  description:
    "Ask the person for a service's environment variables in the secure form. Values go straight to Nearzero; you only learn which names were saved. Pass the names you know are needed (from example env files, errors in the log); the person can add more.",
  input: z.object({
    ...serviceInput,
    names: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
    reason: z
      .string()
      .trim()
      .max(400)
      .describe("Why they're needed, in one sentence for the person."),
    deployAfter: z
      .boolean()
      .optional()
      .describe("Whether the form's main button also deploys (default true)."),
  }),
  policies: ["services.configure"],
  changes: true,
  label: { running: "Asking for variables", done: "Asked for variables" },
  startTarget: (input) => input.service,
  async run(ctx, input) {
    const service = await findService(ctx, input);
    guardService(ctx, service);
    if (service.kind !== "application" && service.kind !== "compose") {
      throw new InputRefusal("Only apps and Compose services take variables through this form.");
    }
    const names = [...new Set(input.names.filter(isVariableName))];
    const deploy = input.deployAfter !== false;
    return {
      target: onServer(service),
      refs: serviceRefs(service),
      result: { waiting: "The person fills in the variables form." },
      form: {
        form: {
          kind: "variables",
          service: { id: service.id, name: service.name },
          reason: `${input.reason} Values go straight to Nearzero; the Agent never sees them.`,
          names,
          saveTo: `/api/v1/services/${service.id}/variables`,
          deployLabel: deploy
            ? `Save ${count(Math.max(names.length, 1), "variable")} and deploy`
            : `Save ${count(Math.max(names.length, 1), "variable")}`,
          skipLabel: "Deploy without them",
          hint: "Saved to the service. The Agent only learns the names.",
        },
        waitLabel: "Waiting for the variables",
        context: { serviceId: service.id, serviceName: service.name, names, deploy },
      },
    };
  },
  async answer(ctx, context, answer) {
    const serviceId = String(context.serviceId);
    const name = String(context.serviceName);
    if (answer.outcome !== "saved") {
      return {
        target: name,
        result: {
          saved: [],
          note: "Nothing was saved: the person chose to go on without the variables.",
        },
      };
    }
    // Only names that are really saved on the service are reported; values are never opened.
    await ctx.actor.access.require("service.see", { kind: "service", id: serviceId });
    const stored = await ctx.services.db
      .selectFrom("variable_set")
      .select(["names"])
      .where("workspace_id", "=", ctx.actor.workspace.id)
      .where("service_id", "=", serviceId)
      .executeTakeFirst();
    const present = new Set(stored?.names ?? []);
    const claimed = (answer.names ?? []).filter((entry) => typeof entry === "string");
    const saved = claimed.filter((entry) => present.has(entry));
    return {
      target: name,
      refs: [{ kind: "service", id: serviceId }],
      result: {
        saved,
        note:
          saved.length > 0
            ? `Saved ${count(saved.length, "variable")} on ${name}. Redeploy it and follow the deployment until it finishes.`
            : "Nothing was saved.",
      },
    };
  },
});

export const readPushDeploys = defineCapability({
  name: "read_push_deploys",
  area: "applications",
  description:
    "Read an app's or Compose service's push deploys: on or off, push or tag trigger, watch paths, whether the GitHub App delivers pushes or a webhook is needed (with setup steps), and whether a deploy webhook exists. The webhook URL itself works like a password, so it is never given to you: the person copies it from the service's Settings.",
  input: z.object(serviceInput),
  policies: [],
  changes: false,
  label: { running: "Reading push deploys", done: "Read push deploys" },
  startTarget: (input) => input.service,
  async run(ctx, input) {
    const service = await findService(ctx, input);
    const row = await loadService(ctx.services.db, ctx.actor.workspace.id, service.id);
    const settings = readAppSettings(row?.settings ?? null);
    const source = settings.source;
    const canDeploy = ctx.actor.access.can("service.deploy", serviceRefs(service)[0] as never);
    const view = await gitSourceView(ctx.services, ctx.actor, service.id).catch(() => null);
    const webhook = canDeploy ? await currentWebhookToken(ctx.services, service.id) : null;
    const consoleUrl = ctx.services.consoleUrl();
    return {
      target: onServer(service),
      refs: serviceRefs(service),
      result: {
        autodeploy: settings.deploy.autodeploy,
        source: source?.type ?? "none",
        trigger: source && "trigger" in source ? source.trigger : null,
        watchPaths: source && "watchPaths" in source ? source.watchPaths : [],
        delivery: view?.push
          ? {
              mode: view.push.mode,
              status: view.push.status,
              message: view.push.message,
              steps: view.push.steps,
            }
          : null,
        webhook: canDeploy
          ? webhook
            ? "A deploy webhook exists. The person copies its URL from the service's Settings; it works like a password."
            : "No deploy webhook yet. The person creates one in the service's Settings."
          : "You need permission to deploy this service to see its webhook",
        warnings: [
          ...(!consoleUrl || /^http:\/\/(localhost|127\.|10\.|192\.168\.)/.test(consoleUrl)
            ? [
                "The console doesn't look reachable from the internet, so GitHub and other hosts can't call the webhook.",
              ]
            : []),
        ],
      },
    };
  },
});

export const changePushDeploys = defineCapability({
  name: "change_push_deploys",
  area: "applications",
  description:
    "Turn push deploys on or off for an app or Compose service, and change the trigger (push or tag) and watch paths of its Git source.",
  input: z.object({
    ...serviceInput,
    autodeploy: z.boolean().optional(),
    trigger: z.enum(["push", "tag"]).optional(),
    watchPaths: z.array(z.string().max(200)).max(50).optional(),
  }),
  policies: ["services.configure"],
  changes: true,
  label: { running: "Changing push deploys", done: "Changed push deploys" },
  startTarget: (input) => input.service,
  async run(ctx, input) {
    const service = await findService(ctx, input);
    guardService(ctx, service);
    if (input.autodeploy !== undefined) {
      await saveDeploySettings(
        ctx.services,
        ctx.actor,
        service.id,
        asRequest(deploySettingsRequestSchema, { autodeploy: input.autodeploy }),
      );
    }
    if (input.trigger !== undefined || input.watchPaths !== undefined) {
      const row = await loadService(ctx.services.db, ctx.actor.workspace.id, service.id);
      const source = readAppSettings(row?.settings ?? null).source;
      if (source?.type === "git") {
        await saveSource(
          ctx.services,
          ctx.actor,
          service.id,
          asRequest(appSourceRequestSchema, {
            ...source,
            trigger: input.trigger ?? source.trigger,
            watchPaths: input.watchPaths ?? source.watchPaths,
          }),
        );
      } else if (source?.type === "provider" && source.providerId) {
        await saveProviderSource(
          ctx.services,
          ctx.actor,
          service.id,
          asRequest(providerSourceRequestSchema, {
            providerId: source.providerId,
            repository: source.repository,
            branch: source.branch,
            buildPath: source.buildPath,
            ...(source.composePath ? { composePath: source.composePath } : {}),
            trigger: input.trigger ?? source.trigger,
            watchPaths: input.watchPaths ?? source.watchPaths,
            submodules: source.submodules,
          }),
        );
      } else {
        throw new InputRefusal(
          "This service has no Git source, so it has no push trigger or watch paths.",
        );
      }
    }
    return {
      target: onServer(service),
      refs: serviceRefs(service),
      result: { changed: service.name },
    };
  },
});

export const copyServiceToEnvironments = defineCapability({
  name: "copy_service_to_environments",
  area: "applications",
  description:
    "Copy a service into the project's other environments where it is missing (not deployed, variable names only). New services are already copied when they are created.",
  input: z.object(serviceInput),
  policies: ["services.configure"],
  changes: true,
  pending:
    "a console action for copying an existing service (services are copied to every environment when created)",
  label: { running: "Copying service", done: "Copied service" },
  startTarget: (input) => input.service,
  async run() {
    throw new AppError("conflict", "Not available.");
  },
});

export const appCapabilities = [
  findServiceCapability,
  createAppFromImage,
  createAppFromGitUrl,
  createAppFromProvider,
  changeAppSource,
  changeAppBuild,
  addPort,
  addMount,
  requestVariables,
  readPushDeploys,
  changePushDeploys,
  copyServiceToEnvironments,
];
