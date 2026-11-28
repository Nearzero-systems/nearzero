import type { Db } from "../db/database.ts";
import { isInstanceAdmin } from "../workspaces/workspaces.ts";
import { type Finding, findingKeys } from "./privileged.ts";

export type { ComposeStackTable } from "./tables.ts";

/**
 * Privileged Compose options on the Nearzero host (spec 07 7.3, 24 G3). The host runs the
 * control plane itself, so host mounts, the Docker socket, the host's network and namespaces,
 * privileged mode, added capabilities and the rest are root on Nearzero. They are refused there
 * for anyone but instance administrators.
 *
 * When an instance administrator deploys a stack with such options, exactly those options in
 * exactly those definitions are remembered as approved (privileged.ts: the keys carry each
 * service's fingerprint). Later deploys by anyone with deploy rights, and push and webhook
 * deploys (which have no person), may run the same again; a new privileged option, or any change
 * to a service that has one, needs an administrator's deploy first. Other Compose files (include,
 * extends with file) are never approved: Compose reads them on the server, so they could say
 * anything by the next deploy.
 */

export function hostRefusal(findings: readonly Finding[]): string {
  const kinds = [...new Set(findings.map((finding) => finding.label.toLowerCase()))].join(", ");
  const unchecked = findings.some((finding) => !finding.approvable)
    ? " Compose files that pull in other files (include, or extends with file) are checked only when a Nearzero administrator deploys them, every time."
    : "";
  return `This Compose file uses options that reach the Nearzero host itself (${kinds}). On the Nearzero host only Nearzero administrators can deploy them.${unchecked} Remove them, or deploy the stack to another server.`;
}

export type HostDecision =
  | { allowed: true; approve: boolean; approvedBefore: boolean }
  | { allowed: false; message: string; unapproved: Finding[] };

export async function approvedKeys(db: Db, serviceId: string): Promise<Set<string>> {
  const row = await db
    .selectFrom("compose_stack")
    .select("approved_keys")
    .where("service_id", "=", serviceId)
    .executeTakeFirst();
  return new Set(row?.approved_keys ?? []);
}

/**
 * Whether these findings may run on the host for this person (null: a push or webhook deploy).
 * Not on the host, everything is allowed (Preview and the log warn instead).
 */
export async function hostDecision(
  db: Db,
  input: {
    serviceId: string;
    onHost: boolean;
    findings: readonly Finding[];
    personId: string | null;
    isAdmin?: boolean;
  },
): Promise<HostDecision> {
  if (!input.onHost || input.findings.length === 0) {
    return { allowed: true, approve: false, approvedBefore: false };
  }
  const admin =
    input.isAdmin ?? (input.personId ? await isInstanceAdmin(db, input.personId) : false);
  if (admin) return { allowed: true, approve: true, approvedBefore: false };
  const approved = await approvedKeys(db, input.serviceId);
  const unapproved = input.findings.filter(
    (finding) => !finding.approvable || !approved.has(finding.key),
  );
  if (unapproved.length === 0) return { allowed: true, approve: false, approvedBefore: true };
  return { allowed: false, message: hostRefusal(unapproved), unapproved };
}

/** Records the options an instance administrator deployed on the host. */
export async function recordApproval(
  db: Db,
  serviceId: string,
  findings: readonly Finding[],
  personId: string | null,
): Promise<void> {
  await db
    .insertInto("compose_stack")
    .values({
      service_id: serviceId,
      approved_keys: findingKeys(findings),
      approved_by: personId,
      approved_at: new Date(),
    })
    .onConflict((conflict) =>
      conflict.column("service_id").doUpdateSet({
        approved_keys: findingKeys(findings),
        approved_by: personId,
        approved_at: new Date(),
        updated_at: new Date(),
      }),
    )
    .execute();
}
