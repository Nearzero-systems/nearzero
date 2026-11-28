import type { BackupProvider, BackupRunStatus } from "@nearzero/shared/browser";
import { ApiError } from "../api-error.ts";
import { ControlClient } from "../control-client.ts";
import type { DataContext } from "./types.ts";

/**
 * Backups from the control plane (docs/api/backups.md, spec 08 8.3 and 17): the workspace's
 * destinations for Settings → Backups, and one service's Backups panel (schedules, the
 * destinations the viewer may use, the volumes found, recent restores).
 */

export interface DestinationView {
  id: string;
  name: string;
  provider: BackupProvider;
  providerLabel: string;
  endpoint: string;
  bucket: string;
  region: string;
  keys: { savedAt: string; savedBy: string | null; readable: boolean };
  schedules: number;
  createdAt: string;
  updatedAt: string;
}

export interface DestinationList {
  destinations: DestinationView[];
  can: { use: boolean; manage: boolean };
}

export interface BackupRunView {
  id: string;
  operation: "backup" | "restore";
  kind: "database" | "volume";
  status: BackupRunStatus;
  statusLabel: string;
  trigger: "schedule" | "manual";
  scheduleId: string | null;
  service: { id: string | null; name: string };
  destination: { id: string | null; name: string };
  database: string | null;
  volume: string | null;
  file: { key: string; name: string; sizeBytes: number | null } | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  log: { lines: number; bytes: number };
  open: boolean;
}

export interface BackupScheduleView {
  id: string;
  kind: "database" | "volume";
  enabled: boolean;
  stateLabel: "On" | "Paused";
  cron: string;
  scheduleText: string;
  preset: string | null;
  destination: { id: string; name: string } | null;
  folder: string;
  prefix: string;
  keep: number | null;
  keepText: string;
  database: string | null;
  volume: string | null;
  innerService: string | null;
  stopService: boolean;
  nextRunAt: string | null;
  lastRun: BackupRunView | null;
  openRun: BackupRunView | null;
  lastRunText: string;
}

export interface ServiceVolumeView {
  name: string;
  sources: string[];
  sourceLabels: string[];
  innerServices: string[];
  paths: string[];
}

export interface BackupsPanelView {
  kind: "database" | "volume";
  service: { id: string; name: string; appName: string; kind: string };
  schedules: BackupScheduleView[];
  destinations: { id: string; name: string; bucket: string; providerLabel: string }[];
  hasDestinations: boolean;
  notice: { text: string; action: "add-destination" | "ask-admin" | "ask-permission" } | null;
  timeZone: string;
  timeZoneHint: string;
  defaultDatabase: string | null;
  volumes: {
    volumes: ServiceVolumeView[];
    /** Volumes seen but not offered: Nearzero's own, another service's, outside the stack. */
    excluded?: { name: string; reason: string }[];
    checkedServer: boolean;
    note: string | null;
  } | null;
  recentRestores: BackupRunView[];
  can: { manage: boolean; restore: boolean; addDestination: boolean };
}

export interface BackupData {
  /** Settings → Backups; null when the person has no destination rights. */
  destinations(): Promise<DestinationList | null>;
  /** A service's Backups panel; null when the person can't manage its backups. */
  backupsPanel(serviceId: string): Promise<BackupsPanelView | null>;
}

const id = (value: string) => encodeURIComponent(value);

export function backupsData(ctx: DataContext): BackupData {
  const api = new ControlClient(ctx);
  return {
    async destinations() {
      try {
        return await api.get<DestinationList>("/backup-destinations");
      } catch (error) {
        if (error instanceof ApiError && error.code === "forbidden") return null;
        throw error;
      }
    },
    async backupsPanel(serviceId) {
      try {
        return await api.get<BackupsPanelView>(`/services/${id(serviceId)}/backups`);
      } catch (error) {
        if (
          error instanceof ApiError &&
          (error.code === "forbidden" || error.code === "not_found")
        ) {
          return null;
        }
        throw error;
      }
    },
  };
}
