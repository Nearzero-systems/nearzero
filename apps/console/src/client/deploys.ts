import { navigate } from "astro:transitions/client";
import type { DeployStart } from "../lib/data/types.ts";
import { RUNTIME_ACTION_DONE, type RuntimeAction, startDeploy } from "../lib/deploys.ts";
import { asApiError, callApi, refreshPage } from "./api.ts";
import { openDeployLog } from "./deploy-log.ts";
import { openDialog } from "./dialogs.ts";
import { showToast } from "./toasts.ts";

/**
 * Deploys and the service header's actions in the browser (spec 06 6.2, 07 7.2, 08 8.2, 11.2).
 * Deploying goes through the same `startDeploy` as the pages' data layer (lib/deploys.ts).
 *
 * - `data-service-action="deploy|redeploy|start|stop|reload"` with `data-service-id` and
 *   `data-confirm-text`, or `data-service-action="cancel|redeploy-deployment"` with
 *   `data-deployment-id`: "Confirm action" first, then the call, then a toast that names the
 *   action (errors stay until dismissed) and the page refreshes or follows the new deploy.
 * - `data-deploy="<service id>"` deploys at once (inside dialogs that already asked).
 * - A form with `data-deploy-on-save="<service id>"` deploys after it saved ("Save & deploy").
 * - `[data-deploy-watch]` (a service page while a deploy runs) follows that deploy and refreshes
 *   the page when it ends.
 * - The "Live at" banner (`[data-live-at]`) shows once after the creation page or Create URL.
 */

const LIVE_AT_KEY = "nz.liveAt.";

export function deploy(serviceId: string, redeploy = false): Promise<DeployStart> {
  return startDeploy(
    <T>(method: string, path: string, body?: unknown) => callApi<T>(method, path, body),
    serviceId,
    { redeploy },
  );
}

export async function deployAndTell(serviceId: string, redeploy = false): Promise<DeployStart> {
  const result = await deploy(serviceId, redeploy);
  if (result.status === "started") showToast(result.message, { tone: "success" });
  else showToast(result.message, { tone: "error", persist: true });
  return result;
}

/** Remembers an address for the service page's "Live at" banner (shown once). */
export function rememberLiveAt(serviceId: string, url: string): void {
  try {
    sessionStorage.setItem(`${LIVE_AT_KEY}${serviceId}`, url);
  } catch {
    // Without storage the banner just isn't shown; the address is on the page anyway.
  }
}

function takeLiveAt(serviceId: string): string | null {
  try {
    const key = `${LIVE_AT_KEY}${serviceId}`;
    const url = sessionStorage.getItem(key);
    sessionStorage.removeItem(key);
    return url;
  } catch {
    return null;
  }
}

function showLiveAt(): void {
  for (const banner of document.querySelectorAll<HTMLElement>("[data-live-at]")) {
    const url = takeLiveAt(banner.dataset.liveAt ?? "");
    if (!url) continue;
    const text = banner.querySelector<HTMLElement>("[data-live-at-url]");
    if (text) text.textContent = url;
    for (const button of banner.querySelectorAll<HTMLElement>("[data-copy]")) {
      button.dataset.copy = url;
    }
    const visit = banner.querySelector<HTMLAnchorElement>("[data-live-at-visit]");
    if (visit) visit.href = url;
    banner.hidden = false;
  }
}

async function runtime(serviceId: string, action: RuntimeAction): Promise<boolean> {
  try {
    const answer = await callApi<{ message?: string }>(
      "POST",
      `/services/${encodeURIComponent(serviceId)}/${action}`,
    );
    showToast(answer.message ?? RUNTIME_ACTION_DONE[action], { tone: "success" });
    return true;
  } catch (error) {
    showToast(asApiError(error).message, { tone: "error", persist: true });
    return false;
  }
}

async function cancelDeployment(deploymentId: string): Promise<boolean> {
  try {
    const answer = await callApi<{ message: string }>(
      "POST",
      `/deployments/${encodeURIComponent(deploymentId)}/cancel`,
    );
    showToast(answer.message || "Deployment cancelled", { tone: "success" });
    return true;
  } catch (error) {
    showToast(asApiError(error).message, { tone: "error", persist: true });
    return false;
  }
}

/** Redeploy from a deployment (spec 11.2): "Redeployment queued", then open the new one. */
async function redeployDeployment(deploymentId: string, opener: HTMLElement): Promise<void> {
  const label = opener.textContent;
  opener.setAttribute("aria-disabled", "true");
  opener.textContent = "Redeploying";
  try {
    const answer = await callApi<{ deployment: { id: string }; message: string }>(
      "POST",
      `/deployments/${encodeURIComponent(deploymentId)}/redeploy`,
    );
    showToast(answer.message || "Redeployment queued", { tone: "success" });
    opener.textContent = "Waiting for logs";
    const base = opener.dataset.deploymentBase;
    if (base) {
      await navigate(`${base}${encodeURIComponent(answer.deployment.id)}`);
      return;
    }
    await refreshPage();
  } catch (error) {
    showToast(asApiError(error).message, { tone: "error", persist: true });
  } finally {
    opener.removeAttribute("aria-disabled");
    opener.textContent = label;
  }
}

