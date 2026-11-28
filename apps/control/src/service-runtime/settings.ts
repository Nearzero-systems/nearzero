import {
  AppError,
  type AppSourceRequest,
  type BuildSettingsRequest,
  DEFAULT_COMPOSE_PATH,
  type deploySettingsRequestSchema,
  type mountsRequestSchema,
  PORTS_NOTE,
  parseGitUrl,
  type portsRequestSchema,
} from "@nearzero/shared";
import type { z } from "zod";
import { recordAudit } from "../audit/audit.ts";
import { portConflicts } from "../deploys/pipeline.ts";
import { auditActor, type WorkspaceActor } from "../http/actor.ts";
import {
  type ServiceRow,
  type ServiceView,
  secretsContext,
  serviceView,
} from "../services/records.ts";
import type { ControlServices } from "../services.ts";
import type { StoredUpload } from "../sources/uploads.ts";
import {
  type AppMount,
  type AppSecrets,
  type AppSource,
  mountVolume,
  readAppSettings,
  readSource,
  registryHost,
} from "./app-settings.ts";
import { checkMountsOnSave } from "./host-mounts.ts";
import { serviceForAction } from "./runtime.ts";

/**
 * Changing an application's source, builder, ports, mounts and deploy settings (spec 6.3, 6.4,
 * 6.6, 6.8). All need configure rights on the service ("Create services" for members); changes
 * apply on the next deploy. Secrets (a registry password, file contents) are sealed with the
 * service's other secrets and never come back.
 */

const APPLICATIONS_ONLY = "Only applications have this setting.";

async function applicationFor(services: ControlServices, actor: WorkspaceActor, serviceId: string) {
  const row = await serviceForAction(services, actor, serviceId, "service.configure");
  if (row.kind !== "application") throw new AppError("conflict", APPLICATIONS_ONLY);
  const sealed = await services.db
    .selectFrom("service")
    .select("secrets_sealed")
    .where("id", "=", row.id)
    .executeTakeFirstOrThrow();
  let secrets: AppSecrets = {};
  if (sealed.secrets_sealed) {
    const opened = services.secrets.open(sealed.secrets_sealed, secretsContext(row.id));
    if (opened.ok) secrets = JSON.parse(opened.value) as AppSecrets;
  }
  return { row, secrets };
}

async function save(
  services: ControlServices,
  actor: WorkspaceActor,
  serviceId: string,
  settings: Record<string, unknown>,
  secrets: AppSecrets | null,
  action: string,
  details: Record<string, unknown>,
): Promise<ServiceView> {
  const saved = await services.db
    .updateTable("service")
    .set({
      settings: JSON.stringify(settings),
      ...(secrets
        ? {
            secrets_sealed: services.secrets.seal(
              JSON.stringify(secrets),
              secretsContext(serviceId),
            ),
          }
        : {}),
      updated_at: new Date(),
    })
    .where("id", "=", serviceId)
    .returningAll()
    .executeTakeFirstOrThrow();
  await recordAudit(services.db, services.log, auditActor(actor), {
    action,
    workspaceId: actor.workspace.id,
    target: { kind: "service", id: serviceId },
    details,
  });
  return serviceView(saved, actor.access);
}

type GitUrlRequest = Extract<AppSourceRequest, { type: "git" }>;

/** Checks a Git URL source: the URL, and the SSH key when one is picked (spec 6.3). */
async function checkGitUrl(
  services: ControlServices,
  actor: WorkspaceActor,
  input: GitUrlRequest,
  notes: string[],
): Promise<string> {
  const parsed = parseGitUrl(input.url);
  if ("problem" in parsed)
    throw new AppError("invalid_request", parsed.problem, { fields: { url: parsed.problem } });
  if (input.sshKeyId) {
    await actor.access.require("ssh-keys.use");
    const key = await services.db
      .selectFrom("ssh_key")
      .select("id")
      .where("id", "=", input.sshKeyId)
      .where("workspace_id", "=", actor.workspace.id)
      .executeTakeFirst();
    if (!key) {
      throw new AppError("invalid_request", "Saved SSH key not found.", {
        fields: { sshKeyId: "Saved SSH key not found." },
      });
    }
    if (parsed.transport !== "ssh") {
      notes.push("An SSH key is only used with SSH URLs (git@host:owner/repo).");
    }
  } else if (parsed.transport === "ssh") {
    notes.push("SSH URLs need a deploy key: pick one, or use the repository's HTTPS URL.");
  }
  return parsed.url;
}

/**
 * A Compose service's Git tab (spec 07 7.2, 21.10): the repository's URL, branch and Compose file
 * path, read by the Compose runtime's `{ type: "git" }` source. Pushes and watch paths stay with
 * the provider tabs. Applies on the next deploy.
 */
