import { navigate } from "astro:transitions/client";
import { iconSvg } from "../lib/icons.ts";
import {
  type DeleteRun,
  ITEM_STATES,
  isFinished,
  isUntracked,
  KEEPS_GOING,
  SERVICE_DIALOG_TEXT,
  type ServiceDeletePlan,
  serviceDeleteOutcome,
  UNTRACKED_MESSAGE,
} from "../lib/teardown.ts";
import { asApiError, callApi, refreshPage } from "./api.ts";
import { openDialog } from "./dialogs.ts";
import { showToast } from "./toasts.ts";

/**
 * The delete-service dialog (spec 05 5.2): loads the service's plan, offers its copies in other
 * environments (none ticked), checks the typed name, starts the delete and follows it. The result
 * is "Service removed", or a persistent "Service removed, but not everywhere" naming what failed.
 */

interface State {
  serviceId: string;
  plan: ServiceDeletePlan | null;
  after: string | null;
  runId: string | null;
  timer: number;
}

let state: State | null = null;

function part<T extends HTMLElement = HTMLElement>(name: string): T | null {
  return document.querySelector<T>(`[data-service-delete] [data-sd-${name}]`);
}

function show(view: "loading" | "form" | "run"): void {
  for (const name of ["loading", "form", "run"] as const) {
    const element = part(name);
    if (element) element.hidden = name !== view;
  }
}

function render(plan: ServiceDeletePlan): void {
  const text = part("text");
  if (text) {
    text.replaceChildren(
      document.createTextNode("Delete "),
      Object.assign(document.createElement("strong"), { textContent: plan.service.name }),
      document.createTextNode(
        ` from ${plan.service.environment.name}? ${plan.service.willStop ? "It is stopped first. " : ""}${SERVICE_DIALOG_TEXT}`,
      ),
    );
  }
  const compose = part("compose");
  if (compose) compose.hidden = plan.service.kind !== "compose";
  part("notes")?.replaceChildren(
    ...plan.blockers.map((message) => {
      const item = document.createElement("p");
      item.className = "nz-inline-error";
      item.innerHTML = iconSvg("alert");
      item.append(Object.assign(document.createElement("span"), { textContent: message }));
      return item;
    }),
  );
  const copies = part("copies");
  if (copies) copies.hidden = plan.copies.length === 0;
  part("copy-list")?.replaceChildren(
    ...plan.copies.map((copy) => {
      const label = document.createElement("label");
      label.className = "nz-check";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = copy.id;
      box.dataset.sdCopy = "";
      box.disabled = !copy.canDelete || copy.deploying;
      label.append(box, document.createTextNode(` ${copy.label}`));
      if (copy.production) {
        const badge = document.createElement("span");
        badge.className = "nz-badge nz-badge--prod";
        badge.textContent = "Production";
        label.append(document.createTextNode(" "), badge);
      }
      if (copy.deploying) label.append(document.createTextNode(" (deploying)"));
      return label;
    }),
  );
  const hint = part("copies-hint");
  if (hint && plan.copiesHint) hint.textContent = plan.copiesHint;
  const field = part("confirm-field");
  if (field) field.hidden = !plan.canDelete;
  const label = part("confirm-label");
  if (label) label.textContent = `Type ${plan.confirmText} to confirm`;
  const input = document.querySelector<HTMLInputElement>("#nz-sd-confirm");
  if (input) input.value = "";
  const submit = part<HTMLButtonElement>("submit");
  if (submit) {
    submit.hidden = !plan.canDelete;
    submit.disabled = true;
  }
  const error = part("form")?.querySelector<HTMLElement>("[data-form-error]");
  if (error) error.hidden = true;
  show("form");
  if (plan.canDelete) input?.focus();
}

function renderRun(run: DeleteRun): void {
  const message = part("message");
  if (message) {
    message.textContent = isUntracked(run)
      ? UNTRACKED_MESSAGE
      : isFinished(run)
        ? serviceDeleteOutcome(run).message
        : KEEPS_GOING;
  }
  part("items")?.replaceChildren(
    ...run.items.map((item) => {
      const row = document.createElement("li");
      row.className = "nz-teardown-row";
      const name = Object.assign(document.createElement("span"), {
        className: "nz-truncate font-medium",
        textContent: item.environmentName,
      });
      const why = Object.assign(document.createElement("span"), {
        className: "nz-dim nz-truncate",
        textContent: item.reason ?? item.name ?? "",
      });
      const marks = document.createElement("span");
      marks.className = "nz-teardown-marks";
      const look = ITEM_STATES[item.state];
      const pill = Object.assign(document.createElement("span"), {
        className: "nz-pill",
        textContent: look.label,
      });
      pill.dataset.status = look.pill;
      marks.append(pill);
      row.append(name, why, marks);
      return row;
    }),
  );
  show("run");
}

