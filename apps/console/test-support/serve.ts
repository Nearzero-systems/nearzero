import { startStack } from "./stack.ts";

/**
 * `bun test-support/serve.ts`: a throwaway Nearzero for trying the console by hand: the control
 * plane on 4150, the console dev server on 4450, an owner owner@example.com / owner-password-1.
 * Ctrl+C stops both and drops the database.
 */
const stack = await startStack({ console: "dev", label: "serve" });
console.log(await stack.createOwner("owner@example.com", "owner-password-1"));
console.log(`Console: ${stack.consoleUrl}  (database ${stack.databaseName})`);
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await stack.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await new Promise(() => {});