async function saveComposeGitUrl(
  services: ControlServices,
  actor: WorkspaceActor,
  row: ServiceRow,
  input: AppSourceRequest,
): Promise<{ service: ServiceView; notes: string[] }> {
  if (input.type !== "git") {
    throw new AppError(
      "conflict",
      "A Compose service takes its file from a repository or from Raw (the pasted file).",
    );
  }
  const notes: string[] = [];
  const url = await checkGitUrl(services, actor, input, notes);
  const previous = readSource(row.settings?.source);
  const settings: Record<string, unknown> = {
    ...(row.settings ?? {}),
    source: {
      type: "git",
      url,
      branch: input.branch,
      buildPath: "",
      composePath: input.composePath || DEFAULT_COMPOSE_PATH,
      sshKeyId: input.sshKeyId,
      trigger: "push",
      watchPaths: [],
      submodules: input.submodules,
    },
  };
  // A new Git source turns Autodeploy on (spec 6.6: on by default for Git sources).
  if (previous?.type !== "git" && previous?.type !== "provider") {
    settings.deploy = { ...readAppSettings(row.settings).deploy, autodeploy: true };
  }
  const service = await save(services, actor, row.id, settings, null, "service.source-changed", {
    type: "git",
  });
  return { service, notes };
}

export async function saveSource(
  services: ControlServices,
  actor: WorkspaceActor,
  serviceId: string,
  input: AppSourceRequest,
): Promise<{ service: ServiceView; notes: string[] }> {
  const target = await serviceForAction(services, actor, serviceId, "service.configure");
  if (target.kind === "compose") return saveComposeGitUrl(services, actor, target, input);
  const { row, secrets } = await applicationFor(services, actor, serviceId);
  const settings = { ...(row.settings ?? {}) };
  const previous = readAppSettings(row.settings).source;
  const notes: string[] = [];
  let source: AppSource;
  const nextSecrets: AppSecrets = { ...secrets };
  if (input.type === "git") {
    const url = await checkGitUrl(services, actor, input, notes);
    source = {
      type: "git",
      url,
      branch: input.branch,
      buildPath: input.buildPath,
      sshKeyId: input.sshKeyId,
      trigger: input.trigger,
      watchPaths: input.watchPaths,
      submodules: input.submodules,
    };
    delete nextSecrets.registryPassword;
  } else if (input.type === "image") {
    // A saved password stays only for the same login at the same registry (B1-09): it must
    // never be sent to another one because someone changed the image. Docker sends a pull's
    // login to the registry the image names, whatever address is typed beside it (C1-02), so
    // the image's own registry must stay the same as well as the typed address.
    const keepPassword =
      input.registry.password === "" &&
      previous?.type === "image" &&
      previous.registry?.username === input.registry.username &&
      registryHost(previous.image, "") === registryHost(input.image, "") &&
      registryHost(previous.image, previous.registry?.address ?? "") ===
        registryHost(input.image, input.registry.address);
    if (input.registry.password !== "") nextSecrets.registryPassword = input.registry.password;
    else if (!keepPassword || !input.registry.username) delete nextSecrets.registryPassword;
    source = {
      type: "image",
      image: input.image,
      registry: input.registry.username
        ? {
            address: input.registry.address,
            username: input.registry.username,
            passwordSet: Boolean(nextSecrets.registryPassword),
          }
        : null,
    };
  } else {
    source = {
      type: "upload",
      buildPath: input.buildPath,
      upload: previous?.type === "upload" ? previous.upload : null,
    };
    delete nextSecrets.registryPassword;
    if (!source.upload) notes.push("Upload a .zip archive, then deploy.");
  }
  settings.source = source;
  // A new Git source turns Autodeploy on (spec 6.6: on by default for Git sources).
  if (source.type === "git" && previous?.type !== "git") {
    settings.deploy = { ...readAppSettings(row.settings).deploy, autodeploy: true };
  }
  const service = await save(
    services,
    actor,
    row.id,
    settings,
    nextSecrets,
    "service.source-changed",
    {
      type: source.type,
    },
  );
  return { service, notes };
}

export async function recordUpload(
  services: ControlServices,
  actor: WorkspaceActor,
  serviceId: string,
  upload: StoredUpload,
  buildPath: string,
): Promise<ServiceView> {
  const { row } = await applicationFor(services, actor, serviceId);
  const settings = {
    ...(row.settings ?? {}),
    source: { type: "upload", buildPath, upload } satisfies AppSource,
  };
  return save(services, actor, row.id, settings, null, "service.source-uploaded", {
    sizeBytes: upload.sizeBytes,
  });
}