async function follow(runId: string): Promise<void> {
  if (!state) return;
  state.runId = runId;
  const tick = async () => {
    if (!state || state.runId !== runId) return;
    try {
      const { run } = await callApi<{ run: DeleteRun }>(
        "GET",
        `/delete-runs/${encodeURIComponent(runId)}`,
      );
      if (!state || state.runId !== runId) return;
      renderRun(run);
      if (isFinished(run)) {
        const outcome = serviceDeleteOutcome(run);
        const after = state.after;
        state = null;
        document.querySelector<HTMLDialogElement>("#nz-service-delete")?.close();
        showToast(outcome.message, {
          tone: outcome.persist ? "error" : "success",
          persist: outcome.persist,
        });
        if (after) await navigate(after);
        else await refreshPage();
        return;
      }
      if (isUntracked(run)) return;
      state.timer = window.setTimeout(tick, 1000);
    } catch (error) {
      showToast(asApiError(error).message, { tone: "error" });
    }
  };
  await tick();
}

async function open(opener: HTMLElement): Promise<void> {
  const dialog = document.querySelector<HTMLDialogElement>("#nz-service-delete");
  if (!dialog) return;
  if (state) window.clearTimeout(state.timer);
  const serviceId = opener.dataset.serviceId ?? "";
  state = {
    serviceId,
    plan: null,
    after: opener.dataset.afterDelete ?? null,
    runId: null,
    timer: 0,
  };
  opener.closest<HTMLElement>("[popover]")?.hidePopover();
  show("loading");
  openDialog(dialog, opener);
  try {
    const { plan } = await callApi<{ plan: ServiceDeletePlan }>(
      "GET",
      `/services/${encodeURIComponent(serviceId)}/delete-plan`,
    );
    if (!state || state.serviceId !== serviceId) return;
    state.plan = plan;
    render(plan);
  } catch (error) {
    dialog.close();
    showToast(asApiError(error).message, { tone: "error" });
  }
}

async function submit(form: HTMLFormElement): Promise<void> {
  if (!state?.plan) return;
  const input = form.querySelector<HTMLInputElement>('input[name="confirm"]');
  const confirm = input?.value.trim() ?? "";
  if (confirm !== state.plan.confirmText) return;
  const alsoDeleteCopyIds = Array.from(
    form.querySelectorAll<HTMLInputElement>("[data-sd-copy]:checked"),
  ).map((box) => box.value);
  const button = part<HTMLButtonElement>("submit");
  button?.setAttribute("aria-disabled", "true");
  try {
    const { run } = await callApi<{ run: DeleteRun }>(
      "POST",
      `/services/${encodeURIComponent(state.serviceId)}/delete`,
      { confirm, alsoDeleteCopyIds },
    );
    renderRun(run);
    await follow(run.id);
  } catch (error) {
    const problem = asApiError(error);
    const general = form.querySelector<HTMLElement>("[data-form-error]");
    const text = general?.querySelector<HTMLElement>("[data-form-error-text]");
    if (general && text) {
      text.textContent = problem.fields.confirm ?? problem.message;
      general.hidden = false;
    }
  } finally {
    button?.removeAttribute("aria-disabled");
  }
}

export function initServiceDelete(): void {
  document.addEventListener("click", (event) => {
    const opener = (event.target as Element | null)?.closest<HTMLElement>(
      "[data-service-delete-open]",
    );
    if (!opener) return;
    event.preventDefault();
    void open(opener);
  });
  document.addEventListener("input", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.id !== "nz-sd-confirm") return;
    const button = part<HTMLButtonElement>("submit");
    if (button) button.disabled = input.value.trim() !== (state?.plan?.confirmText ?? "\u0000");
  });
  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.matches("[data-sd-form]")) return;
    event.preventDefault();
    void submit(form);
  });
  document.addEventListener("astro:before-swap", () => {
    if (state) window.clearTimeout(state.timer);
    state = null;
  });
}
