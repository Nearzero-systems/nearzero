import { navigate } from "astro:transitions/client";
import { iconSvg } from "../lib/icons.ts";
import {
  type DeletePlan,
  type DeleteRun,
  ITEM_STATES,
  isFinished,
  isUntracked,
  KEEPS_GOING,
  planRowDetail,
  UNTRACKED_MESSAGE,
} from "../lib/teardown.ts";
import { asApiError, callApi, refreshPage } from "./api.ts";
import { openDialog } from "./dialogs.ts";
import { showToast } from "./toasts.ts";

/**
 * The teardown dialog (spec 05 5.1, 5.2): loads the plan, asks for the project name, starts the
 * delete in the background and follows it service by service (Waiting, Removing…, Removed, Not
 * removed). It can be closed while the delete keeps going; reopening shows "X is already being
 * deleted." A plan that went stale is reloaded; a delete the platform stopped tracking can be
 * started again.
 */

type Target =
  | { scope: "project"; projectId: string; projectName: string }
  | { scope: "services"; environmentId: string; serviceIds: string[] };

interface State {
  target: Target;
  plan: DeletePlan | null;
  runId: string | null;
  timer: number;
  /** Where the person was when the delete started, to refresh it once the delete ends. */
  page: string;
  /** The delete ended while the dialog was open: act on it when the dialog closes. */
  done: DeleteRun | null;
}

let state: State | null = null;
const POLL_MS = 1000;

function root(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-teardown]");
}

function part<T extends HTMLElement = HTMLElement>(name: string): T | null {
  return root()?.querySelector<T>(`[data-teardown-${name}]`) ?? null;
}