export async function saveBuild(
  services: ControlServices,
  actor: WorkspaceActor,
  serviceId: string,
  input: BuildSettingsRequest,
): Promise<ServiceView> {
  const { row } = await applicationFor(services, actor, serviceId);
  const settings = { ...(row.settings ?? {}), build: input.builder, commands: input.commands };
  return save(services, actor, row.id, settings, null, "service.build-changed", {
    builder: input.builder.type,
  });
}

export async function savePorts(
  services: ControlServices,
  actor: WorkspaceActor,
  serviceId: string,
  input: z.output<typeof portsRequestSchema>,
): Promise<{ service: ServiceView; notes: string[] }> {
  const { row } = await applicationFor(services, actor, serviceId);
  const conflicts = await portConflicts(services.db, row, input.ports);
  if (conflicts.length > 0) {
    throw new AppError("conflict", conflicts.join(" "), {
      fields: { ports: conflicts[0] as string },
    });
  }
  const settings = { ...(row.settings ?? {}), ports: input.ports };
  const service = await save(services, actor, row.id, settings, null, "service.ports-changed", {
    count: input.ports.length,
  });
  return { service, notes: [PORTS_NOTE, "Deploy to apply the change."] };
}

export async function saveMounts(
  services: ControlServices,
  actor: WorkspaceActor,
  serviceId: string,
  input: z.output<typeof mountsRequestSchema>,
): Promise<{ service: ServiceView; notes: string[] }> {
  const { row, secrets } = await applicationFor(services, actor, serviceId);
  const current = readAppSettings(row.settings);
  const files: Record<string, string> = {};
  // Volumes of other apps, checked first (31b G2-08): the mapping below stays synchronous.
  const sharedVolumes = new Map<string, string>();
  for (const mount of input.mounts) {
    if (mount.type !== "volume" || !mount.of) continue;
    const id = mount.id ?? "";
    sharedVolumes.set(
      `${mount.of}\u0000${mount.name}\u0000${id}`,
      await sharedVolume(services, actor, row, current.mounts, { ...mount, of: mount.of, id }),
    );
  }
  const mounts: AppMount[] = input.mounts.map((mount) => {
    const id = mount.id ?? crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    if (mount.type === "volume" && mount.of) {
      return {
        type: "volume",
        id,
        name: mount.name,
        containerPath: mount.containerPath,
        volume: sharedVolumes.get(
          `${mount.of}\u0000${mount.name}\u0000${mount.id ?? ""}`,
        ) as string,
        sharedFrom: mount.of,
      };
    }
    if (mount.type === "volume") {
      // A volume a move kept under its own name stays that volume while the mount keeps its name.
      const before = current.mounts.find(
        (item) => item.type === "volume" && item.id === id && item.name === mount.name,
      );
      const volume = before?.type === "volume" ? before.volume : undefined;
      return {
        type: "volume",
        id,
        name: mount.name,
        containerPath: mount.containerPath,
        ...(volume ? { volume } : {}),
      };
    }
    if (mount.type === "bind") {
      return {
        type: "bind",
        id,
        hostPath: mount.hostPath,
        containerPath: mount.containerPath,
        readOnly: mount.readOnly,
      };
    }
    const kept = mount.content ?? secrets.files?.[id];
    if (kept === undefined) {
      throw new AppError(
        "invalid_request",
        `Enter the content of the file mounted at ${mount.containerPath}.`,
      );
    }
    files[id] = kept;
    return { type: "file", id, containerPath: mount.containerPath };
  });
  // Bind mounts on the Nearzero host are for instance administrators (spec 24 G3, 30b R2-07).
  const warnings = checkMountsOnSave({
    onHost: row.server_id === null,
    isAdmin: actor.isInstanceAdmin,
    before: current.mounts,
    after: mounts,
  });
  const keptVolumes = new Set(
    mounts
      .filter((mount) => mount.type === "volume")
      .map((mount) => (mount as { name: string }).name),
  );
  // Another app's volume is that app's data: removing the mount never deletes it (G2-08).
  const removedVolumes = current.mounts.flatMap((mount) =>
    mount.type === "volume" && !mount.sharedFrom && !keptVolumes.has(mount.name) ? [mount] : [],
  );
  const toDelete = removedVolumes
    .filter((mount) => input.deleteVolumeData.includes(mount.name))
    .map((mount) => mountVolume(row.app_name, mount));
  // A volume mounted again (by this save, under any mount) is no longer to be deleted (C1-10).
  const mountedNow = new Set(
    mounts.flatMap((mount) => (mount.type === "volume" ? [mountVolume(row.app_name, mount)] : [])),
  );
  const settings = {
    ...(row.settings ?? {}),
    mounts,
    pendingVolumeRemovals: [...new Set([...current.pendingVolumeRemovals, ...toDelete])].filter(
      (volume) => !mountedNow.has(volume),
    ),
  };
  const service = await save(
    services,
    actor,
    row.id,
    settings,
    { ...secrets, files },
    "service.mounts-changed",
    { count: mounts.length, deleteVolumeData: toDelete },
  );
  const notes = [...warnings, "Deploy to apply the change."];
  const keptData = removedVolumes
    .filter((mount) => !input.deleteVolumeData.includes(mount.name))
    .map((mount) => mount.name);
  if (keptData.length > 0) notes.push(`The data of ${keptData.join(", ")} is kept on the server.`);
  if (toDelete.length > 0)
    notes.push("The removed volumes' data is deleted after the next deploy.");
  return { service, notes };
}

