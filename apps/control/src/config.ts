import { type ControlConfig, parseControlConfig } from "@nearzero/shared";

export interface RuntimeConfig extends Omit<ControlConfig, "authSecret"> {
  authSecret: string;
  /** True when no secret was configured and a temporary one was made (never in production). */
  authSecretIsTemporary: boolean;
}

export type LoadConfigResult =
  | { ok: true; config: RuntimeConfig }
  | { ok: false; problems: string[] };

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Reads the control plane's settings. Outside production a missing secret is replaced by a random
 * one that lasts until the process stops; there is never a built-in default (spec 23.2).
 */
export function loadConfig(env: Record<string, string | undefined>): LoadConfigResult {
  const result = parseControlConfig(env);
  if (!result.ok) return result;
  const { authSecret, ...rest } = result.config;
  if (authSecret !== null) {
    return { ok: true, config: { ...rest, authSecret, authSecretIsTemporary: false } };
  }
  return { ok: true, config: { ...rest, authSecret: randomSecret(), authSecretIsTemporary: true } };
}
