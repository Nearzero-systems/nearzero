import {
  type AgentFormAnswer,
  AppError,
  appSourceRequestSchema,
  buildSettingsRequestSchema,
  createServiceRequestSchema,
  GIT_FLOW_MINUTES,
  GIT_PROVIDER_KINDS,
  GIT_PROVIDER_LABELS,
  type GitProviderKind,
  providerSourceRequestSchema,
  slugify,
} from "@nearzero/shared";
import { generateForService } from "../../domains/hostnames.ts";
import {
  getRepository,
  inspectRepository,
  listBranches,
  listRepositories,
  readFile,
  saveProviderSource,
  usableProviders,
} from "../../git-providers/area.ts";
import { HOST_TARGET } from "../../runners/hub.ts";
import { saveBuild, saveSource } from "../../service-runtime/settings.ts";
import { createService } from "../../services/records.ts";
import { asRequest, requireServerReady } from "../catalog/common.ts";
import { agentCreateOptions } from "../context.ts";
import {
  editDistance,
  matchByName,
  normalizeName,
  resolveServer,
  visibleProjects,
  visibleServers,
} from "../resolve.ts";
import { agentSettings } from "../settings.ts";
import { makeProjectRow } from "./create-project.ts";
import {
  type DeployState,
  deployLoop,
  firstVariablesQuestion,
  newDeployState,
  PUSHES_DONT_REDEPLOY,
  resumeDeploy,
} from "./deploy-loop.ts";
import {
  describeOption,
  inScope,
  isEnvSchemaFile,
  isExampleEnvFile,
  namesFromExample,
  namesFromSchema,
  optionLabel,
  optionValue,
  type RunOption,
  runOptions,
  variableNames,
} from "./inspect.ts";
import {
  audit,
  bold,
  count,
  doneRow,
  expected,
  type FlowModule,
  type FlowResult,
  type FlowRun,
  type FlowState,
  picker,
  reasonOf,
  refuse,
  row,
} from "./kit.ts";
import type { ImportDetails } from "./parse.ts";
import { HOST_LABELS, type PublicGitHost } from "./public-repo.ts";

/**
 * Import from Git (spec 19.7): provider, repository, branch, project, server, how to run,
 * create, variables, deploy and wait. Each step is skipped when its answer is already known;
 * the repository is read through the provider's API, never cloned.
 */

export interface ImportIntent extends Partial<ImportDetails> {
  repository: string | null;
  provider: GitProviderKind | null;
  project: string | null;
  server: string | null;
  branch: string | null;
  deploy: boolean;
}

export interface ImportState extends FlowState {
  stage: "import";
  want: ImportIntent;
  /** "deploy <name>" found no service: the repository picker says so. */
  fromDeployName: string | null;
  /** The form being answered, so the answer is checked against what was offered. */
  asking: "connect" | "provider" | "repository" | "branch" | "project" | "server" | "how" | null;
  offered: { value: string; label: string }[];
  provider: { id: string; name: string; kind: GitProviderKind } | null;
  repository: { fullName: string; defaultBranch: string | null } | null;
  branch: string | null;
  project: { id: string | null; name: string } | null;
  server: { id: string; name: string; onHost: boolean } | null;
  how: RunOption | null;
  /**
   * A public repository no connected account can see, deployed from its URL (30d R4-01): the
   * provider steps are skipped, the files come from a clone without contents, and pushes don't
   * redeploy it.
   */
  public: { url: string; host: PublicGitHost } | null;
  /** The ways it can run, while the person picks one. */
  howOptions: RunOption[];
  exampleNames: string[];
  deploy: DeployState | null;
}

const NEARZERO_HOST_LABEL = "Nearzero host — the machine Nearzero itself runs on";

function shortName(fullName: string): string {
  return fullName.split("/").pop() ?? fullName;
}

function consolePaths(run: FlowRun) {
  const slug = run.ctx.actor.workspace.slug;
  const back = `/${slug}/dashboard/agent?session=${run.ctx.session.id}`;
  return {
    connect: (kind: GitProviderKind) =>
      `/${slug}/dashboard/settings/git-providers?connect=${kind}&return=${encodeURIComponent(back)}`,
  };
}