async function run(opener: HTMLElement): Promise<void> {
  const action = opener.dataset.serviceAction ?? "";
  const serviceId = opener.dataset.serviceId ?? "";
  if (action === "deploy" || action === "redeploy") {
    const result = await deployAndTell(serviceId, action === "redeploy");
    if (result.status === "started") await refreshPage();
  } else if (action === "start" || action === "stop" || action === "reload") {
    if (await runtime(serviceId, action)) await refreshPage();
  } else if (action === "cancel") {
    if (await cancelDeployment(opener.dataset.deploymentId ?? "")) await refreshPage();
  } else if (action === "redeploy-deployment") {
    await redeployDeployment(opener.dataset.deploymentId ?? "", opener);
  } else if (action === "make-public" || action === "make-private") {
    // Make public / Make private (spec 8.2): the API restarts a deployed database by itself.
    try {
      const answer = await callApi<{ message: string }>(
        "POST",
        `/services/${encodeURIComponent(serviceId)}/public`,
        { public: action === "make-public" },
      );
      showToast(answer.message || (action === "make-public" ? "Made public" : "Made private"), {
        tone: "success",
      });
      await refreshPage();
    } catch (error) {
      showToast(asApiError(error).message, { tone: "error", persist: true });
    }
  }
}

let pending: HTMLElement | null = null;

function ask(opener: HTMLElement): void {
  const dialog = document.querySelector<HTMLDialogElement>("#nz-confirm-action");
  if (!dialog) {
    void run(opener);
    return;
  }
  const text = dialog.querySelector<HTMLElement>("[data-confirm-action-text]");
  if (text) text.textContent = opener.dataset.confirmText ?? "";
  const go = dialog.querySelector<HTMLElement>("[data-confirm-action-go]");
  if (go) {
    go.textContent = opener.dataset.confirmLabel ?? "Confirm";
    go.className = `nz-btn ${opener.dataset.confirmDanger === "true" ? "nz-btn--danger" : "nz-btn--primary"}`;
  }
  pending = opener;
  openDialog(dialog, opener);
}

/** Follows the deploy a service page shows as running, and refreshes the page when it ends. */
function watchDeploys(): void {
  for (const watch of document.querySelectorAll<HTMLElement>("[data-deploy-watch]")) {
    const log = watch.querySelector<HTMLElement>("[data-deploy-log]") ?? watch;
    if (log.dataset.deployLog) openDeployLog(log);
    watch.addEventListener(
      "nz:deploy-end",
      (event) => {
        const detail = (event as CustomEvent<{ status: string; error: string | null }>).detail;
        if (detail.status === "failed") {
          showToast(detail.error ?? "The deployment failed. Its log says why.", {
            tone: "error",
            persist: true,
          });
        } else if (detail.status === "active" || detail.status === "not_running") {
          showToast("Deployment complete", { tone: "success" });
        }
        window.setTimeout(() => void refreshPage(), 600);
      },
      { once: true },
    );
  }
}

export function initDeployButtons(): void {
  // "Save & deploy" (spec 06 6.3): a saved form that names a service starts its deploy.
  document.addEventListener("nz:api-success", (event) => {
    const form = event.target as HTMLElement | null;
    const serviceId = form?.dataset?.deployOnSave;
    if (serviceId) void deployAndTell(serviceId);
  });

  document.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    const go = target?.closest<HTMLElement>("[data-confirm-action-go]");
    if (go) {
      event.preventDefault();
      go.closest("dialog")?.close();
      const opener = pending;
      pending = null;
      if (opener) void run(opener);
      else if (go.dataset.deploy) void deployAndTell(go.dataset.deploy);
      return;
    }
    const action = target?.closest<HTMLElement>("[data-service-action]");
    if (action) {
      event.preventDefault();
      if (action.getAttribute("aria-disabled") === "true") return;
      action.closest<HTMLElement>("[popover]")?.hidePopover();
      if (action.dataset.noConfirm === "true") void run(action);
      else ask(action);
      return;
    }
    const button = target?.closest<HTMLElement>("[data-deploy]");
    if (!button) return;
    event.preventDefault();
    button.closest<HTMLElement>("[popover]")?.hidePopover();
    button.closest("dialog")?.close();
    void deployAndTell(button.dataset.deploy ?? "");
  });

  document.addEventListener("astro:page-load", () => {
    showLiveAt();
    watchDeploys();
  });
}
