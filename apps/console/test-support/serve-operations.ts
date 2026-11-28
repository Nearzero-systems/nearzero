import { connectFakeHost, handoffFolder } from "./fake-runner-link.ts";
import { ApiSession, startStack } from "./stack.ts";

/**
 * `bun test-support/serve-operations.ts`: a throwaway Nearzero for trying the operations pages by
 * hand (deploys, logs, domains, servers, deployments): the control plane on 4200 and the console
 * dev server on 4500 with a database nz_m2d_serve_*, a platform domain, and a pretend host runner
 * so deploys finish without Docker. Owner owner@example.com / owner-password-1. Ctrl+C stops it
 * and drops the database.
 */
const folder = await handoffFolder("serve");
const stack = await startStack({
  console: "dev",
  label: "serve",
  databasePrefix: "nz_m2d",
  controlPort: 4200,
  consolePort: 4500,
  env: {
    NEARZERO_RUNNER_HANDOFF_DIR: folder,
    NEARZERO_PLATFORM_DOMAIN: "apps.example.test",
    NEARZERO_PUBLIC_IP: "203.0.113.10",
    NEARZERO_DNS_RESOLVERS: "127.0.0.1:9",
  },
});
console.log(await stack.createOwner("owner@example.com", "owner-password-1"));
const host = await connectFakeHost(stack.controlUrl, folder);
const owner = await ApiSession.signIn(stack.consoleUrl, "owner@example.com", "owner-password-1");
await owner.call("POST", "/onboarding/workspace", { name: "Maya Lopez", workspaceName: "Acme" });
await owner.call("POST", "/onboarding/skip-invitations");
console.log(
  `Console: ${stack.consoleUrl}  (database ${stack.databaseName}, fake host runner connected)`,
);
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await host.close();
  await stack.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await new Promise(() => {});
