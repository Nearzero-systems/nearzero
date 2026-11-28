import {
  type ComposeContainerRow,
  type ComposePreview,
  containerPill,
} from "../lib/compose-rules.ts";
import { browserCopyEnvironment, COPY_REFUSED_MESSAGE, copyText } from "../lib/copy-text.ts";
import { asApiError, callApi } from "./api.ts";
import { openDialog } from "./dialogs.ts";
import { showToast } from "./toasts.ts";

/**
 * The Compose page in the browser (spec 07 7.2): the Containers table (Name, State, Status,
 * Container id, Refresh) with its row menu (View logs, Restart, Start, Stop, Kill), and Preview
 * Compose (the person's file and Nearzero's additions, warnings for privileged options, the
 * refusal on the Nearzero host, and the variables by name). Every value is put on the page as
 * text, never as markup.
 */

interface ContainersAnswer {
  containers: ComposeContainerRow[];
  message: string | null;
  checkedAt: string;
}

const rowsOf = new WeakMap<HTMLElement, ComposeContainerRow[]>();

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function pill(state: string): HTMLElement {
  const node = element("span", "nz-pill", state.charAt(0).toUpperCase() + state.slice(1));
  node.dataset.status = containerPill(state);
  return node;
}

function renderRows(section: HTMLElement, answer: ContainersAnswer): void {
  const status = section.querySelector<HTMLElement>("[data-compose-containers-status]");
  const table = section.querySelector<HTMLElement>("[data-compose-table]");
  const body = section.querySelector<HTMLElement>("[data-compose-rows]");
  if (!status || !table || !body) return;
  rowsOf.set(section, answer.containers);
  if (answer.message) {
    status.textContent = answer.message;
  } else if (answer.containers.length === 0) {
    status.textContent = "No containers on the server. Deploy to start them.";
  } else {
    status.textContent = "";
  }
  table.hidden = answer.containers.length === 0;
  body.replaceChildren(
    ...answer.containers.map((container) => {
      const row = element("tr");
      row.dataset.containerId = container.id;
      const name = element("td");
      const stack = element("span", "nz-stack-sm");
      stack.append(
        element("span", "font-medium", container.service),
        element("span", "nz-small nz-dim nz-code", container.name),
      );
      name.append(stack);
      const state = element("td");
      state.append(pill(container.state));
      if (!container.current)
        state.append(element("span", "nz-small nz-dim nz-compose-old", " · older deploy"));
      const statusCell = element("td", "nz-dim", container.status);
      const id = element("td");
      id.append(element("span", "nz-code", container.shortId));
      const actions = element("td", "nz-col-actions");
      const more = element("button", "nz-btn nz-btn--icon");
      more.type = "button";
      more.setAttribute("popovertarget", "nz-compose-container-menu");
      more.setAttribute("aria-haspopup", "menu");
      more.setAttribute("aria-expanded", "false");
      more.setAttribute("aria-label", `Actions for ${container.name}`);
      more.dataset.composeRowMenu = container.id;
      const icon = document.querySelector<SVGElement>("[data-compose-icon-more] svg");
      more.innerHTML = icon?.outerHTML ?? "⋯";
      actions.append(more);
      row.append(name, state, statusCell, id, actions);
      return row;
    }),
  );
}

async function loadContainers(section: HTMLElement): Promise<void> {
  const serviceId = section.dataset.composeContainers;
  if (!serviceId) return;
  const status = section.querySelector<HTMLElement>("[data-compose-containers-status]");
  try {
    const answer = await callApi<ContainersAnswer>(
      "GET",
      `/services/${encodeURIComponent(serviceId)}/compose/containers`,
    );
    renderRows(section, answer);
  } catch (error) {
    if (status) status.textContent = asApiError(error).message;
  }
}

function containerFor(section: HTMLElement, id: string | undefined): ComposeContainerRow | null {
  return rowsOf.get(section)?.find((item) => item.id === id) ?? null;
}

