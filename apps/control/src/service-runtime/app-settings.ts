import {
  type BuilderSettings,
  builderSchema,
  DEFAULT_DEPLOY_SETTINGS,
  dockerVolumeName,
  type GitProviderKind,
  isGitProviderKind,
  type PortMapping,
  portMappingSchema,
} from "@nearzero/shared";

/**
 * An application's settings as the deploy engine reads them (spec 6.3, 6.4, 6.6, 6.8), from the
 * service's `settings` JSON, with defaults for anything not saved yet. Secrets (a registry
 * password, file mount contents) are never here; they live sealed in `secrets_sealed`.
 */

export type AppSource =
  | {
      type: "git";
      url: string;
      branch: string;
      buildPath: string;
      sshKeyId: string | null;
      trigger: "push" | "tag";
      watchPaths: string[];
      submodules: boolean;
    }
  | {
      type: "image";
      image: string;
      registry: { address: string; username: string; passwordSet: boolean } | null;
    }
  | {
      /** A repository through a connected Git provider (spec 16; git-providers/sources.ts). */
      type: "provider";
      /** null once the provider was deleted: "No Git source" until another is picked. */
      providerId: string | null;
      provider: GitProviderKind;
      repository: string;
      repositoryId: string | null;
      branch: string;
      buildPath: string;
      /** Compose services: the Compose file inside the repository. */
      composePath: string | null;
      trigger: "push" | "tag";
      watchPaths: string[];
      submodules: boolean;
    }
  | {
      type: "upload";
      buildPath: string;
      upload: {
        id: string;
        fileName: string;
        sizeBytes: number;
        sha256: string;
        uploadedAt: string;
      } | null;
    };

export type AppMount =
  | {
      type: "volume";
      id: string;
      name: string;
      containerPath: string;
      /**
       * The exact Docker volume, when it isn't `<app name>-<name>`: a volume a move from 0.1.x
       * kept under its own name (spec 29.5 "Volumes"), or another app's (sharedFrom).
       */
      volume?: string;
      /** The app in the same environment and server whose volume this mounts (31b G2-08). */
      sharedFrom?: string;
    }
  | { type: "bind"; id: string; hostPath: string; containerPath: string; readOnly: boolean }
  | { type: "file"; id: string; containerPath: string };

export interface AppSettings {
  source: AppSource | null;
  builder: BuilderSettings;
  commands: { install: string; build: string; start: string };
  servicePort: number;
  /**
   * Nobody typed the service port: each deploy works it out from the image (30b R2-01), and
   * `servicePort` holds what the last deploy found.
   */
  servicePortAuto: boolean;
  ports: PortMapping[];
  mounts: AppMount[];
  deploy: { autodeploy: boolean; cleanCache: boolean; stabilitySeconds: number };
  /** Volumes of removed mounts to delete after the next successful deploy. */
  pendingVolumeRemovals: string[];
}

