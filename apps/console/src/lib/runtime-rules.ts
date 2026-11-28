import { absolutePathProblem, formatBytes, volumeNameProblem } from "@nearzero/shared/browser";

/**
 * Small rules for an application's runtime screens (spec 6.3, 6.6, 6.7, 6.8): reading the
 * public settings the API returns, the Logs tab's stream address, and the Ports and Mounts
 * editors' rows. Pure, so the unit tests cover them without a browser.
 */

export interface PortRow {
  containerPort: number;
  publishedPort: number;
  protocol: "tcp" | "udp";
  mode: "routed" | "host";
}

export type MountRow =
  | {
      type: "volume";
      id?: string;
      name: string;
      containerPath: string;
      /** Another app whose volume this mounts (31b G2-08). */
      of?: string;
    }
  | { type: "bind"; id?: string; hostPath: string; containerPath: string; readOnly: boolean }
  | { type: "file"; id?: string; containerPath: string; content?: string };

export interface DeploySettings {
  autodeploy: boolean;
  cleanCache: boolean;
  stabilitySeconds: number;
}

export interface AppSourceView {
  type: "git" | "image" | "upload" | "provider" | null;
  image: string | null;
  registry: { address: string; username: string; passwordSet: boolean } | null;
  url: string | null;
  branch: string | null;
  buildPath: string;
  sshKeyId: string | null;
  watchPaths: string[];
  submodules: boolean;
  trigger: "push" | "tag";
  upload: { id: string; fileName: string; sizeBytes: number; uploadedAt: string } | null;
}

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** The application's source as its Overview shows it (settings.source from the API). */
export function appSource(settings: Record<string, unknown>): AppSourceView {
  const raw = (settings.source ?? null) as Record<string, unknown> | null;
  const type = raw ? (text(raw.type) as AppSourceView["type"]) : null;
  const registry = raw?.registry as AppSourceView["registry"] | undefined;
  const upload = raw?.upload as AppSourceView["upload"] | undefined;
  return {
    type,
    image: raw ? text(raw.image) : null,
    registry: registry && typeof registry === "object" ? registry : null,
    url: raw ? text(raw.url) : null,
    branch: raw ? text(raw.branch) : null,
    buildPath: (raw && text(raw.buildPath)) || "",
    sshKeyId: raw ? text(raw.sshKeyId) : null,
    watchPaths: Array.isArray(raw?.watchPaths) ? (raw.watchPaths as string[]) : [],
    submodules: raw?.submodules === true,
    trigger: raw?.trigger === "tag" ? "tag" : "push",
    upload: upload && typeof upload === "object" ? upload : null,
  };
}

export function deploySettings(settings: Record<string, unknown>): DeploySettings {
  const raw = (settings.deploy ?? {}) as Record<string, unknown>;
  return {
    autodeploy: raw.autodeploy === true,
    cleanCache: raw.cleanCache === true,
    stabilitySeconds: typeof raw.stabilitySeconds === "number" ? raw.stabilitySeconds : 10,
  };
}

export function portRows(settings: Record<string, unknown>): PortRow[] {
  const raw = Array.isArray(settings.ports) ? (settings.ports as Record<string, unknown>[]) : [];
  return raw.flatMap((item) =>
    typeof item.containerPort === "number" && typeof item.publishedPort === "number"
      ? [
          {
            containerPort: item.containerPort,
            publishedPort: item.publishedPort,
            protocol: item.protocol === "udp" ? "udp" : "tcp",
            mode: item.mode === "host" ? "host" : "routed",
          } satisfies PortRow,
        ]
      : [],
  );
}

export function mountRows(settings: Record<string, unknown>): MountRow[] {
  const raw = Array.isArray(settings.mounts) ? (settings.mounts as Record<string, unknown>[]) : [];
  return raw.flatMap((item): MountRow[] => {
    const id = text(item.id) ?? undefined;
    const containerPath = text(item.containerPath) ?? "";
    if (item.type === "volume") {
      const of = text(item.sharedFrom);
      return [
        { type: "volume", id, name: text(item.name) ?? "", containerPath, ...(of ? { of } : {}) },
      ];
    }
    if (item.type === "bind") {
      return [
        {
          type: "bind",
          id,
          hostPath: text(item.hostPath) ?? "",
          containerPath,
          readOnly: item.readOnly === true,
        },
      ];
    }
    if (item.type === "file") return [{ type: "file", id, containerPath }];
    return [];
  });
}

