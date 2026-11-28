import type { AgentFormAnswer } from "@nearzero/shared";
import { matchByName, normalizeName, type ProjectRef, visibleProjects } from "../resolve.ts";
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
} from "./kit.ts";
import {
  type DeleteConfirmation,
  deleteReply,
  hasProduction,
  prepareDelete,
  productionRefusal,
  runDelete,
  stillConfirmed,
} from "./project-delete.ts";

/**
 * Delete a project (spec 19.7): only an exact project name unless "project" was said; the
 * "Delete projects without production" policy first; near matches, several matches and no
 * match each answered in words; never a project with production; an empty project at once,
 * otherwise the confirmation form.
 */

interface DeleteState extends FlowState {
  /** Names still to handle, in the order given. */
  queue: string[];
  saidProject: boolean;
  confirming: DeleteConfirmation | null;
  summaries: string[];
}

function list(projects: readonly ProjectRef[]): string {
  return projects.map((project) => bold(project.name)).join(", ");
}

async function confirmed(run: FlowRun, state: DeleteState, confirmation: DeleteConfirmation) {
  const outcome = await runDelete(run.ctx, confirmation);
  if (run.ctx.signal.aborted) return "stopped" as const;
  run.say(deleteReply(confirmation.name, outcome, bold(confirmation.name)));
  if (!outcome.kept && outcome.state === "succeeded") {
    await audit(
      run,
      "delete_project",
      confirmation.name,
      { project: confirmation.name },
      {
        kind: "project",
        id: confirmation.projectId,
      },
    );
    state.summaries.push(`Deleted the project ${confirmation.name}.`);
  } else {
    state.summaries.push(
      `Deleting the project ${confirmation.name} didn't finish: ${outcome.message}`,
    );
  }
  return "said" as const;
}

/** Handles the queued names in order, until one needs the confirmation form. */
async function next(run: FlowRun, state: DeleteState): Promise<FlowResult> {
  for (;;) {
    const query = state.queue.shift();
    if (query === undefined) {
      return { kind: "done", summary: state.summaries.join(" ") || "Nothing was deleted." };
    }
    const projects = await visibleProjects(run.ctx);
    const match = matchByName(projects, query);
    if (match.kind === "many") {
      run.say(
        `Multiple projects match "${query}": ${list(match.items)}. Say which one to delete, with its full name.`,
      );
      state.summaries.push(`Several projects match "${query}"; nothing was deleted.`);
      continue;
    }
    if (match.kind === "none") {
      run.say(
        projects.length === 0
          ? `There is no project called "${query}". You don't have any projects yet.`
          : `There is no project called "${query}". Your projects: ${list(projects)}.`,
      );
      state.summaries.push(`No project is called "${query}".`);
      continue;
    }
    const project = match.item;
    if (!match.exact) {
      run.say(`Did you mean ${bold(project.name)}? To delete it, say "delete ${project.name}".`);
      state.summaries.push(`"${query}" only nearly matches ${project.name}; nothing was deleted.`);
      continue;
    }
    if (await hasProduction(run.ctx, project)) {
      run.say(productionRefusal(bold(project.name)));
      state.summaries.push(`${project.name} has production, so it wasn't deleted.`);
      continue;
    }
    try {
      const prepared = await prepareDelete(run.ctx, project);
      if (prepared.kind === "empty") {
        if ((await confirmed(run, state, prepared.confirmation)) === "stopped") {
          return { kind: "stopped" };
        }
        continue;
      }
      state.confirming = prepared.confirmation;
      return {
        kind: "ask",
        form: prepared.form,
        waitLabel: "Waiting for your confirmation",
        state,
      };
    } catch (error) {
      if (!expected(error)) throw error;
      run.say(`I couldn't delete ${bold(project.name)}: ${reasonOf(error)}`);
      state.summaries.push(`Deleting ${project.name} was refused: ${reasonOf(error)}`);
    }
  }
}

export const deleteProjectFlow: FlowModule<{ names: string[]; saidProject: boolean }> = {
  async start(run, intent) {
    if (!intent.saidProject) {
      // Without "project", only exact project names: anything else is the model's (spec 19.7).
      const known = new Set(
        (await visibleProjects(run.ctx)).map((project) => normalizeName(project.name)),
      );
      if (!intent.names.every((name) => known.has(normalizeName(name)))) return { kind: "model" };
    }
    const refused = await refuse(
      run,
      ["projects.delete-without-production"],
      "delete_project",
      intent.names.join(", "),
    );
    if (refused) return refused;
    return next(run, {
      queue: [...intent.names],
      saidProject: intent.saidProject,
      confirming: null,
      summaries: [],
    });
  },

  async resume(run: FlowRun, raw: FlowState, answer: AgentFormAnswer) {
    const state = raw as DeleteState;
    const confirmation = state.confirming;
    state.confirming = null;
    if (!confirmation) return next(run, state);
    if (answer.outcome !== "delete") {
      run.say(`Kept ${bold(confirmation.name)}. Nothing was deleted.`);
      state.summaries.push(`The person kept ${confirmation.name}.`);
      return next(run, state);
    }
    // The policy as it is now, not as it was when the form was shown (spec 19.9, B1-55).
    const refused = await refuse(
      run,
      ["projects.delete-without-production"],
      "delete_project",
      confirmation.name,
    );
    if (refused) return refused;
    try {
      if (!(await stillConfirmed(run.ctx, confirmation))) {
        // Its services changed in between: the person confirms the new list (spec 19.7).
        const prepared = await prepareDelete(
          run.ctx,
          { id: confirmation.projectId, name: confirmation.name },
          true,
        );
        if (prepared.kind === "confirm") {
          state.confirming = prepared.confirmation;
          return {
            kind: "ask",
            form: prepared.form,
            waitLabel: "Waiting for your confirmation",
            state,
          };
        }
        if ((await confirmed(run, state, prepared.confirmation)) === "stopped") {
          return { kind: "stopped" };
        }
        return next(run, state);
      }
      if ((await confirmed(run, state, confirmation)) === "stopped") return { kind: "stopped" };
    } catch (error) {
      if (!expected(error)) throw error;
      run.say(`I couldn't delete ${bold(confirmation.name)}: ${reasonOf(error)}`);
      state.summaries.push(`Deleting ${confirmation.name} failed: ${reasonOf(error)}`);
    }
    return next(run, state);
  },
};
