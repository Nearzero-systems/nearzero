import { copyAppSettings, publicAppSettings } from "../../service-runtime/app-settings.ts";
import { type KindModule, parseCreateInput, type Settings } from "./common.ts";

/**
 * Applications (spec 06): where the code comes from (`source`), how it is built (`build`, the
 * builder, and `commands`), the port it listens on, published ports, mounts and deploy settings.
 * The deploy engine reads them through service-runtime/app-settings.ts, which also decides what
 * is public and what a copy gets. Secrets (a registry password, file mount contents) are sealed
 * in the service's secrets, never in its settings.
 *
 * source: null (not chosen yet; a copy takes its group's source at its first deploy),
 * { type: "image", image, registry }, { type: "git", url, branch, … } or { type: "upload", … }.
 */

export const applicationKind: KindModule = {
  kind: "application",
  database: false,
  create(raw) {
    const input = parseCreateInput("application", raw) as {
      image: string;
      servicePort?: number;
    };
    return {
      settings: {
        source: input.image ? { type: "image", image: input.image, registry: null } : null,
        build: { type: "automatic" },
        commands: { install: "", build: "", start: "" },
        // Not typed: each deploy works it out from the image (30b R2-01).
        servicePort: input.servicePort ?? 3000,
        ...(input.servicePort === undefined ? { servicePortAuto: true } : {}),
        ports: [],
        mounts: [],
      },
      secrets: null,
    };
  },
  copy(settings) {
    return { settings: copyAppSettings(settings), secrets: null };
  },
  update(settings, raw) {
    const input = raw as { image?: string; servicePort?: number };
    const next: Settings = { ...settings };
    if (input.image !== undefined) {
      next.source = input.image ? { type: "image", image: input.image, registry: null } : null;
    }
    if (input.servicePort !== undefined) {
      // Typed now: it wins over what the image declares.
      next.servicePort = input.servicePort;
      delete next.servicePortAuto;
    }
    return { settings: next, notes: [] };
  },
  publicSettings(settings) {
    return publicAppSettings(settings);
  },
};
