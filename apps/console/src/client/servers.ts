import { attachedServicesText } from "@nearzero/shared/browser";
import {
  browserCopyEnvironment,
  COPIED_MESSAGE,
  COPY_REFUSED_MESSAGE,
  copyText,
} from "../lib/copy-text.ts";
import type { ServerRecord } from "../lib/data/operations-types.ts";
import { asApiError, callApi, clearErrors, refreshPage, showErrors } from "./api.ts";
import { openDialog } from "./dialogs.ts";
import { showToast } from "./toasts.ts";

/**
 * The Servers page in the browser (spec 9.1, 9.2, 9.6, 9.7).
 *
 * The setup and details dialogs come from the server setup milestone. This page asks for them by
 * dispatching `nz:server-setup` (after Create, and Run setup again) and `nz:server-details`
 * (View) on `document` with `{ serverId, server }`; a handler that opens its dialog calls
 * `event.preventDefault()`. While none does, the page falls back to its own "Connect this
 * server" dialog (the join command) and a read-only details list.
 */

function serverOf(id: string): ServerRecord | null {
  const card = document.querySelector<HTMLElement>(`[data-server-card="${CSS.escape(id)}"]`);
  try {
    return card?.dataset.server ? (JSON.parse(card.dataset.server) as ServerRecord) : null;
  } catch {
    return null;
  }
}

function ask(kind: "setup" | "details", serverId: string, server: ServerRecord | null): boolean {
  const event = new CustomEvent(`nz:server-${kind}`, {
    detail: { serverId, server },
    cancelable: true,
  });
  document.dispatchEvent(event);
  return event.defaultPrevented;
}

async function showJoinCommand(serverId: string, opener: Element | null): Promise<void> {
  const dialog = document.querySelector<HTMLDialogElement>("#nz-server-connect");
  if (!dialog) return;
  const status = dialog.querySelector<HTMLElement>("[data-server-connect-status]");
  const row = dialog.querySelector<HTMLElement>("[data-server-connect-row]");
  const note = dialog.querySelector<HTMLElement>("[data-server-connect-note]");
  if (status) status.textContent = "Asking for a join command…";
  if (row) row.hidden = true;
  const tokenRow = dialog.querySelector<HTMLElement>("[data-server-connect-token-row]");
  if (tokenRow) tokenRow.hidden = true;
  if (note) note.textContent = "";
  openDialog(dialog, opener);
  try {
    const answer = await callApi<{
      command: string;
      token: string;
      note?: string;
      expiresAt: string;
    }>("POST", `/servers/${encodeURIComponent(serverId)}/join-command`);
    if (status) {
      status.textContent =
        "For a server Nearzero can't reach over SSH: run this on it to install its runner and join. It works once, within an hour.";
    }
    const command = dialog.querySelector<HTMLElement>("[data-server-connect-command]");
    if (command) command.textContent = answer.command;
    const copy = dialog.querySelector<HTMLElement>("[data-server-connect-copy]");
    if (copy) copy.dataset.copy = answer.command;
    if (row) row.hidden = false;
    // The token is pasted when the command asks, never typed into the command (B2-16).
    const tokenRow = dialog.querySelector<HTMLElement>("[data-server-connect-token-row]");
    const token = dialog.querySelector<HTMLElement>("[data-server-connect-token]");
    const tokenCopy = dialog.querySelector<HTMLElement>("[data-server-connect-token-copy]");
    if (token) token.textContent = answer.token;
    if (tokenCopy) tokenCopy.dataset.copy = answer.token;
    if (tokenRow) tokenRow.hidden = !answer.command;
    if (note) note.textContent = answer.note ?? "";
  } catch (error) {
    if (status) status.textContent = asApiError(error).message;
  }
}