function servers(): Record<string, string> {
  try {
    return JSON.parse(root()?.dataset.servers ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

function serverName(id: string): string {
  if (id === "host") return "Nearzero host";
  return servers()[id] ?? "a server";
}

function show(view: "loading" | "plan" | "run"): void {
  for (const name of ["loading", "plan", "run"] as const) {
    const element = part(name);
    if (element) element.hidden = name !== view;
  }
}

function note(text: string, tone: "error" | "info"): HTMLElement {
  const element = document.createElement("p");
  element.className = tone === "error" ? "nz-inline-error" : "nz-inline-note";
  if (tone === "error") element.innerHTML = iconSvg("alert");
  const span = document.createElement("span");
  span.textContent = text;
  element.append(span);
  return element;
}

function badge(text: string, tone: "prod" | "plain"): HTMLElement {
  const element = document.createElement("span");
  element.className = tone === "prod" ? "nz-badge nz-badge--prod" : "nz-badge";
  element.textContent = text;
  return element;
}

function pill(label: string, status: string): HTMLElement {
  const element = document.createElement("span");
  element.className = "nz-pill";
  element.dataset.status = status;
  element.textContent = label;
  return element;
}

function setTitle(text: string): void {
  const dialog = root()?.closest("dialog");
  const title = dialog?.querySelector<HTMLElement>(".nz-dialog-title");
  if (title) title.textContent = text;
}

function renderPlan(plan: DeletePlan, problem?: string): void {
  setTitle(plan.scope === "project" ? `Delete ${plan.project.name}` : plan.confirmLabel);
  const summary = part("summary");
  if (summary) summary.textContent = plan.summary;
  const notes = part("notes");
  notes?.replaceChildren(
    ...(problem ? [note(problem, "error")] : []),
    ...plan.blockers.map((text) => note(text, "error")),
    ...plan.warnings.map((text) => note(text, "info")),
  );
  const list = part("services");
  list?.replaceChildren(
    ...plan.services.map((service) => {
      const row = document.createElement("li");
      row.className = "nz-teardown-row";
      const name = document.createElement("span");
      name.className = "nz-truncate font-medium";
      name.textContent = service.access ? (service.name ?? "") : "A service you can't see";
      const detail = document.createElement("span");
      detail.className = "nz-dim nz-truncate";
      detail.textContent = planRowDetail(service, serverName);
      const marks = document.createElement("span");
      marks.className = "nz-teardown-marks";
      if (service.production) marks.append(badge("Production", "prod"));
      if (!service.access) marks.append(badge("No access", "plain"));
      if (service.deploying) marks.append(pill("Deploying", "run"));
      else if (service.beingDeleted) marks.append(pill("Being deleted", "idle"));
      row.append(name, detail, marks);
      return row;
    }),
  );
  if (list) list.hidden = plan.services.length === 0;
  const field = part("confirm-field");
  const form = part<HTMLFormElement>("form");
  const input = form?.querySelector<HTMLInputElement>('input[name="confirm"]');
  const label = part("confirm-label");
  const submit = part<HTMLButtonElement>("submit");
  if (field) field.hidden = !plan.canDelete;
  if (label) label.textContent = `Type ${plan.confirmText} to confirm`;
  if (input) {
    input.value = "";
    input.removeAttribute("aria-invalid");
  }
  if (submit) {
    submit.hidden = !plan.canDelete;
    submit.textContent = plan.confirmLabel;
    submit.disabled = true;
  }
  const error = form?.querySelector<HTMLElement>("[data-form-error]");
  if (error) error.hidden = true;
  show("plan");
  if (plan.canDelete) input?.focus();
}

function renderRun(run: DeleteRun, intro?: string): void {
  setTitle(run.scope === "project" ? `Deleting ${run.project.name}` : "Deleting services");
  const message = part("message");
  const detail = part("detail");
  const finished = isFinished(run);
  const untracked = isUntracked(run);
  if (message) {
    message.textContent = untracked
      ? UNTRACKED_MESSAGE
      : finished
        ? run.message
        : (intro ?? run.message ?? KEEPS_GOING);
  }
  if (detail) {
    detail.hidden = finished || untracked || intro === undefined;
    detail.textContent = KEEPS_GOING;
  }
  part("items")?.replaceChildren(
    ...run.items.map((item) => {
      const row = document.createElement("li");
      row.className = "nz-teardown-row";
      const name = document.createElement("span");
      name.className = "nz-truncate font-medium";
      name.textContent = item.name ?? "A service you can't see";
      const where = document.createElement("span");
      where.className = "nz-dim nz-truncate";
      where.textContent = item.reason
        ? `${item.environmentName}: ${item.reason}`
        : item.environmentName;
      const marks = document.createElement("span");
      marks.className = "nz-teardown-marks";
      if (item.production) marks.append(badge("Production", "prod"));
      const look = ITEM_STATES[item.state];
      marks.append(pill(look.label, look.pill));
      row.append(name, where, marks);
      return row;
    }),
  );
  const retry = part("retry");
  if (retry) retry.hidden = !(finished && run.state === "failed");
  const restart = part("restart");
  if (restart) restart.hidden = !untracked;
  show("run");
}

async function loadPlan(problem?: string): Promise<void> {
  if (!state) return;
  const target = state.target;
  show("loading");
  try {
    const { plan } =
      target.scope === "project"
        ? await callApi<{ plan: DeletePlan }>(
            "GET",
            `/projects/${encodeURIComponent(target.projectId)}/delete-plan`,
          )
        : await callApi<{ plan: DeletePlan }>(
            "POST",
            `/environments/${encodeURIComponent(target.environmentId)}/services/delete-plan`,
            { serviceIds: target.serviceIds },
          );
    if (!state || state.target !== target) return;
    state.plan = plan;
    if (plan.inProgress) {
      // "X is already being deleted.": follow that delete instead of offering a second one.
      await follow(plan.inProgress.runId, plan.inProgress.message);
      return;
    }
    renderPlan(plan, problem);
  } catch (error) {
    root()?.closest("dialog")?.close();
    showToast(asApiError(error).message, { tone: "error" });
  }
}

async function follow(runId: string, intro?: string): Promise<void> {
  if (!state) return;
  state.runId = runId;
  window.clearTimeout(state.timer);
  const tick = async () => {
    if (!state || state.runId !== runId) return;
    let run: DeleteRun;
    try {
      run = (await callApi<{ run: DeleteRun }>("GET", `/delete-runs/${encodeURIComponent(runId)}`))
        .run;
    } catch (error) {
      showToast(asApiError(error).message, { tone: "error" });
      return;
    }
    if (!state || state.runId !== runId) return;
    const open = Boolean(root()?.closest("dialog")?.open);
    if (open) renderRun(run, intro);
    if (isFinished(run) || isUntracked(run)) {
      if (isFinished(run)) await finished(run, open);
      return;
    }
    state.timer = window.setTimeout(tick, POLL_MS);
  };
  await tick();
}

/** After the delete ends: a deleted project leaves its pages; anything else refreshes. */
async function finished(run: DeleteRun, open: boolean): Promise<void> {
  if (!state) return;
  if (open) {
    state.done = run;
    return;
  }
  showToast(run.message, {
    tone: run.state === "succeeded" ? "success" : "error",
    persist: run.state !== "succeeded",
  });
  await afterDelete(run);
}

async function afterDelete(run: DeleteRun): Promise<void> {
  const started = state?.page;
  state = null;
  if (run.scope === "project" && run.state === "succeeded") {
    const inside = location.pathname.includes(`/projects/${encodeURIComponent(run.project.id)}`);
    if (inside) {
      await navigate(location.pathname.split("/").slice(0, 4).join("/"));
      return;
    }
  }
  if (location.pathname + location.search === started) await refreshPage();
}

async function submit(form: HTMLFormElement): Promise<void> {
  if (!state?.plan) return;
  const plan = state.plan;
  const input = form.querySelector<HTMLInputElement>('input[name="confirm"]');
  const confirm = input?.value.trim() ?? "";
  if (confirm !== plan.confirmText) return;
  const button = part<HTMLButtonElement>("submit");
  button?.setAttribute("aria-disabled", "true");
  const target = state.target;
  try {
    const { run } =
      target.scope === "project"
        ? await callApi<{ run: DeleteRun }>(
            "POST",
            `/projects/${encodeURIComponent(target.projectId)}/delete`,
            { fingerprint: plan.fingerprint, confirm },
          )
        : await callApi<{ run: DeleteRun }>(
            "POST",
            `/environments/${encodeURIComponent(target.environmentId)}/services/delete`,
            { serviceIds: target.serviceIds, fingerprint: plan.fingerprint, confirm },
          );
    state.page = location.pathname + location.search;
    renderRun(run, KEEPS_GOING);
    await follow(run.id, KEEPS_GOING);
  } catch (error) {
    const problem = asApiError(error);
    if (problem.code === "conflict" || problem.code === "forbidden") {
      // The project changed since the plan, or someone started a delete: show the new plan.
      await loadPlan(problem.message);
    } else if (problem.fields.confirm) {
      const slot = form.querySelector<HTMLElement>("[data-field-error]");
      if (slot) {
        slot.textContent = problem.fields.confirm;
        slot.hidden = false;
      }
      input?.setAttribute("aria-invalid", "true");
    } else {
      const general = form.querySelector<HTMLElement>("[data-form-error]");
      const text = general?.querySelector<HTMLElement>("[data-form-error-text]");
      if (general && text) {
        text.textContent = problem.message;
        general.hidden = false;
      }
    }
  } finally {
    button?.removeAttribute("aria-disabled");
  }
}

function open(target: Target, opener: Element): void {
  const dialog = root()?.closest("dialog");
  if (!(dialog instanceof HTMLDialogElement)) return;
  if (state) window.clearTimeout(state.timer);
  state = {
    target,
    plan: null,
    runId: null,
    timer: 0,
    page: location.pathname + location.search,
    done: null,
  };
  setTitle(target.scope === "project" ? `Delete ${target.projectName}` : "Delete services");
  show("loading");
  opener.closest<HTMLElement>("[popover]")?.hidePopover();
  openDialog(dialog, opener);
  void loadPlan();
}

/** The services ticked in the list the opener belongs to. */
function tickedServices(opener: HTMLElement): string[] {
  const list = opener.closest("[data-services-list]") ?? document;
  return Array.from(list.querySelectorAll<HTMLInputElement>("[data-service-select]:checked")).map(
    (box) => box.value,
  );
}

export function initTeardown(): void {
  document.addEventListener("click", (event) => {
    const element = event.target as Element | null;
    const opener = element?.closest<HTMLElement>("[data-teardown-open]");
    if (opener) {
      event.preventDefault();
      if (opener.dataset.teardownOpen === "project") {
        open(
          {
            scope: "project",
            projectId: opener.dataset.projectId ?? "",
            projectName: opener.dataset.projectName ?? "",
          },
          opener,
        );
      } else {
        const serviceIds = opener.dataset.serviceId
          ? [opener.dataset.serviceId]
          : tickedServices(opener);
        if (serviceIds.length === 0) return;
        open(
          { scope: "services", environmentId: opener.dataset.environmentId ?? "", serviceIds },
          opener,
        );
      }
      return;
    }
    if (element?.closest("[data-teardown-retry]") || element?.closest("[data-teardown-restart]")) {
      if (state) {
        state.runId = null;
        void loadPlan();
      }
    }
  });

  document.addEventListener("input", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.closest("[data-teardown-form]")) return;
    const button = part<HTMLButtonElement>("submit");
    if (button) button.disabled = input.value.trim() !== (state?.plan?.confirmText ?? "\u0000");
  });

  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.matches("[data-teardown-form]")) return;
    event.preventDefault();
    void submit(form);
  });

  // Closing the dialog after the delete ended shows its result in the page.
  document.addEventListener(
    "close",
    (event) => {
      const dialog = event.target;
      if (!(dialog instanceof HTMLDialogElement) || !dialog.querySelector("[data-teardown]"))
        return;
      const done = state?.done;
      if (done) void afterDelete(done);
    },
    true,
  );

  // Leaving the page stops following; the delete itself keeps going on the server.
  document.addEventListener("astro:before-swap", () => {
    if (state) window.clearTimeout(state.timer);
    state = null;
  });
}