function ask(
  state: ImportState,
  asking: NonNullable<ImportState["asking"]>,
  form: ReturnType<typeof picker>,
  waitLabel: string,
): FlowResult {
  state.asking = asking;
  state.offered = form.options.map((option) => ({ value: option.value, label: option.label }));
  return {
    kind: "ask",
    form,
    waitLabel,
    state,
    ...(asking === "connect" ? { connectReturn: true } : {}),
  };
}

// ---- 1. Provider

async function providerStep(run: FlowRun, state: ImportState): Promise<FlowResult | null> {
  const { ctx } = run;
  const all = await usableProviders(ctx.services, ctx.actor, state.want.provider ?? undefined);
  const ready = all.filter((provider) => provider.ready);
  if (ready.length === 1) {
    const only = ready[0] as (typeof ready)[number];
    state.provider = { id: only.id, name: only.name, kind: only.kind };
    return null;
  }
  if (ready.length > 1) {
    return ask(
      state,
      "provider",
      picker(
        "provider",
        "Which Git account should I import from?",
        ready.map((provider) => ({
          value: provider.id,
          label: `${provider.name} (${provider.kindLabel})`,
          icon: provider.kind,
          ...(provider.account ? { description: `Connected as ${provider.account}` } : {}),
        })),
      ),
      "Waiting for a Git account",
    );
  }
  if (!ctx.actor.access.can("git-accounts.connect-own")) {
    run.say(
      `You don't have a Git account you can use here. Ask an owner or admin to connect one and share it with the workspace, or to allow "Connect their own Git accounts" for you.`,
    );
    return {
      kind: "done",
      summary: "No Git account is usable and the person may not connect one.",
    };
  }
  const paths = consolePaths(run);
  const kinds = state.want.provider ? [state.want.provider] : [...GIT_PROVIDER_KINDS];
  const unfinished = all.filter((provider) => !provider.ready);
  run.say(
    `${unfinished.length > 0 ? `${unfinished.map((provider) => bold(provider.name)).join(", ")} ${unfinished.length === 1 ? "isn't" : "aren't"} fully connected yet. ` : ""}Connect a Git account first: you'll come back to this chat, and I'll carry on from here.`,
  );
  return ask(
    state,
    "connect",
    picker(
      "provider",
      "Connect a Git account",
      kinds.map((kind) => ({
        value: `connect:${kind}`,
        label: `Connect ${GIT_PROVIDER_LABELS[kind]}`,
        icon: kind,
        href: paths.connect(kind),
      })),
    ),
    "Waiting for a Git account",
  );
}

// ---- 2. Repository

function byCloseness<T extends { fullName: string }>(items: T[], query: string): T[] {
  const wanted = normalizeName(query);
  const score = (item: T) =>
    Math.min(
      editDistance(normalizeName(shortName(item.fullName)), wanted),
      editDistance(normalizeName(item.fullName), wanted),
    );
  return items
    .map((item, index) => ({ item, index, distance: score(item) }))
    .sort((a, b) => a.distance - b.distance || a.index - b.index)
    .map((entry) => entry.item);
}

async function repositoryStep(run: FlowRun, state: ImportState): Promise<FlowResult | null> {
  const { ctx } = run;
  const provider = state.provider as NonNullable<ImportState["provider"]>;
  const list = await row(
    run,
    { running: "Listing repositories", done: "Listed repositories" },
    provider.name,
    async () => {
      const found = await listRepositories(ctx.services, ctx.actor, provider.id, "");
      return {
        value: found,
        target: count(found.repositories.length, "repository", "repositories"),
      };
    },
  );
  if (list.repositories.length === 0) {
    run.say(
      provider.kind === "github"
        ? `GitHub didn't list any repositories for ${bold(provider.name)}. Grant the GitHub App access to your repositories on GitHub (the app's Configure page), then ask again.`
        : `${GIT_PROVIDER_LABELS[provider.kind]} didn't list any repositories for ${bold(provider.name)}. Check that the account can see the repository, then ask again.`,
    );
    return { kind: "done", summary: "The Git account lists no repositories." };
  }
  const query = state.want.repository;
  if (query) {
    const items = list.repositories.map((repo) => ({
      id: repo.fullName,
      name: repo.fullName,
      repo,
    }));
    let match = matchByName(items, query);
    if (match.kind === "none" && !query.includes("/")) {
      match = matchByName(
        list.repositories.map((repo) => ({
          id: repo.fullName,
          name: shortName(repo.fullName),
          repo,
        })),
        query,
      );
    }
    if (match.kind === "one") {
      state.repository = {
        fullName: match.item.repo.fullName,
        defaultBranch: match.item.repo.defaultBranch,
      };
      return null;
    }
  }
  const ordered = query ? byCloseness(list.repositories, query) : list.repositories;
  const verb = state.want.deploy ? "deploy" : "import";
  return ask(
    state,
    "repository",
    picker(
      "repository",
      state.fromDeployName
        ? `No service or repository is called "${state.fromDeployName}". Choose the repository to deploy`
        : query
          ? `No repository is called "${query}". Choose the repository to ${verb}`
          : `Choose the repository to ${verb}`,
      ordered.map((repo) => ({
        value: repo.fullName,
        label: repo.fullName,
        ...(repo.private ? { description: "Private" } : {}),
      })),
    ),
    "Waiting for a repository",
  );
}

