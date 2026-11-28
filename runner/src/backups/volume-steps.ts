import type { HelperStep } from "./helpers.ts";
import { SCRATCH_PATH } from "./helpers.ts";

/**
 * Volume backups and in-place restores (spec 17.3) as helper steps: a tar archive of the volume
 * mounted read-only, and for a restore an integrity check, emptying the volume and unpacking the
 * archive into it. Owners and modes are kept as numbers, so a file owned by a container's user
 * keeps that owner whatever the helper's own user list says.
 *
 * 1.0 writes gzipped archives (`.tar.gz`); 0.1.x wrote plain ones (`<volume>-<time>.tar`), which
 * restore the same way without the decompression (R3-44).
 */

export const ARCHIVE_FILE = "volume.tar.gz";
export const PLAIN_ARCHIVE_FILE = "volume.tar";
const SOURCE = "/source";
const TARGET = "/target";

/** Whether a backup file is a plain (uncompressed) tar archive, as 0.1.x wrote them. */
export function isPlainArchive(key: string): boolean {
  return key.endsWith(".tar");
}

export function archiveFileFor(key: string): string {
  return isPlainArchive(key) ? PLAIN_ARCHIVE_FILE : ARCHIVE_FILE;
}

export function archiveStep(toolsImage: string, volume: string, scratch: string): HelperStep {
  return {
    title: `Archiving the volume ${volume}`,
    image: toolsImage,
    argv: [
      "tar",
      "-c",
      "-z",
      "-p",
      "--numeric-owner",
      "-f",
      `${SCRATCH_PATH}/${ARCHIVE_FILE}`,
      "-C",
      SOURCE,
      ".",
    ],
    mounts: [
      { source: volume, target: SOURCE, readOnly: true },
      { source: scratch, target: SCRATCH_PATH },
    ],
  };
}

export function verifyArchiveStep(toolsImage: string, scratch: string, plain = false): HelperStep {
  return {
    title: "Checking the archive",
    image: toolsImage,
    argv: plain
      ? ["tar", "-t", "-f", `${SCRATCH_PATH}/${PLAIN_ARCHIVE_FILE}`]
      : ["gzip", "-t", `${SCRATCH_PATH}/${ARCHIVE_FILE}`],
    mounts: [{ source: scratch, target: SCRATCH_PATH, readOnly: true }],
    // The listing of a plain archive isn't worth a log line per file.
    captureStdout: plain,
  };
}

export function emptyVolumeStep(toolsImage: string, volume: string): HelperStep {
  return {
    title: `Emptying the volume ${volume}`,
    image: toolsImage,
    argv: ["find", TARGET, "-mindepth", "1", "-delete"],
    mounts: [{ source: volume, target: TARGET }],
  };
}

export function unpackStep(
  toolsImage: string,
  volume: string,
  scratch: string,
  plain = false,
): HelperStep {
  return {
    title: `Unpacking the archive into ${volume}`,
    image: toolsImage,
    argv: [
      "tar",
      "-x",
      ...(plain ? [] : ["-z"]),
      "-p",
      "--numeric-owner",
      "-f",
      `${SCRATCH_PATH}/${plain ? PLAIN_ARCHIVE_FILE : ARCHIVE_FILE}`,
      "-C",
      TARGET,
    ],
    mounts: [
      { source: volume, target: TARGET },
      { source: scratch, target: SCRATCH_PATH, readOnly: true },
    ],
  };
}

/** `df` of the filesystem the scratch volume is on (R3-50): its free space, in kilobytes. */
export function freeSpaceStep(toolsImage: string, scratch: string): HelperStep {
  return {
    title: "Checking the free disk space",
    image: toolsImage,
    argv: ["df", "-P", "-k", SCRATCH_PATH],
    mounts: [{ source: scratch, target: SCRATCH_PATH, readOnly: true }],
    captureStdout: true,
  };
}

/** The available bytes in a `df -P -k` answer, or null. */
export function freeBytes(stdout: string): number | null {
  const line = stdout.trim().split("\n").at(-1) ?? "";
  const fields = line.trim().split(/\s+/);
  const available = Number(fields[3]);
  return fields.length >= 4 && Number.isFinite(available) ? available * 1024 : null;
}
