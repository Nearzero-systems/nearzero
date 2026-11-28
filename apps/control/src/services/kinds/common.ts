import {
  type ServiceKind,
  serviceSettingsInputSchemas,
  serviceSettingsUpdateSchemas,
} from "@nearzero/shared";
import { check } from "../../http/validate.ts";

/**
 * One module per kind of service. The service record is the same for all eight kinds (name,
 * environment, server, app name, status); what differs lives in `settings` (not secret, stored
 * as JSON) and `secrets` (sealed with the install key, never sent back). Each module checks its
 * own settings, makes a copy's settings for another environment, and says which settings may be
 * shown: anything it doesn't list never leaves the control plane (spec 23.4, rule 6).
 *
 * Later milestones extend the settings here (Git sources, builders, ports, mounts) without
 * touching the record.
 */

export type Settings = Record<string, unknown>;
export type Secrets = Record<string, string>;

export interface KindContext {
  /** The new service's internal app name (volumes are named after it). */
  appName: string;
  generatePassword(): string;
}

export interface MadeSettings {
  settings: Settings;
  /** null when the kind keeps no secrets. */
  secrets: Secrets | null;
}

export interface KindModule {
  kind: ServiceKind;
  database: boolean;
  /** Settings for a new service, from input already checked by the shared schema. */
  create(input: unknown, context: KindContext): MadeSettings;
  /** A copy for another environment: the same settings, its own volume and fresh secrets. */
  copy(settings: Settings, context: KindContext): MadeSettings;
  /** Applies a change; returns the new settings and anything the person should be told. */
  update(settings: Settings, input: unknown): { settings: Settings; notes: string[] };
  /** The settings that may be shown, by name. */
  publicSettings(settings: Settings): Settings;
}

/** Checks a settings change against the kind's update schema (invalid_request on failure). */
export function checkSettingsUpdate(kind: ServiceKind, input: unknown): Settings {
  return check(serviceSettingsUpdateSchemas[kind], input) as Settings;
}

/** Re-reads create input through the kind's schema, so a module never trusts its caller. */
export function parseCreateInput(kind: ServiceKind, input: unknown): Settings {
  return check(serviceSettingsInputSchemas[kind], input) as Settings;
}

/** Copies only the listed keys that are present. */
export function pick(settings: Settings, keys: readonly string[]): Settings {
  const out: Settings = {};
  for (const key of keys) if (key in settings) out[key] = settings[key];
  return out;
}
