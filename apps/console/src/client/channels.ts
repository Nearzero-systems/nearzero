import { NOTIFICATION_MESSAGES } from "@nearzero/shared/browser";
import type { ChannelView } from "../lib/data/m10.ts";
import { asApiError, callApi, clearErrors, formBody, refreshPage, showErrors } from "./api.ts";
import { openDialog } from "./dialogs.ts";
import { showToast } from "./toasts.ts";

/**
 * Settings → Channels in the browser (spec 15.1, 15.2): the type picker shows that type's own
 * fields, Edit fills the saved settings (never the secrets: those stay blank and say "Saved,
 * leave blank to keep"), custom headers are rows, Test notification sends what the form holds,
 * and Save adds or changes the channel.
 */

function form(): HTMLFormElement | null {
  return document.querySelector<HTMLFormElement>("[data-channel-form]");
}

function showType(target: HTMLFormElement, type: string): void {
  for (const group of target.querySelectorAll<HTMLElement>("[data-channel-fields]")) {
    group.hidden = group.dataset.channelFields !== type;
  }
}

function addHeaderRow(list: HTMLElement, name = "", value = ""): void {
  const template = document.querySelector<HTMLTemplateElement>("#nz-header-row");
  const row = template?.content.firstElementChild?.cloneNode(true) as HTMLElement | undefined;
  if (!row) return;
  const nameInput = row.querySelector<HTMLInputElement>("[data-header-name]");
  const valueInput = row.querySelector<HTMLInputElement>("[data-header-value]");
  if (nameInput) nameInput.value = name;
  if (valueInput) valueInput.value = value;
  list.append(row);
}

function reset(target: HTMLFormElement): void {
  target.reset();
  clearErrors(target);
  const result = target.querySelector<HTMLElement>("[data-channel-test-result]");
  if (result) result.hidden = true;
  for (const list of target.querySelectorAll<HTMLElement>("[data-header-list]"))
    list.replaceChildren();
  for (const input of target.querySelectorAll<HTMLInputElement>("[data-secret]")) {
    input.placeholder = "";
  }
  for (const hint of target.querySelectorAll<HTMLElement>("[data-secret-hint]")) hint.hidden = true;
  const type = target.querySelector<HTMLSelectElement>("[data-channel-type]");
  if (type) {
    type.disabled = false;
    showType(target, type.value);
  }
}

function open(mode: "add" | "edit", channel: ChannelView | null, opener: Element | null): void {
  const target = form();
  const dialog = target?.closest("dialog");
  if (!target || !(dialog instanceof HTMLDialogElement)) return;
  reset(target);
  const title = dialog.querySelector<HTMLElement>(".nz-dialog-title");
  if (title) title.textContent = mode === "add" ? NOTIFICATION_MESSAGES.add : "Edit notification";
  const id = target.querySelector<HTMLInputElement>('[name="id"]');
  if (id) id.value = channel?.id ?? "";
  if (channel) {
    const name = target.querySelector<HTMLInputElement>('[name="name"]');
    if (name) name.value = channel.name;
    const type = target.querySelector<HTMLSelectElement>("[data-channel-type]");
    if (type) {
      type.value = channel.type;
      type.disabled = true;
    }
    showType(target, channel.type);
    const group = target.querySelector<HTMLElement>(
      `[data-channel-fields="${CSS.escape(channel.type)}"]`,
    );
    for (const [key, value] of Object.entries(channel.settings)) {
      const input = group?.querySelector<HTMLInputElement>(`[name="fields.${CSS.escape(key)}"]`);
      if (!input) continue;
      if (input.type === "checkbox") input.checked = value === true;
      else input.value = Array.isArray(value) ? value.join(", ") : String(value);
    }
    for (const [key, secret] of Object.entries(channel.secrets)) {
      const input = group?.querySelector<HTMLInputElement>(`[data-secret="${CSS.escape(key)}"]`);
      if (input) {
        input.value = "";
        input.placeholder = secret.saved
          ? secret.hint
            ? `${secret.hint} — ${NOTIFICATION_MESSAGES.secretSaved}`
            : NOTIFICATION_MESSAGES.secretSaved
          : "";
      }
      const hint = group?.querySelector<HTMLElement>(`[data-secret-hint="${CSS.escape(key)}"]`);
      if (hint && secret.saved) {
        hint.textContent = `${secret.hint ?? "Saved"}. Leave the rows empty to keep them.`;
        hint.hidden = false;
      }
    }
    for (const box of target.querySelectorAll<HTMLInputElement>('[name="events"]')) {
      box.checked = channel.events.includes(box.value as never);
    }
  }
  openDialog(dialog, opener);
}

