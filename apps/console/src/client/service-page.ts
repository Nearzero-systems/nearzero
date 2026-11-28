import { splitWatchPaths, UPLOAD_MAX_BYTES, UPLOAD_TOO_LARGE } from "@nearzero/shared/browser";
import { checkMountRows, checkPortRows } from "../lib/runtime-rules.ts";
import { asApiError, callApi, clearErrors, refreshPage, sendForm, showFormError } from "./api.ts";
import { closeDeployLog, openDeployLog } from "./deploy-log.ts";
import { deployAndTell, rememberLiveAt } from "./deploys.ts";
import { openDialog } from "./dialogs.ts";
import { showToast } from "./toasts.ts";

/**
 * A service page's own behaviors (spec 6.2–6.9, 8.2): the Deployments list's log dialog, the
 * "Live at" banner's Dismiss, Create URL, the Source tabs (image with registry credentials, Git
 * URL, the .zip upload with progress), the Build panel, Deployment settings switches and the
 * deploy webhook, and the Advanced tab's Ports and Mounts editors with the offer to deploy.
 */

function value(form: HTMLFormElement, name: string): string {
  const field = form.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`);
  return field?.value.trim() ?? "";
}

function checked(form: HTMLFormElement, name: string): boolean {
  return form.querySelector<HTMLInputElement>(`[name="${name}"]`)?.checked ?? false;
}

/** After a change that applies on the next deploy, offer to deploy now (spec 6.8). */
function offerDeploy(serviceId: string, notes: string[]): void {
  const text = notes.length > 0 ? notes.join(" ") : "Saved. It applies on the next deploy.";
  if (!serviceId) {
    showToast(text, { tone: "success" });
    return;
  }
  showToast(text, {
    tone: "success",
    action: {
      label: "Deploy now",
      run: () => void deployAndTell(serviceId).then(() => refreshPage()),
    },
  });
}

// ---------- Create URL (spec 6.2)

async function createUrl(button: HTMLElement): Promise<void> {
  const serviceId = button.dataset.createUrl ?? "";
  button.setAttribute("aria-disabled", "true");
  try {
    const port = Number(button.dataset.port);
    const answer = await callApi<{
      hostname: { url: string; hostname: string };
      message: string;
      missingRecord: { message: string } | null;
    }>(
      "POST",
      `/services/${encodeURIComponent(serviceId)}/hostnames/generate`,
      Number.isInteger(port) && port > 0 ? { port } : {},
    );
    showToast(answer.message, { tone: "success" });
    if (answer.missingRecord)
      showToast(answer.missingRecord.message, { tone: "info", persist: true });
    rememberLiveAt(serviceId, answer.hostname.url);
    await refreshPage();
  } catch (error) {
    showToast(asApiError(error).message, { tone: "error", persist: true });
  } finally {
    button.removeAttribute("aria-disabled");
  }
}

// ---------- Sources and the build (spec 6.3, 6.4)

function imageBody(form: HTMLFormElement): Record<string, unknown> {
  const body: Record<string, unknown> = { type: "image", image: value(form, "image") };
  const address = value(form, "registry.address");
  const username = value(form, "registry.username");
  const password = form.querySelector<HTMLInputElement>('[name="registry.password"]')?.value ?? "";
  if (address || username) body.registry = { address, username, password };
  return body;
}

function gitBody(form: HTMLFormElement): Record<string, unknown> {
  return {
    type: "git",
    url: value(form, "url"),
    branch: value(form, "branch") || "main",
    buildPath: value(form, "buildPath"),
    sshKeyId: value(form, "sshKeyId") || null,
    trigger: value(form, "trigger") === "tag" ? "tag" : "push",
    // Commas inside braces belong to the pattern (G2-03).
    watchPaths: splitWatchPaths(value(form, "watchPaths")),
    submodules: checked(form, "submodules"),
    // The Compose page's Git tab names the Compose file instead of a build path (spec 7.2).
    ...(form.elements.namedItem("composePath") ? { composePath: value(form, "composePath") } : {}),
  };
}

function buildBody(form: HTMLFormElement): Record<string, unknown> {
  const type = value(form, "type") || "automatic";
  const builder: Record<string, unknown> = { type };
  if (type === "dockerfile") {
    builder.dockerfilePath = value(form, "dockerfilePath") || "Dockerfile";
    builder.contextPath = value(form, "contextPath");
    builder.stage = value(form, "stage");
  } else if (type === "railpack") builder.version = value(form, "version");
  else if (type === "nixpacks") builder.publishDirectory = value(form, "publishDirectory");
  else if (type === "heroku") builder.stack = value(form, "stack");
  else if (type === "static") builder.spa = checked(form, "spa");
  return {
    builder,
    commands: {
      install: value(form, "install"),
      build: value(form, "build"),
      start: value(form, "start"),
    },
  };
}

/** The .zip upload (spec 6.3): streamed with progress; at most 200 MB. */
function upload(form: HTMLFormElement): void {
  clearErrors(form);
  const input = form.querySelector<HTMLInputElement>('input[type="file"]');
  const file = input?.files?.[0];
  if (!file) {
    showFormError(form, "Choose a .zip archive to upload.");
    return;
  }
  if (!/\.zip$/i.test(file.name)) {
    showFormError(form, "That file isn't a .zip archive. Upload a .zip file.");
    return;
  }
  if (file.size > UPLOAD_MAX_BYTES) {
    showFormError(form, UPLOAD_TOO_LARGE);
    return;
  }
  const serviceId = form.dataset.serviceId ?? "";
  const deploy = form.dataset.canDeploy === "true";
  const params = new URLSearchParams({ buildPath: value(form, "buildPath"), fileName: file.name });
  if (deploy) params.set("deploy", "1");
  const bar = form.querySelector<HTMLElement>("[data-upload-bar]");
  const progress = form.querySelector<HTMLElement>("[data-upload-progress]");
  const status = form.querySelector<HTMLElement>("[data-upload-status]");
  if (progress) progress.hidden = false;
  form.setAttribute("data-busy", "");
  const request = new XMLHttpRequest();
  request.open("POST", `/api/v1/services/${encodeURIComponent(serviceId)}/source/upload?${params}`);
  request.setRequestHeader("content-type", "application/zip");
  request.setRequestHeader("accept", "application/json");
  request.upload.addEventListener("progress", (event) => {
    if (!event.lengthComputable) return;
    const percent = Math.round((event.loaded / event.total) * 100);
    if (bar) bar.style.width = `${percent}%`;
    if (status) status.textContent = `Uploading… ${percent}%`;
  });
  request.addEventListener("load", () => {
    form.removeAttribute("data-busy");
    let body: { message?: string; error?: { message?: string } } = {};
    try {
      body = JSON.parse(request.responseText || "{}");
    } catch {
      // Keep the empty body.
    }
    if (request.status >= 200 && request.status < 300) {
      if (status) status.textContent = "";
      showToast(body.message ?? "Archive uploaded", { tone: "success" });
      void refreshPage();
    } else {
      if (progress) progress.hidden = true;
      if (status) status.textContent = "";
      showFormError(
        form,
        body.error?.message ?? `The upload failed (HTTP ${request.status}). Try again.`,
      );
    }
  });
  request.addEventListener("error", () => {
    form.removeAttribute("data-busy");
    if (progress) progress.hidden = true;
    showFormError(form, "The upload didn't reach Nearzero. Check the connection and try again.");
  });
  request.send(file);
}

// ---------- Ports and mounts (spec 6.8)

function rowsOf(form: HTMLFormElement, kind: string): HTMLElement[] {
  return Array.from(
    form.querySelectorAll<HTMLElement>(`[data-rows="${kind}"] [data-row="${kind}"]`),
  );
}

function syncEmpty(form: HTMLFormElement, kind: string): void {
  const empty = form.querySelector<HTMLElement>(`[data-rows-empty="${kind}"]`);
  if (empty) empty.hidden = rowsOf(form, kind).length > 0;
}

function addRow(form: HTMLFormElement, kind: string): void {
  const template = form.querySelector<HTMLTemplateElement>(`[data-row-template="${kind}"]`);
  const rows = form.querySelector<HTMLElement>(`[data-rows="${kind}"]`);
  if (!template || !rows) return;
  rows.append(template.content.cloneNode(true));
  syncEmpty(form, kind);
  rows.lastElementChild?.querySelector<HTMLElement>("input, select")?.focus();
}

function syncMountKind(row: HTMLElement): void {
  const kind = row.querySelector<HTMLSelectElement>("[data-mount-kind]")?.value ?? "volume";
  row.dataset.mountType = kind;
  for (const element of row.querySelectorAll<HTMLElement>("[data-mount-for]")) {
    element.hidden = element.dataset.mountFor !== kind;
  }
}

let removingVolume: HTMLElement | null = null;

function removeRow(row: HTMLElement): void {
  const form = row.closest<HTMLFormElement>("form");
  if (!form) return;
  // Removing a saved volume mount asks whether to keep its data (spec 6.8).
  if (row.dataset.mountType === "volume" && row.dataset.mountId && row.dataset.volume) {
    const dialog = document.querySelector<HTMLDialogElement>("[data-remove-volume]");
    if (dialog) {
      removingVolume = row;
      const slot = dialog.querySelector<HTMLElement>('[data-fill-text="volume"]');
      if (slot) slot.textContent = row.dataset.volume;
      const box = dialog.querySelector<HTMLInputElement>("[data-remove-volume-data]");
      if (box) box.checked = false;
      openDialog(dialog, row.querySelector("[data-row-remove]"));
      return;
    }
  }
  const kind = row.dataset.row ?? "";
  row.remove();
  syncEmpty(form, kind);
}

async function savePorts(form: HTMLFormElement): Promise<void> {
  clearErrors(form);
  const checked = checkPortRows(
    rowsOf(form, "port").map((row) => ({
      containerPort: row.querySelector<HTMLInputElement>('[name="containerPort"]')?.value ?? "",
      publishedPort: row.querySelector<HTMLInputElement>('[name="publishedPort"]')?.value ?? "",
      protocol: row.querySelector<HTMLSelectElement>('[name="protocol"]')?.value ?? "tcp",
      mode: row.querySelector<HTMLSelectElement>('[name="mode"]')?.value ?? "routed",
    })),
  );
  if ("problem" in checked) {
    showFormError(form, `Row ${checked.row}: ${checked.problem}`);
    return;
  }
  const answer = (await sendWith(form, "PUT", "ports", { ports: checked.ports })) as {
    notes?: string[];
  } | null;
  if (answer) {
    offerDeploy(form.dataset.offerDeploy ?? "", answer.notes ?? []);
    await refreshPage();
  }
}

async function saveMounts(form: HTMLFormElement): Promise<void> {
  clearErrors(form);
  const checked = checkMountRows(
    rowsOf(form, "mount").map((row) => {
      const kind =
        row.dataset.mountType ??
        row.querySelector<HTMLInputElement>('[name="type"]')?.value ??
        "volume";
      // A volume of another app, picked as "<app id>:<volume>" (31b G2-08).
      const share =
        kind === "shared"
          ? (row.querySelector<HTMLSelectElement>('[name="share"]')?.value ?? "")
          : "";
      const of = share ? share.slice(0, share.indexOf(":")) : row.dataset.mountOf;
      return {
        type: kind === "shared" ? "volume" : kind,
        id: row.dataset.mountId ?? "",
        name: share
          ? share.slice(share.indexOf(":") + 1)
          : (row.querySelector<HTMLInputElement>('[name="name"]')?.value ?? ""),
        ...(of ? { of } : {}),
        hostPath: row.querySelector<HTMLInputElement>('[name="hostPath"]')?.value ?? "",
        containerPath: row.querySelector<HTMLInputElement>('[name="containerPath"]')?.value ?? "",
        readOnly: row.querySelector<HTMLInputElement>('[name="readOnly"]')?.checked ?? false,
        content: row.querySelector<HTMLTextAreaElement>('[name="content"]')?.value ?? "",
      };
    }),
  );
  if ("problem" in checked) {
    showFormError(form, `Row ${checked.row}: ${checked.problem}`);
    return;
  }
  const deleteVolumeData = (form.dataset.deleteVolumes ?? "").split(",").filter(Boolean);
  const answer = (await sendWith(form, "PUT", "mounts", {
    mounts: checked.mounts,
    ...(deleteVolumeData.length > 0 ? { deleteVolumeData } : {}),
  })) as { notes?: string[] } | null;
  if (answer) {
    offerDeploy(form.dataset.offerDeploy ?? "", answer.notes ?? []);
    await refreshPage();
  }
}

async function sendWith(
  form: HTMLFormElement,
  method: string,
  what: string,
  body: unknown,
): Promise<unknown> {
  form.setAttribute("data-busy", "");
  try {
    return await callApi(
      method,
      `/services/${encodeURIComponent(form.dataset.serviceId ?? "")}/${what}`,
      body,
    );
  } catch (error) {
    showFormError(form, asApiError(error).message);
    return null;
  } finally {
    form.removeAttribute("data-busy");
  }
}

// ---------- Deployment settings and the webhook (spec 6.6)

async function saveSetting(input: HTMLInputElement): Promise<void> {
  const key = input.dataset.deploySetting ?? "";
  const serviceId = input.dataset.serviceId ?? "";
  input.disabled = true;
  try {
    await callApi("PATCH", `/services/${encodeURIComponent(serviceId)}/deploy-settings`, {
      [key]: input.checked,
    });
    showToast(
      key === "autodeploy"
        ? `Autodeploy ${input.checked ? "on" : "off"}`
        : `Clean cache ${input.checked ? "on" : "off"}`,
      { tone: "success" },
    );
  } catch (error) {
    input.checked = !input.checked;
    showToast(asApiError(error).message, { tone: "error", persist: true });
  } finally {
    input.disabled = false;
  }
}

function toggleWebhook(button: HTMLElement): void {
  const box = button.closest<HTMLElement>("[data-webhook]");
  const url = box?.querySelector<HTMLElement>("[data-webhook-url]");
  if (!url) return;
  const shown = button.getAttribute("aria-pressed") === "true";
  url.textContent = shown ? "•".repeat(24) : (url.dataset.url ?? "");
  button.setAttribute("aria-pressed", shown ? "false" : "true");
  const label = Array.from(button.childNodes).find((node) => node.nodeType === Node.TEXT_NODE);
  if (label) label.textContent = shown ? "Show URL" : "Hide URL";
}

let replacing: HTMLElement | null = null;

async function replaceWebhook(box: HTMLElement): Promise<void> {
  try {
    const answer = await callApi<{ message?: string }>(
      "POST",
      `/services/${encodeURIComponent(box.dataset.serviceId ?? "")}/webhook`,
    );
    showToast(answer.message ?? "Webhook URL created", { tone: "success" });
    await refreshPage();
  } catch (error) {
    showToast(asApiError(error).message, { tone: "error", persist: true });
  }
}

export function initServicePage(): void {
  document.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    const logOpener = target?.closest<HTMLElement>("[data-deployment-log-open]");
    if (logOpener) {
      const root = document.querySelector<HTMLElement>("#nz-deployment-log [data-deploy-log]");
      if (root) {
        openDeployLog(root, logOpener.dataset.deploymentLogOpen, {
          live: logOpener.dataset.deploymentLive === "true",
        });
      }
      return;
    }
    if (target?.closest("[data-live-at-dismiss]")) {
      const banner = target.closest<HTMLElement>("[data-live-at]");
      if (banner) banner.hidden = true;
      return;
    }
    const create = target?.closest<HTMLElement>("[data-create-url]");
    if (create) {
      event.preventDefault();
      if (create.getAttribute("aria-disabled") !== "true") void createUrl(create);
      return;
    }
    const add = target?.closest<HTMLElement>("[data-row-add]");
    if (add) {
      event.preventDefault();
      const form = add.closest<HTMLFormElement>("form");
      if (form) addRow(form, add.dataset.rowAdd ?? "");
      return;
    }
    const remove = target?.closest<HTMLElement>("[data-row-remove]");
    if (remove) {
      event.preventDefault();
      const row = remove.closest<HTMLElement>("[data-row]");
      if (row) removeRow(row);
      return;
    }
    if (target?.closest("[data-remove-volume-go]")) {
      const dialog = target.closest("dialog");
      const row = removingVolume;
      removingVolume = null;
      dialog?.close();
      const form = row?.closest<HTMLFormElement>("form");
      if (!row || !form) return;
      if (
        dialog?.querySelector<HTMLInputElement>("[data-remove-volume-data]")?.checked &&
        row.dataset.volume
      ) {
        const list = new Set((form.dataset.deleteVolumes ?? "").split(",").filter(Boolean));
        list.add(row.dataset.volume);
        form.dataset.deleteVolumes = Array.from(list).join(",");
      }
      row.remove();
      syncEmpty(form, "mount");
      return;
    }
    const show = target?.closest<HTMLElement>("[data-webhook-show]");
    if (show) {
      event.preventDefault();
      toggleWebhook(show);
      return;
    }
    const replace = target?.closest<HTMLElement>("[data-webhook-replace]");
    if (replace) {
      event.preventDefault();
      const box = replace.closest<HTMLElement>("[data-webhook]");
      if (!box) return;
      if (replace.dataset.replacing !== "true") {
        void replaceWebhook(box);
        return;
      }
      const dialog = document.querySelector<HTMLDialogElement>("#nz-replace-webhook");
      replacing = box;
      if (dialog) openDialog(dialog, replace);
      return;
    }
    if (target?.closest("[data-replace-webhook-go]")) {
      target.closest("dialog")?.close();
      const box = replacing;
      replacing = null;
      if (box) void replaceWebhook(box);
    }
  });

  document.addEventListener(
    "close",
    (event) => {
      const dialog = event.target as Element | null;
      if (!dialog?.matches?.("#nz-deployment-log")) return;
      const root = dialog.querySelector<HTMLElement>("[data-deploy-log]");
      if (root) closeDeployLog(root);
    },
    true,
  );

  document.addEventListener("change", (event) => {
    const target = event.target as HTMLElement | null;
    if (target instanceof HTMLInputElement && target.matches("[data-deploy-setting]")) {
      void saveSetting(target);
    } else if (target?.matches("[data-mount-kind]")) {
      const row = target.closest<HTMLElement>("[data-row]");
      if (row) syncMountKind(row);
    } else if (target?.matches("[data-builder-type]")) {
      const form = target.closest<HTMLFormElement>("form");
      const type = (target as HTMLSelectElement).value;
      for (const group of form?.querySelectorAll<HTMLElement>("[data-builder-fields]") ?? []) {
        group.hidden = group.dataset.builderFields !== type;
      }
    }
  });

  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.matches("[data-image-source]")) {
      event.preventDefault();
      void sendForm(form, imageBody(form));
    } else if (form.matches("[data-git-url-source]")) {
      event.preventDefault();
      void sendForm(form, gitBody(form));
    } else if (form.matches("[data-upload-source]")) {
      event.preventDefault();
      if (!form.hasAttribute("data-busy")) upload(form);
    } else if (form.matches("[data-build-form]")) {
      event.preventDefault();
      void (async () => {
        clearErrors(form);
        const answer = await sendWith(form, "PUT", "build", buildBody(form));
        if (answer) {
          showToast("Build settings saved. They apply on the next deploy.", { tone: "success" });
          await refreshPage();
        }
      })();
    } else if (form.matches("[data-ports-form]")) {
      event.preventDefault();
      if (!form.hasAttribute("data-busy")) void savePorts(form);
    } else if (form.matches("[data-mounts-form]")) {
      event.preventDefault();
      if (!form.hasAttribute("data-busy")) void saveMounts(form);
    }
  });
}