// ---- 3. Branch

async function branchStep(run: FlowRun, state: ImportState): Promise<FlowResult | null> {
  const { ctx } = run;
  const repository = state.repository as NonNullable<ImportState["repository"]>;
  const provider = state.provider as NonNullable<ImportState["provider"]>;
  if (!state.want.branch && repository.defaultBranch) {
    state.branch = repository.defaultBranch;
    return null;
  }
  const listed = await listBranches(ctx.services, ctx.actor, provider.id, repository.fullName);
  const names = listed.branches.map((branch) => branch.name);
  const wanted = state.want.branch;
  if (wanted && names.includes(wanted)) {
    state.branch = wanted;
    return null;
  }
  const pick =
    (!wanted && listed.defaultBranch) ||
    (!wanted && names.find((name) => name === "main")) ||
    (!wanted && names.find((name) => name === "master")) ||
    (!wanted && names.length === 1 ? names[0] : undefined);
  if (pick) {
    state.branch = pick;
    return null;
  }
  if (names.length === 0) {
    run.say(`${bold(repository.fullName)} has no branches yet, so there is nothing to import.`);
    return { kind: "done", summary: `${repository.fullName} has no branches.` };
  }
  return ask(
    state,
    "branch",
    picker(
      "branch",
      wanted
        ? `${repository.fullName} has no branch called "${wanted}". Which branch should I use?`
        : `Which branch of ${repository.fullName} should I use?`,
      names.map((name) => ({ value: name, label: name })),
    ),
    "Waiting for a branch",
  );
}

// ---- 4. Project

async function projectStep(run: FlowRun, state: ImportState): Promise<FlowResult | null> {
  const repository = state.repository as NonNullable<ImportState["repository"]>;
  const projects = await visibleProjects(run.ctx);
  if (state.want.project) {
    const match = matchByName(projects, state.want.project);
    if (match.kind === "one") {
      state.project = { id: match.item.id, name: match.item.name };
      return null;
    }
  }
  const repo = shortName(repository.fullName);
  if (projects.length === 0) {
    // Nothing to choose from: a new project it is.
    state.project = { id: null, name: repo };
    return null;
  }
  // Never the only existing project silently: "New project" is always offered first.
  return ask(
    state,
    "project",
    picker("project", `Which project should ${repo} go in?`, [
      { value: "new", label: `New project "${repo}"` },
      ...projects.map((project) => ({ value: project.id, label: project.name })),
    ]),
    "Waiting for a project",
  );
}

// ---- 5. Server

