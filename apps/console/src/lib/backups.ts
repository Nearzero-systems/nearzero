import { type BackupRunStatus, formatBytes } from "@nearzero/shared/browser";

/**
 * Small display rules for backups (spec 08 8.3, 17), shared by the server-rendered panel and
 * the browser code that updates its rows live.
 */

export type RunPill = "ok" | "run" | "warn" | "fail" | "idle";

export function pillOfRun(run: { status: BackupRunStatus } | null | undefined): RunPill {
  if (!run) return "idle";
  if (run.status === "succeeded") return "ok";
  if (run.status === "failed") return "fail";
  if (run.status === "running") return "run";
  return "idle";
}

export function sizeText(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "";
  return formatBytes(bytes);
}