function bodyOf(target: HTMLFormElement): {
  name: string;
  type: string;
  fields: Record<string, unknown>;
  events: string[];
} {
  const body = formBody(target) as {
    name?: string;
    type?: string;
    fields?: Record<string, unknown>;
    events?: string[];
  };
  const type = target.querySelector<HTMLSelectElement>("[data-channel-type]")?.value ?? "";
  const fields = { ...(body.fields ?? {}) };
  const group = target.querySelector<HTMLElement>(`[data-channel-fields="${CSS.escape(type)}"]`);
  for (const rows of group?.querySelectorAll<HTMLElement>("[data-header-rows]") ?? []) {
    const key = (rows.dataset.headerRows ?? "").replace(/^fields\./, "");
    fields[key] = [...rows.querySelectorAll<HTMLElement>(".nz-header-row")]
      .map((row) => ({
        name: row.querySelector<HTMLInputElement>("[data-header-name]")?.value.trim() ?? "",
        value: row.querySelector<HTMLInputElement>("[data-header-value]")?.value ?? "",
      }))
      .filter((row) => row.name !== "" || row.value !== "");
  }
  return { name: body.name ?? "", type, fields, events: body.events ?? [] };
}

async function save(target: HTMLFormElement): Promise<void> {
  if (target.hasAttribute("data-busy")) return;
  target.setAttribute("data-busy", "");
  clearErrors(target);
  const id = target.querySelector<HTMLInputElement>('[name="id"]')?.value ?? "";
  const body = bodyOf(target);
  try {
    const answer = id
      ? await callApi<{ message: string }>(
          "PATCH",
          `/notification-channels/${encodeURIComponent(id)}`,
          {
            name: body.name,
            fields: body.fields,
            events: body.events,
          },
        )
      : await callApi<{ message: string }>("POST", "/notification-channels", body);
    showToast(answer.message, { tone: "success" });
    target.closest("dialog")?.close();
    await refreshPage();
  } catch (error) {
    showErrors(target, asApiError(error));
  } finally {
    target.removeAttribute("data-busy");
  }
}

async function test(target: HTMLFormElement, button: HTMLButtonElement): Promise<void> {
  if (button.disabled) return;
  button.disabled = true;
  clearErrors(target);
  const result = target.querySelector<HTMLElement>("[data-channel-test-result]");
  const id = target.querySelector<HTMLInputElement>('[name="id"]')?.value ?? "";
  const body = bodyOf(target);
  try {
    const answer = await callApi<{ ok: boolean; message: string }>(
      "POST",
      "/notification-channels/test",
      {
        type: body.type,
        fields: body.fields,
        name: body.name,
        ...(id ? { channelId: id } : {}),
      },
    );
    if (result) {
      result.textContent = answer.message;
      result.dataset.tone = answer.ok ? "ok" : "fail";
      result.hidden = false;
    }
  } catch (error) {
    const problem = asApiError(error);
    showErrors(target, problem);
    if (result) result.hidden = true;
  } finally {
    button.disabled = false;
  }
}

export function initChannels(): void {
  document.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    const opener = target?.closest<HTMLElement>("[data-channel-open]");
    if (opener) {
      event.preventDefault();
      let channel: ChannelView | null = null;
      if (opener.dataset.channel) {
        try {
          channel = JSON.parse(opener.dataset.channel) as ChannelView;
        } catch {
          channel = null;
        }
      }
      open(opener.dataset.channelOpen === "edit" ? "edit" : "add", channel, opener);
      return;
    }
    const add = target?.closest<HTMLElement>("[data-header-add]");
    if (add) {
      event.preventDefault();
      const list = add
        .closest("[data-header-rows]")
        ?.querySelector<HTMLElement>("[data-header-list]");
      if (list) {
        addHeaderRow(list);
        list
          .querySelector<HTMLInputElement>(".nz-header-row:last-child [data-header-name]")
          ?.focus();
      }
      return;
    }
    const remove = target?.closest<HTMLElement>("[data-header-remove]");
    if (remove) {
      remove.closest(".nz-header-row")?.remove();
      return;
    }
    const testButton = target?.closest<HTMLButtonElement>("[data-channel-test]");
    const channelForm = testButton?.closest<HTMLFormElement>("[data-channel-form]");
    if (testButton && channelForm) {
      event.preventDefault();
      void test(channelForm, testButton);
    }
  });

  document.addEventListener("change", (event) => {
    const select = event.target;
    if (select instanceof HTMLSelectElement && select.matches("[data-channel-type]")) {
      const target = select.closest<HTMLFormElement>("[data-channel-form]");
      if (target) {
        clearErrors(target);
        showType(target, select.value);
      }
    }
  });

  document.addEventListener("submit", (event) => {
    const target = event.target;
    if (target instanceof HTMLFormElement && target.matches("[data-channel-form]")) {
      event.preventDefault();
      void save(target);
    }
  });
}
