import { NEARZERO_LABELS } from "@nearzero/shared";
import { serverOf } from "../service-runtime/runtime.ts";
import { reasonOf } from "../service-runtime/server-ops.ts";
import type { ServiceRow } from "../services/records.ts";
import type { ControlServices } from "../services.ts";
import { composeInventory, parseComposeFile } from "./model.ts";
import { savedInventory } from "./plan.ts";
import { composeSourceOf } from "./source.ts";

/**
 * A stack's volumes for volume backups (spec 17.3): the volumes its own file declares (for a
 * repository, as read at its last deploy or Preview) plus the volumes on its server that carry
 * the stack's labels (Compose's project label, or Nearzero's service label). Never chosen by
 * name prefix. The backups area builds its section on this (`stackVolumes`).
 */

export interface StackVolume {
  /** The Docker volume name. */
  name: string;
  /** Its key in the file's volumes: section, when the file declares it. */
  key: string | null;
  declared: boolean;
  labelled: boolean;
  /** Declared as external: it exists outside the stack. */
  external: boolean;
  /** The inner services that mount it, from the file. */
  innerServices: string[];
}

export interface StackVolumes {
  volumes: StackVolume[];
  /** False when the server couldn't be asked; only the file's volumes are listed then. */
  checkedServer: boolean;
  message: string | null;
}

export function declaredVolumes(row: Pick<ServiceRow, "settings" | "app_name">) {
  const source = composeSourceOf(row.settings);
  if (source?.type === "raw") {
    const parsed = parseComposeFile(source.composeFile);
    return parsed.ok ? composeInventory(parsed.model, row.app_name).volumes : [];
  }
  return savedInventory(row.settings)?.volumes ?? [];
}

export async function stackVolumes(
  services: ControlServices,
  row: ServiceRow,
): Promise<StackVolumes> {
  const found = new Map<string, StackVolume>();
  for (const volume of declaredVolumes(row)) {
    found.set(volume.name, {
      name: volume.name,
      key: volume.key,
      declared: true,
      labelled: false,
      external: volume.external,
      innerServices: volume.innerServices,
    });
  }
  let checkedServer = false;
  let message: string | null = null;
  if (row.status !== "idle") {
    try {
      const target = serverOf(row);
      const lists = await Promise.all(
        [`com.docker.compose.project=${row.app_name}`, `${NEARZERO_LABELS.service}=${row.id}`].map(
          (label) =>
            services.runners.command(
              target,
              "volume.list",
              { labels: [label] },
              { timeoutMs: 8_000 },
            ) as Promise<{ Name: string }[]>,
        ),
      );
      checkedServer = true;
      for (const volume of lists.flat()) {
        const existing = found.get(volume.Name);
        if (existing) existing.labelled = true;
        else {
          found.set(volume.Name, {
            name: volume.Name,
            key: null,
            declared: false,
            labelled: true,
            external: false,
            innerServices: [],
          });
        }
      }
    } catch (error) {
      message = `Only the volumes in the Compose file are listed. The server couldn't be asked: ${reasonOf(error)}`;
    }
  }
  return {
    volumes: [...found.values()].sort((a, b) => a.name.localeCompare(b.name)),
    checkedServer,
    message,
  };
}
