import {
  applySwitch,
  changedSwitches,
  dependencyNotice,
  needsProductionPhrase,
  productionPhraseMatches,
} from "../lib/agent-policy-rules.ts";
import {
  AGENT_POLICY_KEYS,
  type AgentPolicy,
  type AgentPolicySwitches,
  PRODUCTION_CONFIRMATION_PHRASE,
} from "../lib/vocabulary.ts";
import { asApiError, callApi, clearErrors, refreshPage, showErrors, showFormError } from "./api.ts";
import { showToast } from "./toasts.ts";

/**
 * API keys (spec 04 4.8): "Remove" asks again as "Confirm remove" for 6 seconds.
 * Agent policies (spec 19.9): switch dependencies, the typed production phrase, one Save.
 */

const CONFIRM_MS = 6000;
const armed = new WeakMap<HTMLElement, number>();

async function removeKey(button: HTMLElement): Promise<void> {
  const kind = button.dataset.keyRemove ?? "";
  const form = button.closest<HTMLFormElement>("form");
  const warning = form?.querySelector<HTMLElement>("[data-key-warning-text]");
  const label = button.querySelector<HTMLElement>("[data-label]") ?? button;
  const timer = armed.get(button);
  if (timer === undefined) {
    label.textContent = "Confirm remove";
    button.classList.add("nz-btn--danger");
    if (warning) {
      warning.textContent = button.dataset.keyWarning ?? "";
      warning.hidden = false;
    }
    armed.set(
      button,
      window.setTimeout(() => {
        armed.delete(button);
        label.textContent = "Remove";
        button.classList.remove("nz-btn--danger");
        if (warning) warning.hidden = true;
      }, CONFIRM_MS),
    );
    return;
  }
  window.clearTimeout(timer);
  armed.delete(button);
  try {
    await callApi("DELETE", `/workspace/keys/${encodeURIComponent(kind)}`);
    showToast("Key removed", { tone: "success" });
    await refreshPage();
  } catch (error) {
    if (form) showFormError(form, asApiError(error).message);
  }
}

function readSwitches(form: HTMLFormElement): AgentPolicySwitches {
  const switches = {} as AgentPolicySwitches;
  for (const key of AGENT_POLICY_KEYS) {
    const input = form.querySelector<HTMLInputElement>(`[data-agent-policy="${CSS.escape(key)}"]`);
    switches[key] = input?.checked ?? false;
  }
  return switches;
}

function savedSwitches(form: HTMLFormElement): AgentPolicySwitches {
  try {
    return JSON.parse(form.dataset.saved ?? "{}") as AgentPolicySwitches;
  } catch {
    return readSwitches(form);
  }
}

function syncProduction(form: HTMLFormElement): void {
  const saved = savedSwitches(form);
  const next = readSwitches(form);
  const phrase = form.querySelector<HTMLElement>("[data-production-phrase]");
  if (phrase) phrase.hidden = !needsProductionPhrase(saved, next);
  const unchanged = Object.keys(changedSwitches(saved, next)).length === 0;
  const pending = form.querySelector<HTMLElement>("[data-agent-unsaved]");
  if (pending) pending.hidden = unchanged;
  // "Save changes" stays dimmed until something changes.
  const save = form.querySelector<HTMLButtonElement>("[data-agent-save]");
  if (save) save.disabled = unchanged;
}

async function saveAgentPolicies(form: HTMLFormElement): Promise<void> {
  const saved = savedSwitches(form);
  const next = readSwitches(form);
  const body: { switches: Partial<AgentPolicySwitches>; productionConfirmation?: string } = {
    switches: next,
  };
  if (needsProductionPhrase(saved, next)) {
    const input = form.querySelector<HTMLInputElement>('[name="productionConfirmation"]');
    const value = input?.value ?? "";
    if (!productionPhraseMatches(value)) {
      clearErrors(form);
      const slot = input?.closest("[data-field]")?.querySelector<HTMLElement>("[data-field-error]");
      if (input && slot) {
        input.setAttribute("aria-invalid", "true");
        slot.textContent = `Type ${PRODUCTION_CONFIRMATION_PHRASE} exactly to allow production changes.`;
        slot.hidden = false;
        input.focus();
      }
      return;
    }
    body.productionConfirmation = value.trim();
  }
  form.setAttribute("data-busy", "");
  try {
    await callApi("PUT", "/workspace/agent-policies", body);
    showToast("Agent policies saved", { tone: "success" });
    // Saved: nothing is left to lose, so reloading the page's data never asks (B3-17).
    form.dataset.saved = JSON.stringify(next);
    syncProduction(form);
    await refreshPage();
  } catch (error) {
    showErrors(form, asApiError(error));
  } finally {
    form.removeAttribute("data-busy");
    for (const button of form.querySelectorAll('button[type="submit"]'))
      button.removeAttribute("aria-disabled");
  }
}

export function initSettingsPages(): void {
  document.addEventListener("click", (event) => {
    const button = (event.target as Element | null)?.closest<HTMLElement>("[data-key-remove]");
    if (!button) return;
    event.preventDefault();
    void removeKey(button);
  });

  document.addEventListener("change", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.dataset.agentPolicy === undefined) return;
    const form = input.closest<HTMLFormElement>("form");
    if (!form) return;
    const key = input.dataset.agentPolicy as AgentPolicy;
    const before = { ...readSwitches(form), [key]: !input.checked };
    const next = applySwitch(before, key, input.checked);
    for (const policy of AGENT_POLICY_KEYS) {
      const other = form.querySelector<HTMLInputElement>(
        `[data-agent-policy="${CSS.escape(policy)}"]`,
      );
      if (other) other.checked = next[policy];
    }
    // "Also turned on …, which this needs." / "Also turned off …, which need it." (spec 19.9)
    const notice = form.querySelector<HTMLElement>("[data-agent-notice]");
    if (notice) {
      const text = dependencyNotice(before, next, key);
      notice.textContent = text ?? "";
      notice.hidden = text === null;
    }
    syncProduction(form);
  });

  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.matches("[data-agent-policies]")) return;
    event.preventDefault();
    if (!form.hasAttribute("data-busy")) void saveAgentPolicies(form);
  });
}
