/**
 * The Compose page's shapes and small rules, safe for browser code (spec 07 7.2;
 * docs/api/compose.md). The server's read is lib/data/compose.ts.
 */

export interface ComposeOverview {
  format: "compose" | "stack";
  formatLabel: string;
  formatNote: string | null;
  source: { type: "raw" | "provider" | "git" | null; label: string };
  needsDeploy: boolean;
  needsDeployMessage: string | null;
  deployedAt: string | null;
  deploymentId: string | null;
  services: { name: string; port: number | null }[];
  onHost: boolean;
}

export interface ComposeContainerRow {
  id: string;
  shortId: string;
  name: string;
  service: string;
  state: string;
  status: string;
  image: string;
  current: boolean;
  createdAt: string;
}

export interface ComposePreview {
  available: boolean;
  message: string | null;
  source: string;
  files: { name: string; title: string; description: string; content: string }[];
  warnings: { kind: string; label: string; service: string | null; message: string }[];
  refused: boolean;
  refusal: string | null;
  problems: string[];
  variables: { delivered: string[]; uses: string[]; missing: string[]; note: string };
  notes: string[];
}

/** The row menu's actions, in the spec's order (View logs is the browser's own). */
export const CONTAINER_ROW_ACTIONS = [
  { action: "restart", label: "Restart" },
  { action: "start", label: "Start" },
  { action: "stop", label: "Stop" },
  { action: "kill", label: "Kill" },
] as const;

/** The pill for a container's state. */
export function containerPill(state: string): "ok" | "run" | "warn" | "fail" | "idle" {
  if (state === "running") return "ok";
  if (state === "restarting" || state === "created") return "run";
  if (state === "paused") return "warn";
  if (state === "dead") return "fail";
  return "idle";
}
