import type { AstroGlobal } from "astro";
import type { EnvironmentView, ProjectView, ServiceDetail } from "./data/index.ts";
import type { DashboardContext } from "./page.ts";
import { openingEnvironment } from "./projects.ts";
import { projectPath, projectsPath } from "./routes.ts";

/**
 * What every page inside a project loads first (spec 5.2): the project, its environments the
 * person can open, and the one in the address. A project out of sight goes back to Projects; an
 * environment that isn't one of them goes to the project's opening environment.
 */

export interface ProjectPage {
  ctx: DashboardContext;
  project: ProjectView;
  environment: EnvironmentView;
  environments: EnvironmentView[];
  canCreateEnvironment: boolean;
}

export async function loadProjectPage(
  astro: AstroGlobal,
  ctx: DashboardContext,
): Promise<ProjectPage | Response> {
  const slug = ctx.workspace.slug;
  const project = await ctx.data.project(astro.params.project ?? "");
  if (!project) return astro.redirect(projectsPath(slug));
  const { list, canCreate } = await ctx.data.environments(project.id);
  const environment = list.find((env) => env.id === astro.params.environment);
  if (!environment) {
    const fallback = openingEnvironment(project);
    return astro.redirect(
      fallback ? projectPath(slug, project.id, fallback.id) : projectsPath(slug),
    );
  }
  return { ctx, project, environment, environments: list, canCreateEnvironment: canCreate };
}

/** A service page's service: it must belong to the environment in the address. */
export async function loadService(
  astro: AstroGlobal,
  page: ProjectPage,
): Promise<ServiceDetail | Response> {
  const service = await page.ctx.data.service(astro.params.service ?? "");
  if (!service || service.environmentId !== page.environment.id) {
    return astro.redirect(
      projectPath(page.ctx.workspace.slug, page.project.id, page.environment.id, "services"),
    );
  }
  return service;
}