/** The sealed part of an application's settings. */
export interface AppSecrets {
  registryPassword?: string;
  /** File mount contents, by mount id. */
  files?: Record<string, string>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function readSource(value: unknown): AppSource | null {
  if (!isObject(value)) return null;
  if (value.type === "image" && typeof value.image === "string" && value.image !== "") {
    const registry = isObject(value.registry)
      ? {
          address: text(value.registry.address),
          username: text(value.registry.username),
          passwordSet: value.registry.passwordSet === true,
        }
      : null;
    return { type: "image", image: value.image, registry };
  }
  if (value.type === "git" && typeof value.url === "string") {
    return {
      type: "git",
      url: value.url,
      branch: text(value.branch, "main") || "main",
      buildPath: text(value.buildPath),
      sshKeyId: typeof value.sshKeyId === "string" ? value.sshKeyId : null,
      trigger: value.trigger === "tag" ? "tag" : "push",
      watchPaths: Array.isArray(value.watchPaths)
        ? value.watchPaths.filter((item): item is string => typeof item === "string")
        : [],
      submodules: value.submodules === true,
    };
  }
  if (
    value.type === "provider" &&
    typeof value.repository === "string" &&
    isGitProviderKind(value.provider)
  ) {
    return {
      type: "provider",
      providerId: typeof value.providerId === "string" ? value.providerId : null,
      provider: value.provider,
      repository: value.repository,
      repositoryId: typeof value.repositoryId === "string" ? value.repositoryId : null,
      branch: text(value.branch, "main") || "main",
      buildPath: text(value.buildPath),
      composePath: typeof value.composePath === "string" ? value.composePath : null,
      trigger: value.trigger === "tag" ? "tag" : "push",
      watchPaths: Array.isArray(value.watchPaths)
        ? value.watchPaths.filter((item): item is string => typeof item === "string")
        : [],
      submodules: value.submodules === true,
    };
  }
  if (value.type === "upload") {
    const upload =
      isObject(value.upload) && typeof value.upload.id === "string"
        ? {
            id: value.upload.id,
            fileName: text(value.upload.fileName, "upload.zip"),
            sizeBytes: Number(value.upload.sizeBytes) || 0,
            sha256: text(value.upload.sha256),
            uploadedAt: text(value.upload.uploadedAt),
          }
        : null;
    return { type: "upload", buildPath: text(value.buildPath), upload };
  }
  return null;
}

/**
 * The registry an image's saved login goes to: the address typed for it, else the image's own
 * registry host (a first part with a dot or port, or localhost), else Docker Hub.
 */
export function registryHost(image: string, address: string): string {
  const firstPart = image.split("/")[0] ?? "";
  const host =
    address ||
    (image.includes("/") && /[.:]|^localhost$/.test(firstPart) ? firstPart : "docker.io");
  return host
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
}

const DOCKER_VOLUME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;

/** The Docker volume a volume mount uses: the one it keeps by name, else `<app name>-<name>`. */
export function mountVolume(appName: string, mount: { name: string; volume?: string }): string {
  return mount.volume ?? dockerVolumeName(appName, mount.name);
}

function readMounts(value: unknown): AppMount[] {
  if (!Array.isArray(value)) return [];
  const out: AppMount[] = [];
  for (const item of value) {
    if (!isObject(item) || typeof item.id !== "string" || typeof item.containerPath !== "string") {
      continue;
    }
    if (item.type === "volume" && typeof item.name === "string") {
      const volume =
        typeof item.volume === "string" && DOCKER_VOLUME.test(item.volume) ? item.volume : null;
      const sharedFrom =
        volume && typeof item.sharedFrom === "string" && /^[0-9a-f-]{36}$/.test(item.sharedFrom)
          ? item.sharedFrom
          : null;
      out.push({
        type: "volume",
        id: item.id,
        name: item.name,
        containerPath: item.containerPath,
        ...(volume ? { volume } : {}),
        ...(sharedFrom ? { sharedFrom } : {}),
      });
    } else if (item.type === "bind" && typeof item.hostPath === "string") {
      out.push({
        type: "bind",
        id: item.id,
        hostPath: item.hostPath,
        containerPath: item.containerPath,
        readOnly: item.readOnly === true,
      });
    } else if (item.type === "file") {
      out.push({ type: "file", id: item.id, containerPath: item.containerPath });
    }
  }
  return out;
}

export function readAppSettings(settings: Record<string, unknown> | null): AppSettings {
  const raw = settings ?? {};
  const builder = builderSchema.safeParse(raw.build);
  const commands = isObject(raw.commands) ? raw.commands : {};
  const deploy = isObject(raw.deploy) ? raw.deploy : {};
  const ports = Array.isArray(raw.ports)
    ? raw.ports.flatMap((item) => {
        const parsed = portMappingSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
  return {
    source: readSource(raw.source),
    builder: builder.success ? builder.data : { type: "automatic" },
    commands: {
      install: text(commands.install),
      build: text(commands.build),
      start: text(commands.start),
    },
    servicePort:
      typeof raw.servicePort === "number" && raw.servicePort >= 1 && raw.servicePort <= 65535
        ? raw.servicePort
        : 3000,
    servicePortAuto: raw.servicePortAuto === true,
    ports,
    mounts: readMounts(raw.mounts),
    deploy: {
      autodeploy:
        typeof deploy.autodeploy === "boolean"
          ? deploy.autodeploy
          : DEFAULT_DEPLOY_SETTINGS.autodeploy,
      cleanCache:
        typeof deploy.cleanCache === "boolean"
          ? deploy.cleanCache
          : DEFAULT_DEPLOY_SETTINGS.cleanCache,
      stabilitySeconds:
        typeof deploy.stabilitySeconds === "number"
          ? deploy.stabilitySeconds
          : DEFAULT_DEPLOY_SETTINGS.stabilitySeconds,
    },
    pendingVolumeRemovals: Array.isArray(raw.pendingVolumeRemovals)
      ? raw.pendingVolumeRemovals.filter((item): item is string => typeof item === "string")
      : [],
  };
}

/** What an application's settings may show (spec 23.4 rule 6): nothing secret is in them. */
export function publicAppSettings(
  settings: Record<string, unknown> | null,
): Record<string, unknown> {
  const app = readAppSettings(settings);
  return {
    source: app.source,
    build: app.builder,
    commands: app.commands,
    servicePort: app.servicePort,
    servicePortAuto: app.servicePortAuto,
    ports: app.ports,
    mounts: app.mounts,
    deploy: app.deploy,
  };
}

/**
 * A copy's settings for another environment (spec 5.4): the same source, builder, commands and
 * deploy settings and volume mounts, each a volume of its own named after the copy's app name
 * (a volume a move kept under its 0.1.x name stays the original's alone, B1-05); never the
 * original's bind mounts (a server folder the two would share), published ports, file contents,
 * registry password or uploads in flight.
 */
export function copyAppSettings(settings: Record<string, unknown> | null): Record<string, unknown> {
  const app = readAppSettings(settings);
  const source: AppSource | null =
    app.source?.type === "image" && app.source.registry
      ? { ...app.source, registry: { ...app.source.registry, passwordSet: false } }
      : app.source;
  return {
    source,
    build: app.builder,
    commands: app.commands,
    servicePort: app.servicePort,
    ...(app.servicePortAuto ? { servicePortAuto: true } : {}),
    ports: [],
    mounts: app.mounts.flatMap((mount) =>
      mount.type === "volume"
        ? [
            {
              type: "volume" as const,
              id: mount.id,
              name: mount.name,
              containerPath: mount.containerPath,
            },
          ]
        : [],
    ),
    deploy: app.deploy,
  };
}