function portNumber(raw: string): number | null {
  if (!/^\d{1,5}$/.test(raw.trim())) return null;
  const value = Number(raw);
  return value >= 1 && value <= 65535 ? value : null;
}

/** Checks the editor's rows; problems name the row ("Row 2: …"), as the form shows them. */
export function checkPortRows(
  rows: { containerPort: string; publishedPort: string; protocol: string; mode: string }[],
): { ports: PortRow[] } | { problem: string; row: number } {
  const ports: PortRow[] = [];
  const seen = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const container = portNumber(row.containerPort);
    const published = portNumber(row.publishedPort);
    if (container === null || published === null) {
      return { problem: "Enter ports from 1 to 65535.", row: index + 1 };
    }
    const protocol = row.protocol === "udp" ? "udp" : "tcp";
    const key = `${published}/${protocol}`;
    if (seen.has(key)) {
      return {
        problem: `Port ${published}/${protocol.toUpperCase()} is listed twice. Keep one.`,
        row: index + 1,
      };
    }
    seen.add(key);
    ports.push({
      containerPort: container,
      publishedPort: published,
      protocol,
      mode: row.mode === "host" ? "host" : "routed",
    });
  }
  return { ports };
}

export function checkMountRows(
  rows: {
    type: string;
    id: string;
    name: string;
    hostPath: string;
    containerPath: string;
    readOnly: boolean;
    content: string;
    /** For a volume of another app: that app's id (31b G2-08). */
    of?: string;
  }[],
): { mounts: MountRow[] } | { problem: string; row: number } {
  const mounts: MountRow[] = [];
  for (const [index, row] of rows.entries()) {
    const at = index + 1;
    const pathProblem = absolutePathProblem(row.containerPath.trim(), "container path");
    if (pathProblem) return { problem: pathProblem, row: at };
    const id = row.id || undefined;
    if (row.type === "volume") {
      const problem = volumeNameProblem(row.name.trim());
      if (problem) return { problem, row: at };
      mounts.push({
        type: "volume",
        id,
        name: row.name.trim(),
        containerPath: row.containerPath.trim(),
        ...(row.of ? { of: row.of } : {}),
      });
    } else if (row.type === "bind") {
      const problem = absolutePathProblem(row.hostPath.trim(), "host path");
      if (problem) return { problem, row: at };
      mounts.push({
        type: "bind",
        id,
        hostPath: row.hostPath.trim(),
        containerPath: row.containerPath.trim(),
        readOnly: row.readOnly,
      });
    } else {
      if (!id && row.content === "") {
        return { problem: "Enter the file's content.", row: at };
      }
      // A saved file mount keeps its content when the box is left empty.
      mounts.push(
        row.content === "" && id
          ? { type: "file", id, containerPath: row.containerPath.trim() }
          : {
              type: "file",
              ...(id ? { id } : {}),
              containerPath: row.containerPath.trim(),
              content: row.content,
            },
      );
    }
  }
  return { mounts };
}

/** The Logs tab's stream address from its controls. */
export function logsUrl(
  serviceId: string,
  choice: { tail: string; since: string; search: string; follow: boolean; container: string },
): string {
  const params = new URLSearchParams();
  params.set("tail", ["100", "500", "1000", "all"].includes(choice.tail) ? choice.tail : "100");
  if (choice.since) {
    const date = new Date(choice.since);
    if (!Number.isNaN(date.getTime())) params.set("since", date.toISOString());
  }
  if (choice.search.trim()) params.set("search", choice.search.trim());
  params.set("follow", choice.follow ? "1" : "0");
  if (choice.container) params.set("container", choice.container);
  return `/api/v1/services/${encodeURIComponent(serviceId)}/logs?${params.toString()}`;
}

/** "12.4 MB" for upload sizes. */
export function sizeLabel(bytes: number): string {
  return formatBytes(bytes, { largest: "MB" });
}
