import {
  AGENT_POLICIES,
  AGENT_POLICIES_NEEDING_CONFIGURE,
  type AgentPolicy,
  type AgentPolicySwitches,
  PRODUCTION_CONFIRMATION_PHRASE,
} from "./vocabulary.ts";

/**
 * The Agent policies page's rules (spec 19.9), shared by the page and its tests. The control
 * plane enforces the same ones.
 */

const CONFIGURE: AgentPolicy = "services.configure";

/** Turning on Import from Git or Assign domains turns on Create and configure; turning that off turns both off. */
export function applySwitch(
  switches: AgentPolicySwitches,
  key: AgentPolicy,
  on: boolean,
): AgentPolicySwitches {
  const next = { ...switches, [key]: on };
  if (on && AGENT_POLICIES_NEEDING_CONFIGURE.includes(key)) next[CONFIGURE] = true;
  if (!on && key === CONFIGURE) {
    for (const dependent of AGENT_POLICIES_NEEDING_CONFIGURE) next[dependent] = false;
  }
  return next;
}

/** A switch's name in sentences, without its "(needs …)" or "(also covers …)" note. */
export function policyName(key: AgentPolicy): string {
  return AGENT_POLICIES[key].label.replace(/\s*\(.*\)$/, "");
}

function joinNames(names: string[]): string {
  return names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * What flipping `key` did to the switches it depends on or that depend on it (spec 19.9):
 * "Also turned on <name>, which this needs." or "Also turned off <names>, which need it.";
 * null when nothing else changed.
 */
export function dependencyNotice(
  before: AgentPolicySwitches,
  after: AgentPolicySwitches,
  key: AgentPolicy,
): string | null {
  const changed = (Object.keys(after) as AgentPolicy[]).filter(
    (other) => other !== key && after[other] !== before[other],
  );
  if (changed.length === 0) return null;
  const names = joinNames(changed.map(policyName));
  return after[key]
    ? `Also turned on ${names}, which this needs.`
    : `Also turned off ${names}, which need it.`;
}

/** Production changes need the typed phrase only when they are being turned on. */
export function needsProductionPhrase(
  saved: Pick<AgentPolicySwitches, "production">,
  next: Pick<AgentPolicySwitches, "production">,
): boolean {
  return next.production && !saved.production;
}

export function productionPhraseMatches(value: string): boolean {
  return value.trim() === PRODUCTION_CONFIRMATION_PHRASE;
}

/** Only the switches that differ from what is saved. */
export function changedSwitches(
  saved: AgentPolicySwitches,
  next: AgentPolicySwitches,
): Partial<AgentPolicySwitches> {
  const changed: Partial<AgentPolicySwitches> = {};
  for (const key of Object.keys(next) as AgentPolicy[]) {
    if (next[key] !== saved[key]) changed[key] = next[key];
  }
  return changed;
}
