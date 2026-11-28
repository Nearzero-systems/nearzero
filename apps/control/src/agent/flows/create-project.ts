import { type AgentFormAnswer, createProjectRequestSchema } from "@nearzero/shared";
import { createProject } from "../../projects/projects.ts";
import { asRequest } from "../catalog/common.ts";
import {
  audit,
  bold,
  expected,
  type FlowModule,
  type FlowResult,
  type FlowRun,
  type FlowState,
  reasonOf,
  refuse,
  row,
} from "./kit.ts";
import { isGenericProjectName } from "./parse.ts";

/**
 * Create a project (spec 19.7, 20.1): with a usable name it is created at once; without one, or
 * with a generic one, the project-name form asks for it.
 */

const NAME_FORM = {
  form: { kind: "project_name" as const, label: "Project name", suggestion: null },
  waitLabel: "Waiting for a project name",
};

/** Creates it as one row and says so; shared with the Git import's "New project". */
export async function makeProjectRow(run: FlowRun, name: string) {
  const created = await row(
    run,
    { running: "Creating project", done: "Created project" },
    name,
    async () => {
      const made = await createProject(
        run.ctx.services,
        run.ctx.actor,
        asRequest(createProjectRequestSchema, { name, description: "" }),
      );
      return { value: made, target: made.project.name };
    },
  );
  await audit(
    run,
    "create_project",
    created.project.name,
    { name },
    {
      kind: "project",
      id: created.project.id,
    },
  );
  return created;
}

async function create(run: FlowRun, name: string): Promise<FlowResult> {
  const refused = await refuse(run, ["projects.create"], "create_project", name);
  if (refused) return refused;
  try {
    const created = await makeProjectRow(run, name);
    run.say(`Created ${bold(created.project.name)} with a **development** environment.`);
    return { kind: "done", summary: `Created the project ${created.project.name}.` };
  } catch (error) {
    if (!expected(error)) throw error;
    run.say(`I couldn't create ${bold(name)}: ${reasonOf(error)}`);
    return { kind: "done", summary: `Creating the project ${name} failed: ${reasonOf(error)}` };
  }
}

export const createProjectFlow: FlowModule<{ name: string | null }> = {
  async start(run, intent) {
    if (intent.name && !isGenericProjectName(intent.name)) return create(run, intent.name);
    const refused = await refuse(run, ["projects.create"], "create_project", "");
    if (refused) return refused;
    return { kind: "ask", ...NAME_FORM, state: {} };
  },

  async resume(run: FlowRun, _state: FlowState, answer: AgentFormAnswer) {
    const name = typeof answer.name === "string" ? answer.name.trim() : "";
    if (answer.outcome !== "named" || name === "") {
      run.say("No name was given, so I didn't create a project.");
      return { kind: "done", summary: "The person gave no project name; nothing was created." };
    }
    if (isGenericProjectName(name)) {
      run.say(`${bold(name)} doesn't say what the project is for. Give it a name of its own.`);
      return { kind: "ask", ...NAME_FORM, state: {} };
    }
    return create(run, name);
  },
};
