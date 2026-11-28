import {
  createEnvironmentRequestSchema,
  createProjectRequestSchema,
  SERVICE_KIND_LABELS,
  updateProjectRequestSchema,
} from "@nearzero/shared";
import { z } from "zod";
import { createEnvironment } from "../../environments/environments.ts";
import { createProject, updateProject } from "../../projects/projects.ts";
import { defineCapability } from "../capability.ts";
import { type AgentContext, InputRefusal, requireProductionAllowed } from "../context.ts";
import { isGenericProjectName } from "../flows/parse.ts";
import {
  type DeleteConfirmation,
  deleteReply,
  hasProduction,
  prepareDelete,
  productionRefusal,
  runDelete,
  stillConfirmed,
} from "../flows/project-delete.ts";
import { resolveProject, visibleProjects, visibleServices } from "../resolve.ts";
import { asRequest, count, listingRefs, nameRef } from "./common.ts";

/** Spec 20.1: projects and environments. */

/** Names that say nothing (spec 19.7, 20.1); the guided flows use the same rule. */
export { isGenericProjectName };

export const listProjects = defineCapability({
  name: "list_projects",
  area: "projects",
  description:
    "List the projects the person can see, with their environments (and whether each is production) and the services in each.",
  input: z.object({ search: z.string().trim().max(200).optional() }),
  policies: [],
  changes: false,
  label: { running: "Listing projects", done: "Listed projects" },
  async run(ctx, input) {
    const projects = await visibleProjects(ctx);
    const services = await visibleServices(ctx);
    const needle = input.search?.toLowerCase() ?? "";
    const shown = needle
      ? projects.filter((project) => project.name.toLowerCase().includes(needle))
      : projects;
    return {
      target: count(shown.length, "project"),
      refs: listingRefs(shown, services),
      result: {
        projects: shown.map((project) => ({
          id: project.id,
          name: project.name,
          environments: project.environments.map((environment) => ({
            id: environment.id,
            name: environment.name,
            production: environment.isProduction,
            services: services
              .filter((service) => service.environmentId === environment.id)
              .map((service) => ({
                id: service.id,
                name: service.name,
                kind: SERVICE_KIND_LABELS[service.kind],
                status: service.status,
                server: service.serverName,
              })),
          })),
        })),
      },
    };
  },
});

export const readProject = defineCapability({
  name: "read_project",
  area: "projects",
  description:
    "Read one project, or one of its environments: its environments, which is production, and their services with status and server.",
  input: z.object({
    project: nameRef("project"),
    environment: z.string().trim().max(100).optional(),
  }),
  policies: [],
  changes: false,
  label: { running: "Reading project", done: "Read project" },
  startTarget: (input) => input.project,
  async run(ctx, input) {
    const project = await resolveProject(ctx, input.project);
    const services = (await visibleServices(ctx)).filter(
      (service) => service.projectId === project.id,
    );
    const environments = input.environment
      ? project.environments.filter(
          (env) => env.name === input.environment?.toLowerCase() || env.id === input.environment,
        )
      : project.environments;
    const description = await ctx.services.db
      .selectFrom("project")
      .select(["description"])
      .where("id", "=", project.id)
      .executeTakeFirst();
    return {
      target: input.environment ? `${project.name} / ${input.environment}` : project.name,
      refs: listingRefs([{ id: project.id, environments }], services),
      result: {
        project: {
          id: project.id,
          name: project.name,
          description: description?.description ?? "",
        },
        environments: environments.map((environment) => ({
          id: environment.id,
          name: environment.name,
          production: environment.isProduction,
          services: services
            .filter((service) => service.environmentId === environment.id)
            .map((service) => ({
              id: service.id,
              name: service.name,
              kind: SERVICE_KIND_LABELS[service.kind],
              status: service.status,
              server: service.serverName,
            })),
        })),
      },
    };
  },
});

async function makeProject(ctx: AgentContext, name: string, description: string) {
  const created = await createProject(
    ctx.services,
    ctx.actor,
    asRequest(createProjectRequestSchema, { name, description }),
  );
  return {
    target: created.project.name,
    refs: [{ kind: "project" as const, id: created.project.id }],
    result: {
      created: { id: created.project.id, name: created.project.name },
      environments: created.project.environments.map((env) => env.name),
      reply: `Created **${created.project.name}** with a **development** environment.`,
    },
  };
}

export const createProjectCapability = defineCapability({
  name: "create_project",
  area: "projects",
  description:
    'Create a project. It starts with one environment, "development". Pass the name the person gave; without a real name (or a generic one like "new project"), the person is asked for one in a form.',
  input: z.object({
    name: z.string().trim().max(100).optional(),
    description: z.string().trim().max(1000).optional(),
  }),
  policies: ["projects.create"],
  changes: true,
  label: { running: "Creating project", done: "Created project" },
  startTarget: (input) => input.name ?? "",
  async run(ctx, input) {
    if (!input.name || isGenericProjectName(input.name)) {
      return {
        target: "Project name",
        result: { waiting: "The person is asked to name the project in a form." },
        form: {
          form: { kind: "project_name", label: "Project name", suggestion: null },
          waitLabel: "Waiting for a project name",
          context: { description: input.description ?? "" },
        },
      };
    }
    return makeProject(ctx, input.name, input.description ?? "");
  },
  async answer(ctx, context, answer) {
    const name = typeof answer.name === "string" ? answer.name.trim() : "";
    if (answer.outcome !== "named" || name === "") {
      return {
        target: "",
        result: { outcome: "The person didn't name the project; nothing was created." },
      };
    }
    if (isGenericProjectName(name)) {
      return {
        target: name,
        result: { error: "That name is too generic." },
        form: {
          form: { kind: "project_name", label: "Project name", suggestion: null },
          waitLabel: "Waiting for a project name",
          context,
        },
      };
    }
    const sub = ctx.subStep("Creating project", name);
    try {
      const made = await makeProject(ctx, name, String(context.description ?? ""));
      await sub.finish("succeeded", "Created project");
      return made;
    } catch (error) {
      await sub.finish("failed", "Creating project", (error as Error).message);
      throw error;
    }
  },
});