async function serverStep(run: FlowRun, state: ImportState): Promise<FlowResult | null> {
  const { ctx } = run;
  if (state.want.server) {
    let server: Awaited<ReturnType<typeof resolveServer>> | null = null;
    try {
      server = await resolveServer(ctx, state.want.server);
    } catch (error) {
      if (!expected(error)) throw error;
      run.say(`There's no server called "${state.want.server}" that you can use, so pick one.`);
    }
    if (server) {
      // A named server that isn't set up takes nothing (31d G4-03).
      try {
        await requireServerReady(ctx, server, "created");
      } catch (error) {
        if (!expected(error)) throw error;
        run.say(reasonOf(error));
        return { kind: "done", summary: `${server.name} isn't set up; nothing was created.` };
      }
      state.server = {
        id: server.id,
        name: server.isHost ? "Nearzero host" : server.name,
        onHost: server.isHost,
      };
      return null;
    }
  }
  const reachable = await visibleServers(ctx);
  const others = reachable.filter((server) => !server.isHost);
  const ready = others.length
    ? await ctx.services.db
        .selectFrom("server")
        .select(["id", "name", "address"])
        .where("workspace_id", "=", ctx.actor.workspace.id)
        .where(
          "id",
          "in",
          others.map((server) => server.id),
        )
        .where("setup_state", "=", "ready")
        .orderBy("name")
        .execute()
    : [];
  const hostUsable = reachable.some((server) => server.isHost);
  if (ready.length === 0) {
    if (!hostUsable) {
      run.say(
        "You have no server that's ready for deployments yet. Add one under Servers (or ask me to set one up), then ask again.",
      );
      return { kind: "done", summary: "No server is ready for deployments." };
    }
    state.server = { id: HOST_TARGET, name: "Nearzero host", onHost: true };
    run.say(
      "No server is ready for deployments yet, so I'm putting it on the Nearzero host, the machine Nearzero itself runs on.",
    );
    return null;
  }
  const options = [
    ...ready.map((server) => ({
      value: server.id,
      label: server.name,
      ...(server.address ? { description: server.address } : {}),
    })),
    ...(hostUsable ? [{ value: HOST_TARGET, label: NEARZERO_HOST_LABEL }] : []),
  ];
  if (options.length === 1) {
    const only = ready[0] as (typeof ready)[number];
    state.server = { id: only.id, name: only.name, onHost: false };
    return null;
  }
  return ask(
    state,
    "server",
    picker("server", "Which server should it run on?", options),
    "Waiting for a server",
  );
}

// ---- 6. How to run

async function collectNames(
  run: FlowRun,
  state: ImportState,
  inspected: Pick<Awaited<ReturnType<typeof inspectRepository>>, "files" | "manifests">,
  folder: string,
): Promise<string[]> {
  const provider = state.provider;
  const repository = state.repository as NonNullable<ImportState["repository"]>;
  const read = new Map(inspected.manifests.map((manifest) => [manifest.path, manifest.content]));
  const wanted = inspected.files
    .filter((file) => file.type === "file" && inScope(file.path, folder))
    .filter((file) => isExampleEnvFile(file.path) || isEnvSchemaFile(file.path))
    .slice(0, 6);
  const examples: string[][] = [];
  const schemas: string[][] = [];
  for (const file of wanted) {
    let text = read.get(file.path);
    // A public repository's files come from its clone: only what was read is known.
    if (text === undefined && !provider) continue;
    if (text === undefined && provider) {
      try {
        text = (
          await readFile(run.ctx.services, run.ctx.actor, provider.id, {
            repository: repository.fullName,
            ref: state.branch ?? "",
            path: file.path,
          })
        ).content;
      } catch (error) {
        if (!expected(error)) throw error;
        continue;
      }
    }
    if (text === undefined) continue;
    if (isExampleEnvFile(file.path)) examples.push(namesFromExample(text));
    else schemas.push(namesFromSchema(text));
  }
  return variableNames([...examples, ...schemas]);
}

async function howStep(run: FlowRun, state: ImportState): Promise<FlowResult | null> {
  const { ctx } = run;
  const repository = state.repository as NonNullable<ImportState["repository"]>;
  const inspected = await row(
    run,
    { running: "Inspecting repository", done: "Inspected repository" },
    `${repository.fullName} · ${state.branch}`,
    async () => {
      if (state.public) {
        // No account can see it: a clone without file contents tells how it runs (R4-01).
        try {
          return {
            value: await agentSettings(ctx.services).publicRepositories.inspect(
              state.public.url,
              state.branch ?? "",
            ),
          };
        } catch (error) {
          throw new AppError(
            "conflict",
            `I couldn't read ${repository.fullName} from ${HOST_LABELS[state.public.host]}: ${(error as Error).message}`,
          );
        }
      }
      const provider = state.provider as NonNullable<ImportState["provider"]>;
      return {
        value: await inspectRepository(ctx.services, ctx.actor, provider.id, {
          repository: repository.fullName,
          ...(state.branch ? { ref: state.branch } : {}),
        }),
      };
    },
  );
  const options = runOptions(inspected.files, inspected.manifests);
  const requested = requestedHow(state, inspected.files, options);
  if (requested) {
    if (requested.kind === "missing") {
      run.say(requested.message);
      return { kind: "done", summary: `Nothing was created: ${requested.message}` };
    }
    if (requested.kind === "use") {
      state.how = requested.how;
      state.exampleNames = await collectNames(run, state, inspected, folderOf(requested.how));
      return null;
    }
    return askHow(run, state, inspected, requested.options);
  }
  if (options.length === 0) {
    run.say(
      `I couldn't tell how to run ${bold(repository.fullName)}. Nothing was created. Add a Dockerfile, a Compose file or a language manifest (like package.json, requirements.txt or go.mod) to the repository, then ask again.`,
    );
    return {
      kind: "done",
      summary: `Couldn't tell how to run ${repository.fullName}; nothing was created.`,
    };
  }
  if (options.length === 1) {
    state.how = options[0] as RunOption;
    state.exampleNames = await collectNames(run, state, inspected, folderOf(state.how));
    return null;
  }
  return askHow(run, state, inspected, options);
}

