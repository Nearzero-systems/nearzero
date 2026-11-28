import { parseEnv, type ResolveResult, resolveVariables } from "@nearzero/shared";
import type { Db } from "../db/database.ts";
import type { SecretBox } from "../security/secret-box.ts";
import { readVariables, UNREADABLE_VARIABLES } from "./store.ts";

/**
 * What a service receives at deploy (spec 05 5.5), for the deployment milestones: the
 * environment's shared variables, then the service's own, references replaced, through the pure
 * {@link resolveVariables}. A failure names what's missing; the deploy log shows it. Values are
 * secrets: callers never log them.
 */
export async function variablesForDeploy(
  db: Db,
  box: SecretBox,
  serviceId: string,
  target: "runtime" | "build",
): Promise<ResolveResult> {
  const service = await db
    .selectFrom("service")
    .select(["id", "workspace_id", "environment_id", "kind"])
    .where("id", "=", serviceId)
    .executeTakeFirstOrThrow();
  const [shared, own] = await Promise.all([
    readVariables(db, box, {
      kind: "environment",
      id: service.environment_id,
      workspaceId: service.workspace_id,
    }),
    readVariables(db, box, { kind: "service", id: service.id, workspaceId: service.workspace_id }),
  ]);
  if (shared.text === null || own.text === null) {
    return { ok: false, errors: [{ name: "", message: UNREADABLE_VARIABLES }] };
  }
  const values = (text: string) =>
    parseEnv(text).variables.map((variable) => ({ name: variable.name, value: variable.value }));
  return resolveVariables({
    shared: values(shared.text),
    own: values(own.text),
    target,
    compose: service.kind === "compose",
  });
}