export const updateProjectCapability = defineCapability({
  name: "update_project",
  area: "projects",
  description: "Rename a project or change its description.",
  input: z.object({
    project: nameRef("project"),
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(1000).optional(),
  }),
  policies: ["projects.rename"],
  changes: true,
  label: { running: "Updating project", done: "Updated project" },
  startTarget: (input) => input.project,
  async run(ctx, input) {
    const project = await resolveProject(ctx, input.project);
    const updated = await updateProject(
      ctx.services,
      ctx.actor,
      project.id,
      asRequest(updateProjectRequestSchema, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      }),
    );
    return {
      target: updated.project.name,
      refs: [{ kind: "project", id: project.id }],
      result: {
        updated: {
          id: project.id,
          name: updated.project.name,
          description: updated.project.description,
        },
      },
    };
  },
});

export const createEnvironmentCapability = defineCapability({
  name: "create_environment",
  area: "projects",
  description:
    'Create an environment in a project. The name is normalized to lowercase with dashes; "prod" and "prd" are refused in favor of "production". It starts with no variable values; the project\'s services are copied in, not deployed, with variable names only.',
  input: z.object({
    project: nameRef("project"),
    name: z.string().trim().min(1).max(64),
    description: z.string().max(1000).optional(),
  }),
  policies: ["projects.rename"],
  changes: true,
  label: { running: "Creating environment", done: "Created environment" },
  startTarget: (input) => `${input.name} in ${input.project}`,
  async run(ctx, input) {
    const project = await resolveProject(ctx, input.project);
    const request = asRequest(createEnvironmentRequestSchema, {
      name: input.name,
      description: input.description ?? "",
      variables: { from: null, values: false },
    });
    requireProductionAllowed(ctx, request.name);
    const created = await createEnvironment(ctx.services, ctx.actor, project.id, request);
    return {
      target: `${created.environment.name} in ${project.name}`,
      refs: [{ kind: "project", id: project.id }],
      result: {
        created: {
          id: created.environment.id,
          name: created.environment.name,
          project: project.name,
        },
        message: created.message,
        copiedServices: created.copiedServices,
        notCopied: created.notCopied,
        note: "Copied services are not deployed, and their variables have names only.",
      },
    };
  },
});

export const deleteProjectCapability = defineCapability({
  name: "delete_project",
  area: "projects",
  description:
    "Delete a project and remove all its services from their servers. The person always confirms in a form first (unless the project is empty). A project with a production environment is never deleted by the Agent.",
  input: z.object({ project: nameRef("project") }),
  policies: ["projects.delete-without-production"],
  changes: true,
  label: { running: "Deleting project", done: "Deleted project" },
  startTarget: (input) => input.project,
  async run(ctx, input) {
    const project = await resolveProject(ctx, input.project);
    if (await hasProduction(ctx, project)) {
      throw new InputRefusal(productionRefusal(project.name));
    }
    const prepared = await prepareDelete(ctx, project);
    if (prepared.kind === "empty") return deleted(ctx, prepared.confirmation);
    return {
      target: project.name,
      refs: [{ kind: "project", id: project.id }],
      result: { waiting: "The person is asked to confirm the delete in a form." },
      form: {
        form: prepared.form,
        waitLabel: "Waiting for your confirmation",
        context: { ...prepared.confirmation },
      },
    };
  },
  async answer(ctx, context, answer) {
    const confirmation = context as unknown as DeleteConfirmation;
    if (answer.outcome !== "delete") {
      return {
        target: confirmation.name,
        result: {
          outcome: `The person chose to keep ${confirmation.name}. Nothing was deleted.`,
        },
      };
    }
    if (!(await stillConfirmed(ctx, confirmation))) {
      // Its services changed in between: the person confirms the new list (spec 19.7).
      const prepared = await prepareDelete(
        ctx,
        { id: confirmation.projectId, name: confirmation.name },
        true,
      );
      if (prepared.kind === "empty") return deleted(ctx, prepared.confirmation);
      return {
        target: confirmation.name,
        result: { outcome: "The project's services changed, so the person is asked again." },
        form: {
          form: prepared.form,
          waitLabel: "Waiting for your confirmation",
          context: { ...prepared.confirmation },
        },
      };
    }
    return deleted(ctx, confirmation);
  },
});

/** Runs a confirmed delete with a row per service; the model gets the table and the outcome. */
async function deleted(ctx: AgentContext, confirmation: DeleteConfirmation) {
  const outcome = await runDelete(ctx, confirmation);
  return {
    target: confirmation.name,
    refs: [{ kind: "project" as const, id: confirmation.projectId }],
    result: {
      state: outcome.state,
      message: outcome.message,
      projectKept: outcome.kept,
      table: outcome.table,
      reply: deleteReply(confirmation.name, outcome, `**${confirmation.name}**`),
    },
    ...(outcome.state === "failed" || outcome.kept ? { failed: outcome.message } : {}),
  };
}

export const projectCapabilities = [
  listProjects,
  readProject,
  createProjectCapability,
  updateProjectCapability,
  createEnvironmentCapability,
  deleteProjectCapability,
];