async function askHow(
  run: FlowRun,
  state: ImportState,
  inspected: Pick<Awaited<ReturnType<typeof inspectRepository>>, "files" | "manifests">,
  options: RunOption[],
): Promise<FlowResult> {
  const repository = state.repository as NonNullable<ImportState["repository"]>;
  state.exampleNames = await collectNames(run, state, inspected, state.want.folder ?? "");
  state.howOptions = options;
  return ask(
    state,
    "how",
    picker(
      "how_to_run",
      `How should ${repository.fullName} run?`,
      options.map((option) => ({
        value: optionValue(option),
        label: optionLabel(option),
        description: describeOption(option),
      })),
    ),
    "Waiting for how it should run",
  );
}

function folderOf(option: RunOption): string {
  return option.kind === "compose" ? "" : option.folder;
}

/** The folder a way of running lives in: a Compose file's own folder. */
function placeOf(option: RunOption): string {
  if (option.kind !== "compose") return option.folder;
  const at = option.path.lastIndexOf("/");
  return at < 0 ? "" : option.path.slice(0, at);
}

/**
 * How the request said to run it (31d G4-06, R4-01): "with its Dockerfile", "with nixpacks",
 * "from the apps/api folder". Null when it said nothing, so the usual step runs; otherwise the
 * way to use, the choices left to ask among, or why nothing can be created.
 */
function requestedHow(
  state: ImportState,
  files: { path: string; type: string }[],
  options: RunOption[],
):
  | { kind: "use"; how: RunOption }
  | { kind: "choose"; options: RunOption[] }
  | { kind: "missing"; message: string }
  | null {
  const builder = state.want.builder ?? null;
  const folder = state.want.folder ?? null;
  if (builder === null && folder === null) return null;
  const repository = (state.repository as NonNullable<ImportState["repository"]>).fullName;
  const where = folder ? `${repository}/${folder}` : repository;
  if (folder && !files.some((file) => file.path.startsWith(`${folder}/`))) {
    return {
      kind: "missing",
      message: `${bold(repository)} has no folder ${folder}, so nothing was created. Check the folder's name, then ask again.`,
    };
  }
  const pick = (found: RunOption[], what: string) =>
    found.length === 0
      ? {
          kind: "missing" as const,
          message: `I couldn't find ${what} in ${bold(where)}, so nothing was created. Check the folder, or ask me to build it another way.`,
        }
      : found.length === 1
        ? { kind: "use" as const, how: found[0] as RunOption }
        : { kind: "choose" as const, options: found };
  const inFolder = (option: RunOption) => folder === null || placeOf(option) === folder;
  switch (builder) {
    case "dockerfile":
      return pick(
        options.filter((option) => option.kind === "dockerfile" && inFolder(option)),
        "a Dockerfile",
      );
    case "compose":
      return pick(
        options.filter((option) => option.kind === "compose" && inFolder(option)),
        "a Compose file",
      );
    case "static":
      return { kind: "use", how: { kind: "static", folder: folder ?? "" } };
    case null:
      return pick(
        options.filter(inFolder),
        "a way to run it (a Dockerfile, a Compose file or a language manifest)",
      );
    default:
      // Automatic detection, Railpack, Nixpacks, Heroku or Paketo: the builder reads the folder.
      return { kind: "use", how: { kind: "automatic", folder: folder ?? "", manifest: "" } };
  }
}

// ---- 7. Create, 8. variables, 9. deploy