function showDetails(server: ServerRecord, opener: Element | null): void {
  const dialog = document.querySelector<HTMLDialogElement>("#nz-server-view");
  const list = dialog?.querySelector<HTMLElement>("[data-server-view-list]");
  if (!dialog || !list) return;
  const rows: [string, string][] = [
    ["Address", server.address],
    ...(server.publicIPv4 ? [["Public IPv4", server.publicIPv4] as [string, string]] : []),
    ["Port", String(server.port)],
    ["User", server.sshUser],
    ["SSH key", server.sshKey?.name ?? "—"],
    ["Host key fingerprint", server.hostKeyFingerprint ?? "Not recorded yet"],
    [
      "Setup finished",
      server.setup.finishedAt ? new Date(server.setup.finishedAt).toLocaleString() : "—",
    ],
    [
      "Runner",
      server.runner.state === "online" && server.runner.message
        ? `Online. ${server.runner.message}`
        : (server.runner.message ?? server.runner.state.replace("_", " ")),
    ],
    // R3-22: "HTTP/3 is off: UDP port 443 is in use by …" when something else holds the port.
    ...(server.runner.http3
      ? [["HTTP/3", server.runner.http3.message ?? "On"] as [string, string]]
      : []),
    ["Description", server.description || "—"],
  ];
  list.replaceChildren(
    ...rows.map(([label, value]) => {
      const item = document.createElement("div");
      const term = document.createElement("dt");
      term.textContent = label;
      const detail = document.createElement("dd");
      detail.textContent = value;
      item.append(term, detail);
      return item;
    }),
  );
  const title = dialog.querySelector<HTMLElement>(".nz-dialog-title");
  if (title) title.textContent = server.name;
  openDialog(dialog, opener);
}

// ---------- Router files (spec 9.1): a read-only tree

interface FileNode {
  name: string;
  path: string;
  children: Map<string, FileNode>;
  contents: string | null;
}

function tree(files: { name: string; contents: string }[]): FileNode {
  const root: FileNode = { name: "", path: "", children: new Map(), contents: null };
  for (const file of files) {
    let node = root;
    const parts = file.name.split("/").filter(Boolean);
    parts.forEach((part, index) => {
      const path = parts.slice(0, index + 1).join("/");
      let next = node.children.get(part);
      if (!next) {
        next = { name: part, path, children: new Map(), contents: null };
        node.children.set(part, next);
      }
      if (index === parts.length - 1) next.contents = file.contents;
      node = next;
    });
  }
  return root;
}

function renderTree(node: FileNode, view: HTMLElement): HTMLElement[] {
  return Array.from(node.children.values())
    .sort(
      (a, b) =>
        Number(b.children.size > 0) - Number(a.children.size > 0) || a.name.localeCompare(b.name),
    )
    .map((child) => {
      const item = document.createElement("li");
      if (child.children.size > 0) {
        const label = document.createElement("span");
        label.className = "nz-file-folder";
        label.textContent = `${child.name}/`;
        const list = document.createElement("ul");
        list.append(...renderTree(child, view));
        item.append(label, list);
      } else {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "nz-file-link";
        button.textContent = child.name;
        button.addEventListener("click", () => {
          view.textContent = child.contents ?? "";
          for (const other of button
            .closest("[data-router-files-tree]")
            ?.querySelectorAll("[aria-current]") ?? []) {
            other.removeAttribute("aria-current");
          }
          button.setAttribute("aria-current", "true");
        });
        item.append(button);
      }
      return item;
    });
}

async function routerFiles(serverId: string, name: string, opener: Element | null): Promise<void> {
  const dialog = document.querySelector<HTMLDialogElement>("#nz-router-files");
  if (!dialog) return;
  const status = dialog.querySelector<HTMLElement>("[data-router-files-status]");
  const list = dialog.querySelector<HTMLElement>("[data-router-files-tree]");
  const view = dialog.querySelector<HTMLElement>("[data-router-files-view]");
  if (!list || !view) return;
  list.replaceChildren();
  view.textContent = "";
  if (status) status.textContent = `Reading the router's files on ${name}…`;
  openDialog(dialog, opener);
  try {
    const answer = await callApi<{
      files: { name: string; contents: string }[];
      mainSettings?: { title: string; contents: string } | null;
    }>("GET", `/servers/${encodeURIComponent(serverId)}/router-files`);
    // The router's main settings sit beside its files, read-only like everything here (R3-23).
    const main = answer.mainSettings
      ? [{ name: answer.mainSettings.title, contents: answer.mainSettings.contents }]
      : [];
    list.append(...renderTree(tree([...main, ...answer.files]), view));
    if (status) {
      status.textContent =
        answer.files.length === 0
          ? "The router's folder has no configuration files yet."
          : `${answer.files.length} files. Files Nearzero writes for services are overwritten on the next deploy.`;
    }
    list.querySelector<HTMLButtonElement>(".nz-file-link")?.click();
  } catch (error) {
    if (status) status.textContent = asApiError(error).message;
  }
}

