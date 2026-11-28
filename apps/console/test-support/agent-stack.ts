import { FakeModel } from "./fake-model.ts";
import { ApiSession, type Stack, startStack } from "./stack.ts";

/**
 * A throwaway Nearzero for the Agent chat (M11b): the control plane on 4250 and the console on
 * 4550 (or the ports given), a database named nz_m11b_*, and the scripted model server, so no
 * real model provider is ever called. Seeds an owner (Maya) in the workspace "Acme" with the
 * workspace's model key and a project "Shop" holding the app "web", and a member (Sam).
 *
 *   bun test-support/agent-stack.ts     (keeps running; Ctrl+C stops it and drops the database)
 */

export const OWNER = { email: "owner@example.com", password: "agent-password-1" };
export const MEMBER = { email: "sam@example.com", password: "agent-password-2" };

export interface AgentStack {
  stack: Stack;
  model: FakeModel;
  owner: ApiSession;
  member: ApiSession;
  workspace: string;
  projectId: string;
  environmentId: string;
  serviceId: string;
  stop(): Promise<void>;
}

export async function startAgentStack(options: {
  console: "dev" | "built";
  label: string;
  controlPort?: number;
  consolePort?: number;
}): Promise<AgentStack> {
  const model = new FakeModel().start();
  let stack: Stack;
  try {
    stack = await startStack({
      console: options.console,
      label: options.label,
      controlPort: options.controlPort ?? 4250,
      consolePort: options.consolePort ?? 4550,
      databasePrefix: "nz_m11b",
      env: {
        NEARZERO_AGENT_PROVIDER_URL: model.url,
        NEARZERO_AGENT_MODEL: "test/model",
        NEARZERO_AGENT_SMALL_MODEL: "test/small",
        NEARZERO_AGENT_RESEARCH_URL: "http://127.0.0.1:9",
        NEARZERO_DNS_RESOLVERS: "127.0.0.1:9",
      },
    });
  } catch (error) {
    model.stop();
    throw error;
  }
  try {
    await stack.createOwner(OWNER.email, OWNER.password);
    const owner = await ApiSession.signIn(stack.consoleUrl, OWNER.email, OWNER.password);
    await owner.call("POST", "/onboarding/workspace", {
      name: "Maya Lopez",
      workspaceName: "Acme",
    });
    await owner.call("POST", "/onboarding/skip-invitations");
    const { workspace } = await owner.call<{ workspace: { slug: string } }>("GET", "/workspace");
    await owner.call("PUT", "/workspace/keys/model", { key: "sk-or-v1-fake-test-key-0123456789" });
    const project = await owner.call<{ project: { id: string }; environmentId: string }>(
      "POST",
      "/projects",
      { name: "Shop", description: "The storefront" },
    );
    const app = await owner.call<{ service: { id: string } }>(
      "POST",
      `/environments/${project.environmentId}/services`,
      { kind: "application", name: "web", serverId: "host", settings: { servicePort: 3000 } },
    );
    await owner.call("POST", "/workspace/members", {
      email: MEMBER.email,
      role: "member",
      password: MEMBER.password,
    });
    const member = await ApiSession.signIn(stack.consoleUrl, MEMBER.email, MEMBER.password);
    await member.call("POST", "/onboarding/name", { name: "Sam Rivera" });
    return {
      stack,
      model,
      owner,
      member,
      workspace: workspace.slug,
      projectId: project.project.id,
      environmentId: project.environmentId,
      serviceId: app.service.id,
      async stop() {
        await stack.stop();
        model.stop();
      },
    };
  } catch (error) {
    await stack.stop();
    model.stop();
    throw error;
  }
}

if (import.meta.main) {
  const agent = await startAgentStack({ console: "dev", label: "serve" });
  console.log(`Console: ${agent.stack.consoleUrl}/${agent.workspace}/dashboard/agent`);
  console.log(`Owner: ${OWNER.email} / ${OWNER.password}  (database ${agent.stack.databaseName})`);
  console.log(`Session cookie: ${agent.owner.sessionToken()}`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await agent.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise(() => {});
}