async function freeName(run: FlowRun, environmentId: string, wanted: string): Promise<string> {
  const taken = new Set(
    (
      await run.ctx.services.db
        .selectFrom("service")
        .select("name")
        .where("environment_id", "=", environmentId)
        .execute()
    ).map((service) => service.name.toLowerCase()),
  );
  if (!taken.has(wanted.toLowerCase())) return wanted;
  for (let n = 2; ; n++) if (!taken.has(`${wanted}-${n}`.toLowerCase())) return `${wanted}-${n}`;
}

/** How long a service name taken from a repository or folder name can be. */
const SERVICE_NAME_FROM_REPOSITORY_MAX = 60;

function serviceNameFor(state: ImportState): string {
  const repository = state.repository as NonNullable<ImportState["repository"]>;
  const how = state.how as RunOption;
  const folder = folderOf(how);
  const base = folder ? (folder.split("/").pop() ?? folder) : shortName(repository.fullName);
  return slugify(base, SERVICE_NAME_FROM_REPOSITORY_MAX) || "app";
}

async function createStep(run: FlowRun, state: ImportState): Promise<FlowResult | null> {
  const { ctx } = run;
  const provider = state.provider;
  const repository = state.repository as NonNullable<ImportState["repository"]>;
  const server = state.server as NonNullable<ImportState["server"]>;
  const how = state.how as RunOption;
  const wantedProject = state.project as NonNullable<ImportState["project"]>;
  const label = repository.fullName;

  // Checked against the switches as they are now, not when the flow started: a form may have
  // waited while an owner turned them off (spec 19.9, C1-16).
  const off = await refuse(
    run,
    ["services.configure", "services.import-git"],
    state.public ? "create_app_from_git_url" : "create_app_from_provider",
    label,
  );
  if (off) return off;
  if (wantedProject.id === null) {
    const refused = await refuse(run, ["projects.create"], "create_project", wantedProject.name);
    if (refused) return refused;
  }
  let projectId = wantedProject.id;
  let projectName = wantedProject.name;
  try {
    if (projectId === null) {
      const made = await makeProjectRow(run, wantedProject.name);
      projectId = made.project.id;
      projectName = made.project.name;
      state.project = { id: projectId, name: projectName };
    }
  } catch (error) {
    if (!expected(error)) throw error;
    run.say(
      `I couldn't create the project ${bold(wantedProject.name)}: ${reasonOf(error)} Nothing else was created.`,
    );
    return { kind: "done", summary: `Creating the project ${wantedProject.name} failed.` };
  }
  const project = (await visibleProjects(ctx)).find((item) => item.id === projectId);
  const environment =
    project?.environments.find((env) => env.name === "development") ??
    project?.environments.find((env) => !env.isProduction) ??
    project?.environments[0];
  if (!project || !environment) {
    run.say(`${bold(projectName)} has no environment you can open, so nothing was created.`);
    return { kind: "done", summary: `${projectName} has no usable environment.` };
  }
  if (environment.isProduction) {
    const production = await refuse(run, ["production"], "create_app_from_provider", label);
    if (production) return production;
  }

  const kind = how.kind === "compose" ? "compose" : "application";
  // A name the request gave is used as it is, never changed into another (31d R4-01).
  const asked = state.want.name ?? null;
  if (asked && (await freeName(run, environment.id, asked)) !== asked) {
    run.say(
      `${bold(projectName)} / ${environment.name} already has a service called ${bold(asked)}, so nothing was created. Ask again with another name.`,
    );
    return {
      kind: "done",
      summary: `${asked} already exists in ${projectName}; nothing was created.`,
    };
  }
  const name = asked ?? (await freeName(run, environment.id, serviceNameFor(state)));
  const where = `${name} on ${server.name}`;
  let serviceId: string;
  try {
    serviceId = await row(
      run,
      kind === "compose"
        ? { running: "Creating Compose service", done: "Created Compose service" }
        : { running: "Creating app", done: "Created app" },
      where,
      async () => {
        const created = await createService(
          ctx.services,
          ctx.actor,
          environment.id,
          asRequest(createServiceRequestSchema, {
            kind,
            name,
            serverId: server.id,
            settings: {},
            variables: [],
          }),
          agentCreateOptions(ctx),
        );
        const id = created.service.id;
        const place =
          how.kind === "compose"
            ? { composePath: `./${how.path}` }
            : how.folder
              ? { buildPath: how.folder }
              : {};
        if (state.public || !provider) {
          // A public repository: its URL, on the branch found (R4-01).
          await saveSource(
            ctx.services,
            ctx.actor,
            id,
            asRequest(appSourceRequestSchema, {
              type: "git",
              url: state.public?.url ?? "",
              ...(state.branch ? { branch: state.branch } : {}),
              ...place,
            }),
          );
        } else {
          await saveProviderSource(
            ctx.services,
            ctx.actor,
            id,
            asRequest(providerSourceRequestSchema, {
              providerId: provider.id,
              repository: repository.fullName,
              ...(state.branch ? { branch: state.branch } : {}),
              ...place,
            }),
          );
        }
        if (how.kind === "dockerfile") {
          await saveBuild(
            ctx.services,
            ctx.actor,
            id,
            asRequest(buildSettingsRequestSchema, {
              builder: { type: "dockerfile", dockerfilePath: how.dockerfile },
            }),
          );
        } else if (how.kind === "static") {
          await saveBuild(
            ctx.services,
            ctx.actor,
            id,
            asRequest(buildSettingsRequestSchema, { builder: { type: "static", spa: false } }),
          );
        } else if (
          how.kind === "automatic" &&
          state.want.builder &&
          state.want.builder !== "automatic"
        ) {
          // The builder the request named ("with nixpacks"), as the console sets it (G4-06).
          await saveBuild(
            ctx.services,
            ctx.actor,
            id,
            asRequest(buildSettingsRequestSchema, { builder: { type: state.want.builder } }),
          );
        }
        return { value: id };
      },
    );
  } catch (error) {
    if (!expected(error)) throw error;
    run.say(`I couldn't create ${bold(name)} from ${label}: ${reasonOf(error)}`);
    return { kind: "done", summary: `Creating ${name} from ${label} failed: ${reasonOf(error)}` };
  }
  await audit(
    run,
    kind === "compose" ? "create_compose_from_repository" : "create_app_from_provider",
    `${name} from ${label}`,
    { repository: label, branch: state.branch, project: projectName, server: server.name },
    { kind: "service", id: serviceId },
  );

  // Every Git import gets a default hostname when "Assign domains" allows it (spec 20.3).
  let address: string | null = null;
  if (ctx.policies["services.assign-domains"] && ctx.policies["services.configure"]) {
    try {
      const given = await generateForService(ctx.services, ctx.actor, serviceId, { path: "/" });
      address = given.hostname.url;
      await doneRow(run, "Added domain", given.hostname.hostname);
    } catch (error) {
      if (!expected(error)) throw error;
    }
  }

  const builtWith =
    how.kind === "compose"
      ? `its Compose file (${how.path})`
      : how.kind === "dockerfile"
        ? `its Dockerfile${how.folder ? ` in ${how.folder}` : ""}`
        : how.kind === "static"
          ? "a static file server"
          : `automatic language detection${how.folder ? ` in ${how.folder}` : ""}`;
  run.say(
    `Created ${bold(name)} in ${bold(projectName)} / ${environment.name} on ${server.name}, from ${label} (${state.branch}), built with ${builtWith}.${address ? ` Its address will be ${address}; it isn't live until it's deployed.` : ""}`,
  );
  state.deploy = newDeployState({
    serviceId,
    serviceName: name,
    serverName: server.name,
    onHost: server.onHost,
    environmentName: environment.name,
    projectName,
    repository: label,
    branch: state.branch,
    exampleNames: state.exampleNames,
    fromPublicUrl: state.public !== null,
  });
  // A builder the person named stays: a failed Dockerfile build isn't switched (G4-06).
  if (state.want.builder) state.deploy.switchedBuilder = true;
  if (!state.want.deploy) {
    run.say(
      `I didn't deploy it, as you asked. Say "deploy ${name}" when you're ready.${state.public ? ` ${PUSHES_DONT_REDEPLOY}` : ""}`,
    );
    return { kind: "done", summary: `Imported ${label} as ${name} without deploying.` };
  }
  const refused = await refuse(run, ["services.deploy"], "deploy_service", where);
  if (refused) return refused;
  // Variables are always asked for before the first deploy (spec 19.7 step 8).
  return firstVariablesQuestion(state.deploy);
}

