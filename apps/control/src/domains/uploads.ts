import {
  AppError,
  DAY_MS,
  type updateCertificateSchema,
  type uploadCertificateSchema,
} from "@nearzero/shared";
import type { z } from "zod";
import { recordAudit } from "../audit/audit.ts";
import { auditActor, type WorkspaceActor } from "../http/actor.ts";
import { HOST_TARGET } from "../runners/hub.ts";
import type { ControlServices } from "../services.ts";
import { describeTargets } from "./addresses.ts";
import { reachableTarget } from "./cards.ts";
import { checkKeyMatches, keyContext, parseCertificate, pushUploads } from "./certificates.ts";
import { kickTarget } from "./hostnames.ts";

/**
 * Uploaded certificates (spec 10.7): only for wildcards or a person's own CA. One belongs to one
 * server (fixed after upload); its key is sealed with the install key and only ever sent to that
 * server's router. Saving is all or nothing: the router must take it first.
 */

const NOT_FOUND =
  "This certificate doesn't exist in this workspace, or you don't have access to it.";

export interface UploadView {
  id: string;
  name: string;
  covers: string[];
  server: { id: string; name: string };
  issuer: string;
  expiresAt: string;
  expired: boolean;
  /** "Expires in N days" within 30 days. */
  expiresNote: string | null;
  createdAt: string;
  updatedAt: string;
}

