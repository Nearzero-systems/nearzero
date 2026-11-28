import { type AgentFormAnswer, DATABASE_KINDS } from "@nearzero/shared";
import { HOST_TARGET } from "../../runners/hub.ts";
import { readAppSettings } from "../../service-runtime/app-settings.ts";
import { loadService } from "../../services/records.ts";
import { matchByName, type ServiceRef, visibleServices } from "../resolve.ts";
import {
  type DeployState,
  deployLoop,
  firstVariablesQuestion,
  needsFirstVariables,
  newDeployState,
} from "./deploy-loop.ts";
import { newImportState, resumeImport, startImport } from "./git-import.ts";
import {
  type FlowModule,
  type FlowResult,
  type FlowRun,
  type FlowState,
  picker,
  refuse,
} from "./kit.ts";
import { isDatabaseWord } from "./parse.ts";

/**
 * "deploy <name>" (spec 19.7): one app or Compose service by that name (typos tolerated) is
 * deployed through the keep-going loop, with the variables form first when it was never
 * deployed and has none; several are offered in a picker; none means a repository of that name
 * to import, unless it names a database, which is the model's.
 */

interface PickState extends FlowState {
  stage: "pick";
  name: string;
  offered: string[];
}

const DATABASES = new Set<string>(DATABASE_KINDS);

async function deployService(run: FlowRun, service: ServiceRef): Promise<FlowResult> {
  const row = await loadService(run.ctx.services.db, run.ctx.actor.workspace.id, service.id);
  const source = readAppSettings(row?.settings ?? null).source;
  const repository =
    source?.type === "provider" ? source.repository : source?.type === "git" ? source.url : null;
  const branch = source && "branch" in source ? (source.branch ?? null) : null;
  const state = newDeployState({
    serviceId: service.id,
    serviceName: service.name,
    serverName: service.serverName,
    onHost: service.serverId === HOST_TARGET,
    environmentName: service.environmentName,
    projectName: service.projectName,
    repository,
    branch,
    exampleNames: [],
  });
  const refused = await refuse(run, ["services.deploy"], "deploy_service", service.name);
  if (refused) return refused;
  if (run.ctx.policies["services.configure"] && (await needsFirstVariables(run, service.id))) {
    return firstVariablesQuestion(state);
  }
  return deployLoop(run, state);
}

export const deployNameFlow: FlowModule<{ name: string }> = {
  async start(run, intent) {
    const all = await visibleServices(run.ctx);
    const runnable = all.filter(
      (service) => service.kind === "application" || service.kind === "compose",
    );
    const match = matchByName(runnable, intent.name);
    if (match.kind === "one") return deployService(run, match.item);
    if (match.kind === "many") {
      const state: PickState = {
        stage: "pick",
        name: intent.name,
        offered: match.items.map((service) => service.id),
      };
      return {
        kind: "ask",
        form: picker(
          "service",
          `More than one service is called "${intent.name}". Which one should I deploy?`,
          match.items.map((service) => ({
            value: service.id,
            label: `${service.projectName} / ${service.environmentName}`,
            description: `on ${service.serverName}`,
          })),
        ),
        waitLabel: "Waiting for a service",
        state,
      };
    }
    // A database (by kind or by name) is the model's: it deploys those directly.
    const databases = all.filter((service) => DATABASES.has(service.kind));
    if (isDatabaseWord(intent.name) || matchByName(databases, intent.name).kind !== "none") {
      return { kind: "model" };
    }
    return startImport(
      run,
      newImportState(
        {
          repository: intent.name,
          provider: null,
          project: null,
          server: null,
          branch: null,
          deploy: true,
          name: null,
          builder: null,
          folder: null,
        },
        intent.name,
      ),
    );
  },

  async resume(run: FlowRun, state: FlowState, answer: AgentFormAnswer) {
    if (state.stage !== "pick") return resumeImport(run, state, answer);
    const pick = state as PickState;
    const value =
      answer.outcome === "chosen" &&
      typeof answer.option === "string" &&
      pick.offered.includes(answer.option)
        ? answer.option
        : null;
    const service = value
      ? (await visibleServices(run.ctx)).find((item) => item.id === value)
      : undefined;
    if (!service) {
      run.say(`Nothing was deployed: none of the services called "${pick.name}" was chosen.`);
      return { kind: "done", summary: `The person didn't choose which "${pick.name}" to deploy.` };
    }
    return deployService(run, service);
  },
};

export type { DeployState };