/** Runs the remaining steps in order until one needs the person or the flow ends. */
export async function advance(run: FlowRun, state: ImportState): Promise<FlowResult> {
  state.asking = null;
  state.offered = [];
  try {
    const steps: [() => boolean, () => Promise<FlowResult | null>][] = [
      [() => state.provider === null && state.public === null, () => providerStep(run, state)],
      [() => state.repository === null, () => repositoryStep(run, state)],
      [() => state.branch === null, () => branchStep(run, state)],
      [() => state.project === null, () => projectStep(run, state)],
      [() => state.server === null, () => serverStep(run, state)],
      [() => state.how === null, () => howStep(run, state)],
      [() => state.deploy === null, () => createStep(run, state)],
    ];
    for (const [needed, step] of steps) {
      if (!needed()) continue;
      const result = await step();
      if (result) return result;
      if (run.ctx.signal.aborted) return { kind: "stopped" };
    }
  } catch (error) {
    if (!expected(error)) throw error;
    run.say(`The import stopped: ${reasonOf(error)}`);
    return { kind: "done", summary: `The Git import stopped: ${reasonOf(error)}` };
  }
  return deployLoop(run, state.deploy as DeployState);
}

export function newImportState(
  intent: ImportIntent,
  fromDeployName: string | null = null,
): ImportState {
  return {
    stage: "import",
    want: intent,
    fromDeployName,
    asking: null,
    offered: [],
    provider: null,
    repository: null,
    branch: null,
    project: null,
    server: null,
    how: null,
    public: null,
    howOptions: [],
    exampleNames: [],
    deploy: null,
  };
}

