import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { formatBytes } from "@nearzero/shared";
import { ArchiveError, type UnzipResult, unzipInto } from "./zip.ts";

/**
 * An uploaded archive (spec 6.3, Upload): the control plane keeps it; the runner downloads it
 * with its own credential, checks the size and SHA-256 it was told, and unpacks it safely into
 * the service's source folder, replacing what was there.
 */

export type ControlFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface ArchiveFetch {
  uploadId: string;
  sha256: string;
  sizeBytes: number;
}

export async function fetchArchive(
  spec: ArchiveFetch,
  folder: string,
  control: ControlFetch,
  signal: AbortSignal,
  onOutput: (text: string) => void,
): Promise<UnzipResult> {
  onOutput(`Downloading the uploaded archive (${formatBytes(spec.sizeBytes)})\n`);
  const response = await control(`/api/v1/runner/uploads/${spec.uploadId}`, { signal });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new ArchiveError(
      response.status === 404
        ? "The uploaded archive isn't on Nearzero any more. Upload it again."
        : `Downloading the archive from Nearzero failed (${response.status}). Try the deploy again.`,
    );
  }
  const hash = createHash("sha256");
  const parts: Uint8Array[] = [];
  let received = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    received += chunk.length;
    if (received > spec.sizeBytes) {
      throw new ArchiveError("The downloaded archive is larger than the upload. Upload it again.");
    }
    hash.update(chunk);
    parts.push(chunk);
  }
  const sum = hash.digest("hex");
  if (received !== spec.sizeBytes || sum !== spec.sha256) {
    throw new ArchiveError(
      "The downloaded archive doesn't match the upload's checksum. Upload it again.",
    );
  }
  const source = join(folder, "source");
  await rm(source, { recursive: true, force: true });
  await mkdir(source, { recursive: true, mode: 0o755 });
  onOutput("Unpacking the archive\n");
  const result = await unzipInto(Buffer.concat(parts), source);
  onOutput(
    `Unpacked ${result.files} files${result.strippedFolder ? ` from ${result.strippedFolder}/` : ""}\n`,
  );
  return result;
}
