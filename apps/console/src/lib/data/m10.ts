import type {
  AnalyticsStats,
  ChannelType,
  ChannelValue,
  NotificationEvent,
  TaskPlace,
  TaskRunStatus,
  TaskShell,
} from "@nearzero/shared/browser";
import { ApiError } from "../api-error.ts";
import { ControlClient } from "../control-client.ts";
import type { DataContext } from "./types.ts";

/**
 * Tasks, Analytics and notification channels from the control plane (spec 12, 13, 15;
 * docs/api/tasks.md, analytics.md, notifications.md). Monitoring loads in the browser
 * (client/monitoring.ts), since it refreshes every few seconds.
 */

export interface TaskView {
  id: string;
  name: string;
  description: string;
  place: TaskPlace;
  placeLabel: string;
  runsOn: {
    label: string;
    service: {
      id: string;
      name: string;
      projectId: string;
      projectName: string;
      environmentId: string;
      environmentName: string;
      innerService: string | null;
    } | null;
    server: { id: string; name: string } | null;
  };
  shell: TaskShell;
  cron: string;
  scheduleText: string;
  timeZone: string;
  enabled: boolean;
  statusLabel: "Enabled" | "Disabled";
  nextRunAt: string | null;
  nextRunText: string | null;
  lastRun: { id: string; status: TaskRunStatus; statusLabel: string; at: string } | null;
  running: boolean;
  createdVia: "console" | "agent";
  createdAt: string;
  updatedAt: string;
}

export interface TaskList {
  tasks: TaskView[];
  total: number;
  page: number;
  pageSize: number;
  can: { create: boolean };
}

export interface TaskPlaces {
  services: {
    id: string;
    name: string;
    kind: string;
    projectName: string;
    environmentName: string;
    label: string;
    innerServices: string[];
  }[];
  servers: { id: string; name: string }[];
  host: boolean;
}

export interface TaskQuery {
  search?: string;
  status?: string;
  place?: string;
  sort?: string;
  order?: string;
  page?: number;
  pageSize?: number;
}

export interface AnalyticsEntryView {
  id: string;
  at: string;
  method: string;
  host: string;
  path: string;
  status: number;
  durationMs: number;
  client: string;
  fields: Record<string, unknown>;
}

export interface AnalyticsPageView {
  recording: { enabled: boolean; message: string; runnerOnline: boolean };
  settings: {
    enabled: boolean;
    cleanupCron: string;
    cleanupText: string;
    timeZone: string;
    nextCleanupAt: string | null;
    lastCleanupAt: string | null;
    lastCleanupError: string | null;
    appliedAt: string | null;
    applyError: string | null;
  };
  window: { range: string; from: string; to: string };
  stats: AnalyticsStats;
  chart: {
    bucketMs: number;
    label: string;
    buckets: { start: number; requests: number; errors: number }[];
  };
  /** Each with its 4xx and 5xx answers. */
  hosts: { host: string; requests: number; errors: number }[];
  table: {
    entries: AnalyticsEntryView[];
    page: number;
    pages: number;
    pageSize: number;
    total: number;
    rangeText: string;
    sort: "time-desc" | "time-asc";
  };
  source: { sizeBytes: number; limited: boolean; error: string | null };
  note: string;
}

export interface ChannelView {
  id: string;
  name: string;
  type: ChannelType;
  typeLabel: string;
  events: NotificationEvent[];
  eventsText: string;
  settings: Record<string, ChannelValue>;
  secrets: Record<string, { saved: boolean; hint: string | null }>;
  readable: boolean;
  lastDeliveryAt: string | null;
  lastFailure: string | null;
  lastFailureAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelList {
  channels: ChannelView[];
  total: number;
  can: { create: boolean; update: boolean; delete: boolean };
  events: NotificationEvent[];
}

export interface M10Data {
  tasks(query: TaskQuery): Promise<TaskList>;
  taskPlaces(): Promise<TaskPlaces>;
  /** Null when the person isn't an instance administrator. */
  analytics(query: URLSearchParams): Promise<AnalyticsPageView | null>;
  /** Null without channel rights. */
  channels(): Promise<ChannelList | null>;
}

function queryString(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

export function m10Data(ctx: DataContext): M10Data {
  const api = new ControlClient(ctx);
  return {
    tasks: (query) => api.get<TaskList>(`/tasks${queryString({ ...query })}`),
    taskPlaces: async () => (await api.get<{ places: TaskPlaces }>("/tasks/places")).places,
    async analytics(query) {
      const allowed = new URLSearchParams();
      for (const key of ["range", "from", "to", "q", "status", "page", "sort"]) {
        const value = query.get(key);
        if (value) allowed.set(key, value);
      }
      const text = allowed.toString();
      try {
        return await api.get<AnalyticsPageView>(`/analytics${text ? `?${text}` : ""}`);
      } catch (error) {
        if (error instanceof ApiError && error.code === "forbidden") return null;
        throw error;
      }
    },
    async channels() {
      try {
        return await api.get<ChannelList>("/notification-channels");
      } catch (error) {
        if (error instanceof ApiError && error.code === "forbidden") return null;
        throw error;
      }
    },
  };
}
