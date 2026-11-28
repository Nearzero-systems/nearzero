import {
  duplicateEnvironmentMessage,
  ENVIRONMENT_NAME_RULE,
  environmentNameHint,
  isProductionEnvironment,
  normalizeEnvironmentName,
} from "@nearzero/shared/browser";

/** The words of the environment dialogs (spec 05 5.3), on the shared name rules. */

export interface NameHint {
  ok: boolean;
  message: string;
  name: string;
}

/** The live hint under a name field, including the project's names already in use. */
export function nameHint(input: string, taken: readonly string[]): NameHint {
  if (input.trim() === "") return { ok: false, name: "", message: ENVIRONMENT_NAME_RULE };
  const hint = environmentNameHint(input);
  if (hint.ok && taken.includes(hint.name)) {
    return { ok: false, name: hint.name, message: duplicateEnvironmentMessage(hint.name) };
  }
  return hint;
}

/** What the variables choice will do (spec 05 5.3), or null for "Start empty". */
export function variablesHint(input: {
  copy: boolean;
  values: boolean;
  sourceName: string;
  newName: string;
}): string | null {
  if (!input.copy) return null;
  if (!input.values) {
    return `Names from ${input.sourceName} are copied with empty values. Fill them in after.`;
  }
  const into = isProductionEnvironment(normalizeEnvironmentName(input.newName))
    ? " into production"
    : "";
  return `The values from ${input.sourceName}, secrets included, will be copied${into}.`;
}
