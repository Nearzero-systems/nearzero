import { type KindModule, parseCreateInput, pick, type Settings } from "./common.ts";

/**
 * Compose stacks (spec 07). The format (Compose or Stack) is fixed at creation. `source` is null
 * or { type: "raw", composeFile } for pasted YAML, or a repository source (the Git milestone's)
 * under the same key. Values for ${VAR} placeholders live in the service's variables. The
 * Compose runtime keeps the file's inventory in `composeInventory` (not shown).
 */

// "deploy" holds Autodeploy, Clean cache and the stability window (spec 07 7.2, 06 6.6).
const PUBLIC_KEYS = ["format", "source", "deploy"] as const;

export const composeKind: KindModule = {
  kind: "compose",
  database: false,
  create(raw) {
    const input = parseCreateInput("compose", raw) as {
      format: "compose" | "stack";
      composeFile: string;
    };
    return {
      settings: {
        format: input.format,
        source: input.composeFile ? { type: "raw", composeFile: input.composeFile } : null,
      },
      secrets: null,
    };
  },
  copy(settings) {
    return { settings: pick(settings, PUBLIC_KEYS), secrets: null };
  },
  update(settings, raw) {
    const input = raw as { composeFile?: string };
    const next: Settings = { ...settings };
    if (input.composeFile !== undefined) {
      next.source = input.composeFile ? { type: "raw", composeFile: input.composeFile } : null;
    }
    return {
      settings: next,
      notes: input.composeFile !== undefined ? ["Compose file saved. Deploy to use it."] : [],
    };
  },
  publicSettings(settings) {
    return pick(settings, PUBLIC_KEYS);
  },
};