export async function startImport(run: FlowRun, state: ImportState): Promise<FlowResult> {
  const target = state.want.repository ?? "";
  const refused = await refuse(
    run,
    ["services.configure", "services.import-git"],
    "create_app_from_provider",
    target,
  );
  if (refused) return refused;
  return advance(run, state);
}

export async function resumeImport(
  run: FlowRun,
  raw: FlowState,
  answer: AgentFormAnswer,
): Promise<FlowResult> {
  if (raw.stage === "deploy") {
    // The variables form, before the first deploy or after a failure.
    return resumeDeploy(run, raw as DeployState, answer);
  }
  const state = raw as ImportState;
  const asking = state.asking;
  if (asking === "connect") {
    // Back from connecting (or the person picked something): look again.
    state.provider = null;
    return advance(run, state);
  }
  const value =
    answer.outcome === "chosen" &&
    typeof answer.option === "string" &&
    state.offered.some((option) => option.value === answer.option)
      ? answer.option
      : null;
  if (value === null) {
    run.say("That wasn't one of the choices, so nothing changed. Pick one of them.");
    return advance(run, state);
  }
  const labelOf = (wanted: string) =>
    state.offered.find((option) => option.value === wanted)?.label ?? wanted;
  switch (asking) {
    case "provider": {
      const provider = (await usableProviders(run.ctx.services, run.ctx.actor)).find(
        (item) => item.id === value && item.ready,
      );
      if (provider) state.provider = { id: provider.id, name: provider.name, kind: provider.kind };
      break;
    }
    case "repository": {
      const provider = state.provider as NonNullable<ImportState["provider"]>;
      const repo = await getRepository(run.ctx.services, run.ctx.actor, provider.id, value);
      state.repository = { fullName: repo.fullName, defaultBranch: repo.defaultBranch };
      break;
    }
    case "branch":
      state.branch = value;
      break;
    case "project":
      state.project =
        value === "new"
          ? { id: null, name: shortName(state.repository?.fullName ?? "app") }
          : { id: value, name: labelOf(value) };
      break;
    case "server":
      state.server =
        value === HOST_TARGET
          ? { id: HOST_TARGET, name: "Nearzero host", onHost: true }
          : { id: value, name: labelOf(value), onHost: false };
      break;
    case "how":
      state.how = state.howOptions.find((option) => optionValue(option) === value) ?? null;
      state.howOptions = [];
      break;
    default:
      break;
  }
  return advance(run, state);
}

export const gitImportFlow: FlowModule<ImportIntent> = {
  start: (run, intent) => startImport(run, newImportState(intent)),
  resume: resumeImport,
};

/** How long the "come back to this chat" of a Connect button is honored (spec 19.7). */
export const CONNECT_RETURN_MS = GIT_FLOW_MINUTES * 60_000;