const SHARE_REFUSED =
  "Pick a volume of another app in this environment on the same server, one you can configure.";

/**
 * The Docker volume of another app's volume mount this app may mount too (31b G2-08): an app in
 * the same environment and on the same server, which the person may configure. A shared mount
 * saved before stays as it was saved; volumes of other projects, workspaces or servers, or of
 * apps the person can't configure, are never accepted.
 */
async function sharedVolume(
  services: ControlServices,
  actor: WorkspaceActor,
  row: { id: string; environment_id: string; server_id: string | null },
  before: readonly AppMount[],
  mount: { of: string; name: string; id: string },
): Promise<string> {
  const kept = before.find(
    (item) =>
      item.type === "volume" &&
      item.id === mount.id &&
      item.sharedFrom === mount.of &&
      item.name === mount.name,
  );
  if (kept?.type === "volume" && kept.volume) return kept.volume;
  const refuse = (message = SHARE_REFUSED): never => {
    throw new AppError("invalid_request", message, { fields: { mounts: message } });
  };
  if (mount.of === row.id) refuse();
  const other = await serviceForAction(services, actor, mount.of, "service.configure").catch(
    (error: unknown) => {
      if (error instanceof AppError && (error.code === "not_found" || error.code === "forbidden"))
        return refuse();
      throw error;
    },
  );
  if (
    other.kind !== "application" ||
    other.environment_id !== row.environment_id ||
    other.server_id !== row.server_id
  ) {
    refuse();
  }
  const source = readAppSettings(other.settings).mounts.find(
    (item) => item.type === "volume" && item.name === mount.name,
  );
  if (source?.type !== "volume") refuse(`${other.name} has no volume named ${mount.name}.`);
  return mountVolume(other.app_name, source as Extract<AppMount, { type: "volume" }>);
}

/** Volumes of other apps this one may mount (31b G2-08), for the Advanced tab's picker. */
export async function shareableVolumes(
  services: ControlServices,
  actor: WorkspaceActor,
  serviceId: string,
): Promise<{ serviceId: string; serviceName: string; name: string; containerPath: string }[]> {
  const { row } = await applicationFor(services, actor, serviceId);
  let query = services.db
    .selectFrom("service")
    .select(["id", "name", "settings"])
    .where("workspace_id", "=", actor.workspace.id)
    .where("environment_id", "=", row.environment_id)
    .where("kind", "=", "application")
    .where("id", "!=", row.id)
    .where("deleting_run_id", "is", null)
    .orderBy("name");
  query =
    row.server_id === null
      ? query.where("server_id", "is", null)
      : query.where("server_id", "=", row.server_id);
  const out: { serviceId: string; serviceName: string; name: string; containerPath: string }[] = [];
  for (const other of await query.execute()) {
    const allowed = await serviceForAction(services, actor, other.id, "service.configure")
      .then(() => true)
      .catch(() => false);
    if (!allowed) continue;
    for (const mount of readAppSettings(other.settings).mounts) {
      if (mount.type !== "volume" || mount.sharedFrom) continue;
      out.push({
        serviceId: other.id,
        serviceName: other.name,
        name: mount.name,
        containerPath: mount.containerPath,
      });
    }
  }
  return out;
}

export async function saveDeploySettings(
  services: ControlServices,
  actor: WorkspaceActor,
  serviceId: string,
  input: z.output<typeof deploySettingsRequestSchema>,
): Promise<ServiceView> {
  // Compose stacks have the same Autodeploy, Clean cache and stability window (spec 07 7.2).
  const row = await serviceForAction(services, actor, serviceId, "service.configure");
  if (row.kind !== "application" && row.kind !== "compose") {
    throw new AppError("conflict", APPLICATIONS_ONLY);
  }
  const current = readAppSettings(row.settings).deploy;
  const deploy = {
    autodeploy: input.autodeploy ?? current.autodeploy,
    cleanCache: input.cleanCache ?? current.cleanCache,
    stabilitySeconds: input.stabilitySeconds ?? current.stabilitySeconds,
  };
  return save(
    services,
    actor,
    row.id,
    { ...(row.settings ?? {}), deploy },
    null,
    "service.deploy-settings-changed",
    deploy,
  );
}
