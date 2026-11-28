import { createHash } from "node:crypto";
import { AppError, UPLOAD_MAX_BYTES, UPLOAD_TOO_LARGE } from "@nearzero/shared";
import { sql } from "kysely";
import type { Db } from "../db/database.ts";

/**
 * Uploaded .zip archives (spec 6.3, Upload; at most 200 MB). The request body is read as a
 * stream and stored in 1 MB pieces while its SHA-256 is computed, so no request holds the whole
 * archive in memory. The service's runner downloads it with its own credential while a deploy
 * of that service is building on its server, and checks the checksum itself.
 */

const PART_BYTES = 1024 * 1024;
/** The first bytes of every zip archive that has entries ("PK\x03\x04") or is empty ("PK\x05\x06"). */
const ZIP_MAGIC = [0x50, 0x4b];

export interface StoredUpload {
  id: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  uploadedAt: string;
}

export async function storeUpload(
  db: Db,
  input: {
    serviceId: string;
    workspaceId: string;
    personId: string;
    fileName: string;
    body: ReadableStream<Uint8Array> | null;
  },
): Promise<StoredUpload> {
  if (!input.body)
    throw new AppError("invalid_request", "Send the .zip archive as the request body.");
  const id = crypto.randomUUID();
  await db
    .insertInto("source_upload")
    .values({
      id,
      service_id: input.serviceId,
      workspace_id: input.workspaceId,
      file_name: input.fileName,
      size_bytes: 1,
      sha256: "",
      created_by: input.personId,
    })
    .execute();
  const hash = createHash("sha256");
  let size = 0;
  let seq = 0;
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let checkedMagic = false;
  const flush = async () => {
    if (pendingBytes === 0) return;
    const bytes = Buffer.concat(pending);
    pending = [];
    pendingBytes = 0;
    seq++;
    await db.insertInto("source_upload_part").values({ upload_id: id, seq, bytes }).execute();
  };
  try {
    for await (const chunk of input.body as unknown as AsyncIterable<Uint8Array>) {
      if (!checkedMagic && chunk.length >= 2) {
        checkedMagic = true;
        if (chunk[0] !== ZIP_MAGIC[0] || chunk[1] !== ZIP_MAGIC[1]) {
          throw new AppError(
            "invalid_request",
            "That file isn't a .zip archive. Upload a .zip file.",
          );
        }
      }
      size += chunk.length;
      if (size > UPLOAD_MAX_BYTES) throw new AppError("payload_too_large", UPLOAD_TOO_LARGE);
      hash.update(chunk);
      pending.push(chunk);
      pendingBytes += chunk.length;
      if (pendingBytes >= PART_BYTES) await flush();
    }
    await flush();
    if (size === 0)
      throw new AppError("invalid_request", "The archive is empty. Upload a .zip file.");
    const sha256 = hash.digest("hex");
    await db
      .updateTable("source_upload")
      .set({ size_bytes: size, sha256, complete: true })
      .where("id", "=", id)
      .execute();
    // Older archives of this service are no longer needed, except one a build is still
    // downloading (B1-30); the next upload removes that one.
    await db
      .deleteFrom("source_upload")
      .where("service_id", "=", input.serviceId)
      .where("id", "!=", id)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("deployment")
              .select("deployment.id")
              .where("deployment.status", "in", ["queued", "building"])
              .where(sql<boolean>`deployment.source->>'uploadId' = source_upload.id::text`),
          ),
        ),
      )
      .execute();
    return {
      id,
      fileName: input.fileName,
      sizeBytes: size,
      sha256,
      uploadedAt: new Date().toISOString(),
    };
  } catch (error) {
    await db
      .deleteFrom("source_upload")
      .where("id", "=", id)
      .execute()
      .catch(() => {});
    throw error;
  }
}

/**
 * A copy of an archive for another service (B1-30): each service keeps archives of its own, so
 * a new upload or a delete of one never takes away what a copy in another environment builds
 * from. The pieces are copied inside the database. Null when the archive is gone.
 */
export async function cloneUpload(
  db: Db,
  uploadId: string,
  to: { serviceId: string; workspaceId: string },
): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/.test(uploadId)) return null;
  const original = await db
    .selectFrom("source_upload")
    .selectAll()
    .where("id", "=", uploadId)
    .where("workspace_id", "=", to.workspaceId)
    .where("complete", "=", true)
    .executeTakeFirst();
  if (!original) return null;
  // Complete only once every piece is there (callers may or may not be in a transaction).
  const id = crypto.randomUUID();
  await db
    .insertInto("source_upload")
    .values({
      id,
      service_id: to.serviceId,
      workspace_id: to.workspaceId,
      file_name: original.file_name,
      size_bytes: original.size_bytes,
      sha256: original.sha256,
      complete: false,
      created_by: original.created_by,
    })
    .execute();
  await sql`insert into source_upload_part (upload_id, seq, bytes)
    select ${id}::uuid, seq, bytes from source_upload_part where upload_id = ${uploadId}::uuid`.execute(
    db,
  );
  await db.updateTable("source_upload").set({ complete: true }).where("id", "=", id).execute();
  return id;
}

/** The service an archive belongs to, or null when it is gone. */
export async function uploadOwner(db: Db, uploadId: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/.test(uploadId)) return null;
  const row = await db
    .selectFrom("source_upload")
    .select("service_id")
    .where("id", "=", uploadId)
    .executeTakeFirst();
  return row?.service_id ?? null;
}

/**
 * The archive for a runner: only while a deploy of a service that uses it is building on that
 * runner's server. Answers its pieces in order as a stream.
 */
export async function uploadForRunner(
  db: Db,
  uploadId: string,
  runnerTarget: string,
): Promise<{ sizeBytes: number; body: ReadableStream<Uint8Array> } | null> {
  if (!/^[0-9a-f-]{36}$/.test(uploadId)) return null;
  const upload = await db
    .selectFrom("source_upload")
    .select(["id", "size_bytes", "complete"])
    .where("id", "=", uploadId)
    .executeTakeFirst();
  if (!upload?.complete) return null;
  const building = await db
    .selectFrom("deployment")
    .select("id")
    .where("status", "=", "building")
    .where(sql<boolean>`source->>'uploadId' = ${uploadId}`)
    .where((eb) =>
      runnerTarget === "host" ? eb("server_id", "is", null) : eb("server_id", "=", runnerTarget),
    )
    .executeTakeFirst();
  if (!building) return null;
  let seq = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const part = await db
        .selectFrom("source_upload_part")
        .select(["seq", "bytes"])
        .where("upload_id", "=", uploadId)
        .where("seq", ">", seq)
        .orderBy("seq")
        .limit(1)
        .executeTakeFirst();
      if (!part) {
        controller.close();
        return;
      }
      seq = part.seq;
      controller.enqueue(new Uint8Array(part.bytes));
    },
  });
  return { sizeBytes: upload.size_bytes, body };
}