function view(
  row: {
    id: string;
    name: string;
    names: string[];
    target: string;
    issuer: string;
    not_after: Date;
    created_at: Date;
    updated_at: Date;
  },
  serverName: string,
  now = Date.now(),
): UploadView {
  const left = row.not_after.getTime() - now;
  const days = Math.ceil(left / DAY_MS);
  return {
    id: row.id,
    name: row.name,
    covers: row.names,
    server: { id: row.target, name: serverName },
    issuer: row.issuer,
    expiresAt: row.not_after.toISOString(),
    expired: left <= 0,
    expiresNote:
      left <= 0
        ? "Expired"
        : days <= 30
          ? `Expires in ${days} ${days === 1 ? "day" : "days"}`
          : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const COLUMNS = [
  "id",
  "name",
  "names",
  "target",
  "issuer",
  "not_after",
  "created_at",
  "updated_at",
] as const;

export async function listUploads(
  services: ControlServices,
  actor: WorkspaceActor,
): Promise<UploadView[]> {
  await actor.access.require("certificates.manage");
  const rows = await services.db
    .selectFrom("uploaded_certificate")
    .select(COLUMNS)
    .where("workspace_id", "=", actor.workspace.id)
    .orderBy("name")
    .execute();
  const targets = await describeTargets(
    services,
    rows.map((row) => row.target),
  );
  return rows.map((row) => view(row, targets.get(row.target)?.name ?? "Unknown server"));
}

async function rowOrThrow(services: ControlServices, actor: WorkspaceActor, id: string) {
  const row = /^[0-9a-f-]{36}$/.test(id)
    ? await services.db
        .selectFrom("uploaded_certificate")
        .select([...COLUMNS, "certificate_pem", "key_sealed"])
        .where("id", "=", id)
        .where("workspace_id", "=", actor.workspace.id)
        .executeTakeFirst()
    : undefined;
  if (!row) throw new AppError("not_found", NOT_FOUND);
  return row;
}

export async function uploadCertificate(
  services: ControlServices,
  actor: WorkspaceActor,
  input: z.output<typeof uploadCertificateSchema>,
): Promise<UploadView> {
  await actor.access.require("certificates.manage");
  const target = await reachableTarget(services, actor, input.serverId);
  if (target.id === HOST_TARGET && !actor.isInstanceAdmin) {
    throw new AppError(
      "forbidden",
      "Only Nearzero administrators can upload certificates for the Nearzero host.",
    );
  }
  const parsed = parseCertificate(input.certificate);
  const keyPem = checkKeyMatches(parsed.pem, input.privateKey);
  const id = crypto.randomUUID();
  // The router takes it first; nothing is saved when it can't (spec 24 P7).
  await pushUploads(services, target.id, { extra: { id, pem: parsed.pem, keyPem } });
  try {
    await services.db
      .insertInto("uploaded_certificate")
      .values({
        id,
        workspace_id: actor.workspace.id,
        name: input.name,
        target: target.id,
        certificate_pem: parsed.pem,
        key_sealed: services.secrets.seal(keyPem, keyContext(id)),
        names: parsed.names,
        not_before: parsed.notBefore,
        not_after: parsed.notAfter,
        issuer: parsed.issuer,
        fingerprint: parsed.fingerprint,
        created_by: actor.personId,
      })
      .execute();
  } catch (error) {
    await pushUploads(services, target.id, { without: id }).catch(() => {});
    throw error;
  }
  await recordAudit(services.db, services.log, auditActor(actor), {
    action: "certificate.uploaded",
    workspaceId: actor.workspace.id,
    target: { kind: "uploaded_certificate", id },
    details: { name: input.name, names: parsed.names, server: target.id },
  });
  kickTarget(services, target.id);
  const row = await rowOrThrow(services, actor, id);
  return view(row, target.name);
}

export async function updateUpload(
  services: ControlServices,
  actor: WorkspaceActor,
  id: string,
  input: z.output<typeof updateCertificateSchema>,
): Promise<UploadView> {
  await actor.access.require("certificates.manage");
  const row = await rowOrThrow(services, actor, id);
  const target = await reachableTarget(services, actor, row.target);
  let changes: Record<string, unknown> = {};
  const newCertificate = input.certificate?.trim() ? parseCertificate(input.certificate) : null;
  const newKey = input.privateKey?.trim() ? input.privateKey : null;
  if (newCertificate || newKey) {
    const pem = newCertificate?.pem ?? row.certificate_pem;
    let keyPem: string;
    if (newKey) {
      keyPem = checkKeyMatches(pem, newKey);
    } else {
      // "Leave blank to keep the stored private key": it must still fit the new certificate.
      const opened = services.secrets.open(row.key_sealed, keyContext(row.id));
      if (!opened.ok) {
        throw new AppError(
          "conflict",
          "The stored private key can't be read any more. Paste the private key again.",
          {
            fields: { privateKey: "Paste the private key again." },
          },
        );
      }
      keyPem = checkKeyMatches(pem, opened.value);
    }
    await pushUploads(services, row.target, { extra: { id: row.id, pem, keyPem } });
    changes = {
      certificate_pem: pem,
      key_sealed: services.secrets.seal(keyPem, keyContext(row.id)),
      ...(newCertificate
        ? {
            names: newCertificate.names,
            not_before: newCertificate.notBefore,
            not_after: newCertificate.notAfter,
            issuer: newCertificate.issuer,
            fingerprint: newCertificate.fingerprint,
          }
        : {}),
    };
  }
  if (input.name !== undefined) changes.name = input.name;
  if (Object.keys(changes).length > 0) {
    await services.db
      .updateTable("uploaded_certificate")
      .set({ ...changes, updated_at: new Date() })
      .where("id", "=", row.id)
      .execute();
    await recordAudit(services.db, services.log, auditActor(actor), {
      action: "certificate.updated",
      workspaceId: actor.workspace.id,
      target: { kind: "uploaded_certificate", id: row.id },
      details: {
        name: input.name ?? row.name,
        replacedCertificate: newCertificate !== null,
        replacedKey: newKey !== null,
      },
    });
  }
  if (newCertificate || newKey) kickTarget(services, row.target);
  return view(await rowOrThrow(services, actor, id), target.name);
}

export async function deleteUpload(services: ControlServices, actor: WorkspaceActor, id: string) {
  await actor.access.require("certificates.manage");
  const row = await rowOrThrow(services, actor, id);
  // An offline server's router drops it when its runner connects again, which always brings the
  // router's set up to date (R3-20); the record and its key go now either way.
  const online = services.runners.isOnline(row.target);
  if (online) await pushUploads(services, row.target, { without: row.id });
  await services.db.deleteFrom("uploaded_certificate").where("id", "=", row.id).execute();
  await recordAudit(services.db, services.log, auditActor(actor), {
    action: "certificate.deleted",
    workspaceId: actor.workspace.id,
    target: { kind: "uploaded_certificate", id: row.id },
    details: { name: row.name },
  });
  kickTarget(services, row.target);
  return {
    deleted: true,
    message: online
      ? "The router stops using it. Hostnames it covered get Let's Encrypt certificates again."
      : "Deleted. Its server isn't connected, so its router stops using it once the server is back. Hostnames it covered then get Let's Encrypt certificates again.",
  };
}