/** View logs: the Logs section's picker switches to this container and follows it. */
function viewLogs(container: ComposeContainerRow): void {
  const select = document.querySelector<HTMLSelectElement>(
    "[data-runtime-logs] [data-logs-container]",
  );
  if (!select) return;
  if (![...select.options].some((option) => option.value === container.id)) {
    const option = element("option", undefined, `${container.name} · ${container.state}`);
    option.value = container.id;
    select.append(option);
  }
  select.value = container.id;
  const wrap = select.closest<HTMLElement>("[data-logs-container-wrap]");
  if (wrap) wrap.hidden = false;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  document
    .querySelector("#nz-compose-logs")
    ?.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function act(
  section: HTMLElement,
  container: ComposeContainerRow,
  action: string,
): Promise<void> {
  const serviceId = section.dataset.composeContainers ?? "";
  try {
    const answer = await callApi<{ message: string }>(
      "POST",
      `/services/${encodeURIComponent(serviceId)}/compose/containers/${encodeURIComponent(container.id)}/${action}`,
      {},
    );
    showToast(answer.message, { tone: "success" });
  } catch (error) {
    showToast(asApiError(error).message, { tone: "error", persist: true });
  }
  await loadContainers(section);
}

let pendingKill: { section: HTMLElement; container: ComposeContainerRow } | null = null;

// ---- Preview Compose

function note(text: string, tone: "warn" | "fail" | "info" = "info"): HTMLElement {
  const node = element(
    "p",
    `nz-inline-note${tone === "warn" ? " nz-warn-note" : tone === "fail" ? " nz-compose-refusal" : ""}`,
    text,
  );
  return node;
}

function showFile(dialog: HTMLElement, preview: ComposePreview, index: number): void {
  const file = preview.files[index];
  if (!file) return;
  const tabs = dialog.querySelectorAll<HTMLElement>("[data-compose-file-tab]");
  tabs.forEach((tab, at) => {
    tab.setAttribute("aria-selected", at === index ? "true" : "false");
    tab.tabIndex = at === index ? 0 : -1;
  });
  const description = dialog.querySelector<HTMLElement>("[data-compose-file-description]");
  if (description) description.textContent = file.description;
  const content = dialog.querySelector<HTMLElement>("[data-compose-file-content]");
  if (content) {
    content.textContent = file.content;
    content.dataset.index = String(index);
  }
}

function renderPreview(dialog: HTMLElement, preview: ComposePreview): void {
  const status = dialog.querySelector<HTMLElement>("[data-compose-preview-status]");
  const alerts = dialog.querySelector<HTMLElement>("[data-compose-preview-alerts]");
  const files = dialog.querySelector<HTMLElement>("[data-compose-preview-files]");
  const tabs = dialog.querySelector<HTMLElement>("[data-compose-file-tabs]");
  const details = dialog.querySelector<HTMLElement>("[data-compose-preview-details]");
  if (!status || !alerts || !files || !tabs || !details) return;
  (dialog as HTMLElement & { composePreview?: ComposePreview }).composePreview = preview;
  status.textContent = preview.available ? preview.source : (preview.message ?? "");
  alerts.replaceChildren();
  if (preview.refused && preview.refusal) alerts.append(note(preview.refusal, "fail"));
  for (const problem of preview.problems) alerts.append(note(problem, "fail"));
  if (preview.warnings.length > 0) {
    const box = element("div", "nz-compose-warnings");
    box.append(
      element(
        "p",
        "font-medium",
        preview.refused
          ? "Options refused on the Nearzero host"
          : "Privileged options: they reach past this stack into the server",
      ),
    );
    const list = element("ul", "nz-compose-warning-list");
    for (const warning of preview.warnings) {
      const item = element("li");
      item.append(
        element("span", "nz-pill", warning.label),
        element("span", undefined, ` ${warning.message}`),
      );
      (item.firstElementChild as HTMLElement).dataset.status = preview.refused ? "fail" : "warn";
      list.append(item);
    }
    box.append(list);
    alerts.append(box);
  }
  files.hidden = preview.files.length === 0;
  tabs.replaceChildren(
    ...preview.files.map((file, index) => {
      const tab = element("button", "nz-tab", file.title);
      tab.type = "button";
      tab.setAttribute("role", "tab");
      tab.dataset.composeFileTab = String(index);
      return tab;
    }),
  );
  showFile(dialog, preview, 0);
  details.replaceChildren();
  if (preview.available && preview.variables.note) {
    const names = preview.variables.delivered;
    details.append(
      element(
        "p",
        "nz-small",
        names.length > 0
          ? `Variables in the env file: ${names.join(", ")}.`
          : "No variables yet: the env file is empty.",
      ),
      element("p", "nz-hint", preview.variables.note),
    );
  }
  for (const text of preview.notes) details.append(element("p", "nz-small nz-dim", text));
}

async function openPreview(serviceId: string): Promise<void> {
  const dialog = document.querySelector<HTMLElement>("#nz-compose-preview");
  if (!dialog) return;
  const status = dialog.querySelector<HTMLElement>("[data-compose-preview-status]");
  const files = dialog.querySelector<HTMLElement>("[data-compose-preview-files]");
  if (status) status.textContent = "Reading the Compose file…";
  if (files) files.hidden = true;
  dialog.querySelector("[data-compose-preview-alerts]")?.replaceChildren();
  dialog.querySelector("[data-compose-preview-details]")?.replaceChildren();
  try {
    const preview = await callApi<ComposePreview>(
      "GET",
      `/services/${encodeURIComponent(serviceId)}/compose/preview`,
    );
    renderPreview(dialog, preview);
  } catch (error) {
    if (status) status.textContent = asApiError(error).message;
  }
}

export function initCompose(): void {
  document.addEventListener("astro:page-load", () => {
    for (const section of document.querySelectorAll<HTMLElement>("[data-compose-containers]")) {
      void loadContainers(section);
    }
  });
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target as Element | null;
      const opener = target?.closest<HTMLElement>("[data-compose-row-menu]");
      if (!opener) return;
      const section = opener.closest<HTMLElement>("[data-compose-containers]");
      const menu = document.querySelector<HTMLElement>("[data-compose-menu]");
      const container = section ? containerFor(section, opener.dataset.composeRowMenu) : null;
      if (!menu || !container) return;
      menu.dataset.containerId = container.id;
      menu.setAttribute("aria-label", `Actions for ${container.name}`);
      const running = container.state === "running";
      for (const item of menu.querySelectorAll<HTMLButtonElement>("[data-compose-row-action]")) {
        const action = item.dataset.composeRowAction;
        item.disabled =
          (action === "start" && running) || ((action === "stop" || action === "kill") && !running);
      }
    },
    true,
  );

  document.addEventListener("click", (event) => {
    const target = event.target as Element | null;

    const preview = target?.closest<HTMLElement>("[data-compose-preview]");
    if (preview?.dataset.composePreview) {
      void openPreview(preview.dataset.composePreview);
      return;
    }

    const fileTab = target?.closest<HTMLElement>("[data-compose-file-tab]");
    if (fileTab) {
      const dialog = fileTab.closest<HTMLElement & { composePreview?: ComposePreview }>(
        "#nz-compose-preview",
      );
      if (dialog?.composePreview)
        showFile(dialog, dialog.composePreview, Number(fileTab.dataset.composeFileTab));
      return;
    }

    if (target?.closest("[data-compose-file-copy]") && event.isTrusted) {
      const text =
        document.querySelector<HTMLElement>("[data-compose-file-content]")?.textContent ?? "";
      void copyText(text, browserCopyEnvironment()).then((ok) =>
        showToast(ok ? "Copied" : COPY_REFUSED_MESSAGE, { tone: ok ? "success" : "error" }),
      );
      return;
    }

    if (target?.closest("[data-compose-refresh]")) {
      const section = target.closest<HTMLElement>("[data-compose-containers]");
      if (section) void loadContainers(section);
      return;
    }

    const item = target?.closest<HTMLElement>("[data-compose-row-action]");
    if (item) {
      const menu = item.closest<HTMLElement>("[data-compose-menu]");
      const section = menu?.closest<HTMLElement>("[data-compose-containers]");
      const container = section ? containerFor(section, menu?.dataset.containerId) : null;
      if (!section || !container) return;
      const action = item.dataset.composeRowAction ?? "";
      if (action === "logs") viewLogs(container);
      else if (action === "kill") {
        const dialog = document.querySelector<HTMLDialogElement>("#nz-compose-confirm");
        const text = dialog?.querySelector<HTMLElement>("[data-compose-confirm-text]");
        if (text) {
          text.textContent = `${container.name} stops at once, without the chance to finish what it is doing. Its restart policy may start it again.`;
        }
        pendingKill = { section, container };
        if (dialog) openDialog(dialog, item);
      } else void act(section, container, action);
      return;
    }

    if (target?.closest("[data-compose-confirm-go]") && pendingKill) {
      const { section, container } = pendingKill;
      pendingKill = null;
      document.querySelector<HTMLDialogElement>("#nz-compose-confirm")?.close();
      void act(section, container, "kill");
    }
  });
}