// ---------- SSH keys (spec 9.7)

async function generate(form: HTMLFormElement, type: string): Promise<void> {
  const name = form.querySelector<HTMLInputElement>('[name="name"]')?.value.trim();
  try {
    const answer = await callApi<{ publicKey: string; privateKey: string; message: string }>(
      "POST",
      "/ssh-keys/generate",
      { type, ...(name ? { name } : {}) },
    );
    const set = (field: string, value: string) => {
      const input = form.querySelector<HTMLTextAreaElement>(`[name="${field}"]`);
      if (input) input.value = value;
    };
    set("privateKey", answer.privateKey);
    set("publicKey", answer.publicKey);
    showToast(answer.message || "SSH key generated", { tone: "success" });
  } catch (error) {
    showToast(asApiError(error).message, { tone: "error" });
  }
}

function download(form: HTMLFormElement, which: "private" | "public"): void {
  const text =
    form.querySelector<HTMLTextAreaElement>(
      `[name="${which === "private" ? "privateKey" : "publicKey"}"]`,
    )?.value ?? "";
  if (!text.trim()) {
    showToast(`There's no ${which} key to download yet. Generate or paste one first.`, {
      tone: "info",
    });
    return;
  }
  const base =
    (form.querySelector<HTMLInputElement>('[name="name"]')?.value.trim() || "nearzero-key")
      .replace(/[^\w.-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "nearzero-key";
  const blob = new Blob([text.endsWith("\n") ? text : `${text}\n`], { type: "text/plain" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = which === "private" ? base : `${base}.pub`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
}

function syncDelete(dialog: HTMLElement): void {
  const services = Number(
    dialog.querySelector<HTMLElement>('[data-fill-text="services"]')?.textContent ?? "0",
  );
  const none = dialog.querySelector<HTMLElement>("[data-server-delete-none]");
  const some = dialog.querySelector<HTMLElement>("[data-server-delete-some]");
  // "1 attached service", never "1 attached services" (G3-08).
  const count = dialog.querySelector<HTMLElement>("[data-server-delete-count]");
  if (count) count.textContent = attachedServicesText(services);
  const tick = dialog.querySelector<HTMLInputElement>("[data-server-delete-tick]");
  const go = dialog.querySelector<HTMLButtonElement>("[data-server-delete-go]");
  if (none) none.hidden = services > 0;
  if (some) some.hidden = services === 0;
  if (go) {
    go.textContent = services > 0 ? "Delete services and server" : "Delete server";
    go.disabled = services > 0 && !tick?.checked;
  }
}

/** Resets the delete dialog to its question (it may show an earlier removal). */
function resetDelete(dialog: HTMLElement): void {
  const toggle = (selector: string, shown: boolean) => {
    const element = dialog.querySelector<HTMLElement>(selector);
    if (element) element.hidden = !shown;
  };
  toggle("[data-server-delete-ask]", true);
  toggle("[data-server-removal]", false);
  toggle("[data-server-delete-cancel]", true);
  toggle("[data-server-delete-go]", true);
  toggle("[data-server-removal-close]", false);
  const tick = dialog.querySelector<HTMLInputElement>("[data-server-delete-tick]");
  if (tick) tick.checked = false;
  syncDelete(dialog);
}

interface Removal {
  state: "running" | "succeeded" | "failed";
  message: string;
  items: {
    name: string | null;
    projectName: string | null;
    environmentName: string | null;
    state: "waiting" | "removing" | "removed" | "not_removed";
    reason: string | null;
  }[];
}

const ITEM_WORDS: Record<Removal["items"][number]["state"], { pill: string; label: string }> = {
  waiting: { pill: "idle", label: "Waiting" },
  removing: { pill: "run", label: "Removing" },
  removed: { pill: "ok", label: "Removed" },
  not_removed: { pill: "fail", label: "Not removed" },
};

function paintRemoval(dialog: HTMLElement, removal: Removal): void {
  const message = dialog.querySelector<HTMLElement>("[data-server-removal-message]");
  if (message) message.textContent = removal.message;
  dialog.querySelector("[data-server-removal-items]")?.replaceChildren(
    ...removal.items.map((item) => {
      const row = document.createElement("div");
      row.className = "nz-teardown-row";
      const name = document.createElement("span");
      name.className = "nz-truncate font-medium";
      name.textContent = item.name ?? "No access";
      const where = document.createElement("span");
      where.className = "nz-small nz-dim";
      where.textContent =
        item.reason ?? [item.projectName, item.environmentName].filter(Boolean).join(" / ");
      if (item.reason) where.classList.add("nz-danger-text");
      const pill = document.createElement("span");
      pill.className = "nz-pill";
      pill.dataset.status = ITEM_WORDS[item.state].pill;
      pill.textContent = ITEM_WORDS[item.state].label;
      row.append(name, where, pill);
      return row;
    }),
  );
}

/** Follows a server's removal (spec 9.6) until every service is removed, or some couldn't be. */
async function followRemoval(dialog: HTMLElement, serverId: string, first: Removal): Promise<void> {
  const toggle = (selector: string, shown: boolean) => {
    const element = dialog.querySelector<HTMLElement>(selector);
    if (element) element.hidden = !shown;
  };
  toggle("[data-server-delete-ask]", false);
  toggle("[data-server-removal]", true);
  toggle("[data-server-delete-go]", false);
  toggle("[data-server-delete-cancel]", false);
  toggle("[data-server-removal-close]", true);
  let removal = first;
  paintRemoval(dialog, removal);
  while (removal.state === "running" && (dialog as HTMLDialogElement).open) {
    await new Promise((done) => window.setTimeout(done, 2000));
    try {
      const answer = await callApi<{ removal: Removal | null }>(
        "GET",
        `/servers/${encodeURIComponent(serverId)}/removal`,
      );
      if (answer.removal) removal = answer.removal;
    } catch (error) {
      const message = dialog.querySelector<HTMLElement>("[data-server-removal-message]");
      if (message) message.textContent = asApiError(error).message;
    }
    paintRemoval(dialog, removal);
  }
  if (removal.state === "succeeded") {
    showToast(removal.message || "Server deleted", { tone: "success" });
    (dialog as HTMLDialogElement).close();
  }
  await refreshPage();
}

async function deleteServer(form: HTMLFormElement): Promise<void> {
  const dialog = form.closest<HTMLElement>("dialog");
  const serverId = form.querySelector<HTMLInputElement>('[name="serverId"]')?.value ?? "";
  const withServices =
    form.querySelector<HTMLInputElement>("[data-server-delete-tick]")?.checked ?? false;
  if (!dialog || form.hasAttribute("data-busy")) return;
  clearErrors(form);
  form.setAttribute("data-busy", "");
  try {
    const answer = await callApi<{ deleted: boolean; message: string; removal?: Removal }>(
      "DELETE",
      `/servers/${encodeURIComponent(serverId)}${withServices ? "?deleteServices=true" : ""}`,
    );
    if (answer.deleted || !answer.removal) {
      showToast(answer.message || "Server deleted", { tone: "success" });
      (dialog as HTMLDialogElement).close();
      await refreshPage();
      return;
    }
    await followRemoval(dialog, serverId, {
      ...answer.removal,
      message: answer.removal.message || answer.message,
    });
  } catch (error) {
    showErrors(form, asApiError(error));
  } finally {
    form.removeAttribute("data-busy");
  }
}

/** Create Server stays disabled until every required field holds something (spec 21.10). */
function syncFillToSubmit(form: HTMLFormElement): void {
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!submit) return;
  const empty = Array.from(
    form.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-required]"),
  ).some((field) => field.value.trim() === "");
  submit.disabled = empty;
}

export function initServers(): void {
  for (const type of ["input", "change"]) {
    document.addEventListener(type, (event) => {
      const form = (event.target as Element | null)?.closest?.<HTMLFormElement>(
        "form[data-fill-to-submit]",
      );
      if (form) syncFillToSubmit(form);
    });
  }
  document.addEventListener("reset", (event) => {
    const form = event.target;
    if (form instanceof HTMLFormElement && form.matches("[data-fill-to-submit]")) {
      setTimeout(() => syncFillToSubmit(form), 0);
    }
  });
  document.addEventListener("nz:api-success", (event) => {
    const form = event.target as HTMLFormElement | null;
    const kind = form?.dataset.serverForm;
    if (!form || !kind) return;
    const answer = (event as CustomEvent<{ server: ServerRecord; notices?: string[] }>).detail;
    form.closest("dialog")?.close();
    if (kind === "add") {
      showToast(`Added ${answer.server.name}`, { tone: "success" });
      form.reset();
      void refreshPage().then(() => {
        if (!ask("setup", answer.server.id, answer.server))
          void showJoinCommand(answer.server.id, null);
      });
    } else {
      showToast("Server updated", { tone: "success" });
      for (const notice of answer.notices ?? []) showToast(notice, { tone: "info", persist: true });
      void refreshPage();
    }
  });

  document.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    const setup = target?.closest<HTMLElement>("[data-server-setup]");
    if (setup) {
      const id = setup.dataset.serverSetup ?? "";
      if (!ask("setup", id, serverOf(id))) void showJoinCommand(id, setup);
      return;
    }
    const details = target?.closest<HTMLElement>("[data-server-details]");
    if (details) {
      const id = details.dataset.serverDetails ?? "";
      const server = serverOf(id);
      if (!ask("details", id, server) && server) showDetails(server, details);
      return;
    }
    const files = target?.closest<HTMLElement>("[data-router-files]");
    if (files) {
      void routerFiles(files.dataset.routerFiles ?? "", files.dataset.serverName ?? "", files);
      return;
    }
    if (target?.closest("[data-dialog-open='nz-server-delete']")) {
      const dialog = document.querySelector<HTMLElement>("#nz-server-delete");
      if (dialog) resetDelete(dialog);
      return;
    }
    const generator = target?.closest<HTMLElement>("[data-ssh-generate]");
    if (generator) {
      event.preventDefault();
      const form = generator.closest<HTMLFormElement>("form");
      if (form) void generate(form, generator.dataset.sshGenerate ?? "ed25519");
      return;
    }
    // A saved key's public half, from its Edit dialog (R3-03).
    const copyPublic = target?.closest<HTMLElement>("[data-ssh-copy-public]");
    if (copyPublic && event.isTrusted) {
      event.preventDefault();
      const value =
        copyPublic
          .closest<HTMLFormElement>("form")
          ?.querySelector<HTMLTextAreaElement>('[name="publicKey"]')?.value ?? "";
      void copyText(value, browserCopyEnvironment()).then((ok) =>
        showToast(ok ? COPIED_MESSAGE : COPY_REFUSED_MESSAGE, { tone: ok ? "success" : "error" }),
      );
      return;
    }
    const downloader = target?.closest<HTMLElement>("[data-ssh-download]");
    if (downloader) {
      event.preventDefault();
      const form = downloader.closest<HTMLFormElement>("form");
      if (form) download(form, downloader.dataset.sshDownload === "public" ? "public" : "private");
    }
  });

  document.addEventListener("submit", (event) => {
    const form = event.target;
    // A key's read-only view never sends anything (R3-03).
    if (form instanceof HTMLFormElement && form.matches("[data-ssh-key-view]")) {
      event.preventDefault();
      return;
    }
    if (!(form instanceof HTMLFormElement) || !form.matches("[data-server-delete-form]")) return;
    event.preventDefault();
    void deleteServer(form);
  });

  document.addEventListener("change", (event) => {
    const tick = event.target as HTMLElement | null;
    if (tick?.matches?.("[data-server-delete-tick]")) {
      const dialog = tick.closest<HTMLElement>("dialog");
      if (dialog) syncDelete(dialog);
    }
  });
}
