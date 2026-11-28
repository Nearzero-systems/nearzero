import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Db } from "../db/database.ts";
import type { SecretBox } from "../security/secret-box.ts";
import type { OpenedBundle } from "./bundle.ts";
import type { ImportRun } from "./importer.ts";
import { legacyWebhookPatterns } from "./legacy-fields.ts";
import "./tables.ts";

/**
 * What an import keeps beyond the records (spec 29.5, 29a.9): which 0.1.x install the data came
 * from, the 0.1.x webhook paths 1.0 keeps answering, and volume archives (export --volumes) to
 * restore into each service's new volume before its first deploy on another machine.
 */

export class ImportRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportRefused";
  }
}

export const OTHER_INSTALL =
  "This export comes from a different 0.1.x install than the one imported here before, so their records can't be mixed. Import it into a fresh Nearzero 1.0 install.";

/** Refuses a bundle from another 0.1.x install than an earlier import's (29a.9 installId). */
export async function checkInstallId(db: Db, bundle: OpenedBundle): Promise<void> {
  const installId = bundle.manifest.installId;
  if (!installId) return;
  const earlier = await db
    .selectFrom("migration_import")
    .select("source_install")
    .where("source_install", "<>", installId)
    .where("source_install", "<>", "unknown")
    .executeTakeFirst();
  if (earlier) throw new ImportRefused(OTHER_INSTALL);
}

// ---- Old webhook paths

/** Keeps the 0.1.x deploy and GitHub App webhook paths answering for moved services. */
export async function importWebhookPaths(run: ImportRun, value: unknown): Promise<void> {
  const patterns = legacyWebhookPatterns(value);
  for (const { pattern, kind } of patterns) {
    await run.db
      .insertInto("migration_webhook_path")
      .values({ pattern, kind, import_id: run.importId })
      .onConflict((conflict) => conflict.column("pattern").doUpdateSet({ kind }))
      .execute();
  }
  if (patterns.length > 0) {
    run.report.install.push({
      kind: "install",
      name: "webhooks",
      message: `The 0.1.x webhook addresses keep working (${patterns.map((item) => item.pattern).join(", ")}), so nothing changes at your Git hosts.`,
    });
  }
}

// ---- Volume archives

const PART_BYTES = 4 * 1024 * 1024;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function partKey(secrets: SecretBox): Buffer {
  return secrets.deriveKey("migration volume archives v1");
}

/** One piece sealed for its archive and place: nonce, ciphertext, tag. */
export function sealPart(
  secrets: SecretBox,
  archiveId: string,
  seq: number,
  plain: Uint8Array,
): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", partKey(secrets), iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(`${archiveId}:${seq}`));
  return Buffer.concat([iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

export function openPart(
  secrets: SecretBox,
  archiveId: string,
  seq: number,
  sealed: Buffer,
): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", partKey(secrets), sealed.subarray(0, IV_BYTES), {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(Buffer.from(`${archiveId}:${seq}`));
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  return Buffer.concat([
    decipher.update(sealed.subarray(IV_BYTES, sealed.length - TAG_BYTES)),
    decipher.final(),
  ]);
}

/**
 * Stores each `volumes/<service ref>/<volume>.tar` of the bundle, sealed in pieces, for the
 * service imported now; the move restores it into the service's new volume before its first
 * deploy. On the server the export came from, the volumes are already there and used as they are.
 */
export async function importVolumeArchives(run: ImportRun): Promise<void> {
  const archives = [...run.bundle.files.keys()]
    .map((path) => /^volumes\/([^/]+)\/(.+)\.tar$/.exec(path))
    .filter((match): match is RegExpExecArray => match !== null);
  if (archives.length === 0) return;
  if (run.options.inPlace) {
    run.report.install.push({
      kind: "install",
      name: "volumes",
      message: `This is the server the export came from, so services keep their volumes as they are and the ${archives.length} volume archive${archives.length === 1 ? "" : "s"} in the export aren't needed.`,
    });
    return;
  }
  let stored = 0;
  for (const match of archives) {
    const [path, serviceRef, oldVolume] = match as unknown as [string, string, string];
    const serviceId = run.id("services", serviceRef);
    if (!serviceId || !run.isFresh("services", serviceRef)) continue;
    const volume = run.volumeNames.get(serviceRef)?.get(oldVolume) ?? oldVolume;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/.test(volume)) continue;
    const bytes = run.bundle.files.get(path) as Uint8Array;
    const created = await run.db
      .insertInto("migration_volume_archive")
      .values({
        import_id: run.importId,
        service_id: serviceId,
        volume,
        size_bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      })
      .onConflict((conflict) => conflict.columns(["service_id", "volume"]).doNothing())
      .returning("id")
      .executeTakeFirst();
    if (!created) continue;
    for (let at = 0, seq = 0; at < bytes.length || seq === 0; at += PART_BYTES, seq++) {
      await run.db
        .insertInto("migration_volume_archive_part")
        .values({
          archive_id: created.id,
          seq,
          bytes: sealPart(
            run.services.secrets,
            created.id,
            seq,
            bytes.subarray(at, at + PART_BYTES),
          ),
        })
        .execute();
    }
    stored++;
  }
  if (stored > 0) {
    run.report.install.push({
      kind: "install",
      name: "volumes",
      message: `${stored} volume archive${stored === 1 ? " is" : "s are"} restored into ${stored === 1 ? "its service's new volume" : "their services' new volumes"} before each service's first deploy here.`,
    });
  }
}

/** The archive's plain bytes, piece by piece, for the runner restoring it. */
export async function* archiveBytes(
  db: Db,
  secrets: SecretBox,
  archiveId: string,
): AsyncGenerator<Buffer> {
  for (let seq = 0; ; seq++) {
    const part = await db
      .selectFrom("migration_volume_archive_part")
      .select("bytes")
      .where("archive_id", "=", archiveId)
      .where("seq", "=", seq)
      .executeTakeFirst();
    if (!part) return;
    yield openPart(secrets, archiveId, seq, part.bytes);
  }
}
