import type { BackupProvider, RunnerDestination } from "@nearzero/shared";
import { HELPER_FILES_DIR, type HelperStep, SCRATCH_PATH } from "./helpers.ts";

/**
 * rclone (spec 25 D5: "rclone for S3-compatible storage, called by the runner") as helper steps.
 * The destination's keys go into a config file written into the helper before it starts, never
 * on its command line or in its environment.
 */

export const REMOTE = "nearzero";
const CONFIG = `${HELPER_FILES_DIR}/rclone.conf`;

/** rclone's names for the providers of spec 17.1. */
export const RCLONE_PROVIDERS: Record<BackupProvider, string> = {
  aws: "AWS",
  "cloudflare-r2": "Cloudflare",
  digitalocean: "DigitalOcean",
  wasabi: "Wasabi",
  scaleway: "Scaleway",
  akamai: "Linode",
  minio: "Minio",
  other: "Other",
};

function line(key: string, value: string): string {
  // Values are single lines; the schemas refuse spaces and line breaks in keys.
  return `${key} = ${value.replace(/[\r\n]/g, "")}`;
}

export function rcloneConfig(destination: RunnerDestination): string {
  const region = destination.region && destination.region !== "" ? destination.region : "auto";
  return `${[
    `[${REMOTE}]`,
    line("type", "s3"),
    line("provider", RCLONE_PROVIDERS[destination.provider]),
    line("env_auth", "false"),
    line("access_key_id", destination.accessKeyId),
    line("secret_access_key", destination.secretAccessKey),
    line("endpoint", destination.endpoint),
    line("region", region),
    line("acl", "private"),
    // The key may only reach this bucket (spec 17.1); never try to create it.
    line("no_check_bucket", "true"),
  ].join("\n")}\n`;
}

export function remote(destination: RunnerDestination, key = ""): string {
  return `${REMOTE}:${destination.bucket}${key ? `/${key}` : ""}`;
}

/** Secrets to cut out of every line rclone prints. */
export function destinationSecrets(destination: RunnerDestination): string[] {
  return [destination.accessKeyId, destination.secretAccessKey];
}

const COMMON = ["--config", CONFIG, "--retries", "3", "--low-level-retries", "5"];

function rcloneStep(
  image: string,
  destination: RunnerDestination,
  title: string,
  args: string[],
  extra: Partial<HelperStep> = {},
): HelperStep {
  return {
    title,
    image,
    argv: ["rclone", ...args, ...COMMON],
    files: [{ name: "rclone.conf", content: rcloneConfig(destination) }],
    ...extra,
  };
}

export function uploadStep(
  image: string,
  destination: RunnerDestination,
  scratch: string,
  file: string,
  key: string,
): HelperStep {
  return rcloneStep(
    image,
    destination,
    `Uploading ${key}`,
    [
      "copyto",
      `${SCRATCH_PATH}/${file}`,
      remote(destination, key),
      "--stats",
      "30s",
      "--stats-one-line",
      "--stats-log-level",
      "NOTICE",
    ],
    { mounts: [{ source: scratch, target: SCRATCH_PATH, readOnly: true }] },
  );
}

export function downloadStep(
  image: string,
  destination: RunnerDestination,
  scratch: string,
  key: string,
  file: string,
): HelperStep {
  return rcloneStep(
    image,
    destination,
    `Downloading ${key}`,
    [
      "copyto",
      remote(destination, key),
      `${SCRATCH_PATH}/${file}`,
      "--stats",
      "30s",
      "--stats-one-line",
      "--stats-log-level",
      "NOTICE",
    ],
    { mounts: [{ source: scratch, target: SCRATCH_PATH }] },
  );
}

/** `rclone lsjson --stat` of a file in the scratch volume: its size, from the program itself. */
export function localStatStep(image: string, scratch: string, file: string): HelperStep {
  return {
    title: `Checking the size of ${file}`,
    image,
    argv: ["rclone", "lsjson", "--stat", `${SCRATCH_PATH}/${file}`, "--config", "/dev/null"],
    mounts: [{ source: scratch, target: SCRATCH_PATH, readOnly: true }],
    captureStdout: true,
  };
}

export function remoteStatStep(
  image: string,
  destination: RunnerDestination,
  key: string,
): HelperStep {
  return rcloneStep(
    image,
    destination,
    `Checking ${key} in the bucket`,
    ["lsjson", "--stat", remote(destination, key)],
    { captureStdout: true },
  );
}

export function listStep(
  image: string,
  destination: RunnerDestination,
  prefix: string,
): HelperStep {
  return rcloneStep(
    image,
    destination,
    `Listing ${prefix}`,
    ["lsjson", "--files-only", remote(destination, prefix.replace(/\/$/, ""))],
    { captureStdout: true, okExitCodes: [0, 3] },
  );
}

export function deleteStep(image: string, destination: RunnerDestination, key: string): HelperStep {
  return rcloneStep(image, destination, `Deleting ${key}`, [
    "deletefile",
    remote(destination, key),
  ]);
}

export function testStep(
  image: string,
  destination: RunnerDestination,
  timeoutSeconds: number,
  pinnedHosts: readonly { host: string; address: string }[] = [],
): HelperStep {
  return rcloneStep(
    image,
    destination,
    `Listing the bucket ${destination.bucket}`,
    [
      "lsf",
      "--max-depth",
      "1",
      remote(destination),
      "--contimeout",
      `${Math.max(1, timeoutSeconds - 2)}s`,
      "--timeout",
      `${timeoutSeconds}s`,
    ],
    {
      captureStdout: true,
      timeoutMs: timeoutSeconds * 1000,
      ...(pinnedHosts.length
        ? { extraHosts: pinnedHosts.map((pin) => `${pin.host}:${pin.address}`) }
        : {}),
    },
  );
}

/** The size in an `rclone lsjson --stat` answer, or null. */
export function statSize(stdout: string): number | null {
  try {
    const parsed = JSON.parse(stdout) as { Size?: unknown; IsDir?: unknown };
    if (parsed.IsDir === true) return null;
    return typeof parsed.Size === "number" ? parsed.Size : null;
  } catch {
    return null;
  }
}

/** The files in an `rclone lsjson` answer, as keys under the prefix. */
export function listedFiles(
  stdout: string,
  prefix: string,
): { key: string; size: number; modifiedAt: string }[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(
      (item): item is { Path: string; Size: number; ModTime: string; IsDir?: boolean } =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as { Path?: unknown }).Path === "string" &&
        (item as { IsDir?: unknown }).IsDir !== true,
    )
    .map((item) => ({
      key: `${prefix}${item.Path}`,
      size: typeof item.Size === "number" ? item.Size : 0,
      modifiedAt: typeof item.ModTime === "string" ? item.ModTime : new Date(0).toISOString(),
    }));
}
