import { navigate } from "astro:transitions/client";
import { liveAtFromLog } from "../lib/deploys.ts";
import { callApi } from "./api.ts";
import { openDeployLog } from "./deploy-log.ts";
import { deploy, rememberLiveAt } from "./deploys.ts";
import { showToast } from "./toasts.ts";

/**
 * Create & deploy on the new-application page (spec 6.1): the forms give way to the build panel,
 * whose title follows the deploy (Queued → Building → "Deployment complete. It's live at: <url>"
 * with Copy and Visit, or "Deployment failed"), with the build log. "Open service" goes to the
 * new service, whose page then shows the "Live at" banner once.
 */

function setTitle(panel: HTMLElement, text: string): void {
  for (const slot of panel.querySelectorAll<HTMLElement>("[data-log-state]"))
    slot.textContent = text;
}

function setMessage(panel: HTMLElement, text: string): void {
  const slot = panel.querySelector<HTMLElement>("[data-build-message]");
  if (slot) slot.textContent = text;
}

async function liveUrl(serviceId: string, log: HTMLElement): Promise<string | null> {
  const fromLog = liveAtFromLog(log.textContent ?? "");
  if (fromLog) return fromLog;
  try {
    const answer = await callApi<{ hostnames: { url: string; service: unknown }[] }>(
      "GET",
      `/services/${encodeURIComponent(serviceId)}/hostnames`,
    );
    return answer.hostnames.find((item) => item.service !== null)?.url ?? null;
  } catch {
    return null;
  }
}

/**
 * Starts the first deploy of a service just created on this page and follows it in the panel.
 * Returns false when the page has no panel (the caller then opens the service as before).
 */
export async function followCreatedDeploy(
  serviceId: string,
  servicePage: string,
): Promise<boolean> {
  const page = document.querySelector<HTMLElement>("[data-new-app]");
  const panel = page?.querySelector<HTMLElement>("[data-build-panel]");
  if (!page || !panel) return false;
  const started = await deploy(serviceId);
  if (started.status !== "started") {
    showToast(started.message, { tone: "error", persist: true });
    await navigate(servicePage);
    return true;
  }
  for (const part of page.querySelectorAll<HTMLElement>(
    "[data-app-git], [data-app-image], [data-app-mode]",
  )) {
    part.hidden = true;
  }
  panel.hidden = false;
  const open = panel.querySelector<HTMLAnchorElement>("[data-build-open]");
  if (open) open.href = servicePage;
  setTitle(panel, started.waiting ? "Queued" : "Building");
  setMessage(panel, started.message);
  panel.scrollIntoView({ block: "start" });
  const log = panel.querySelector<HTMLElement>("[data-deploy-log]");
  if (!log) return true;
  panel.addEventListener("nz:deploy-status", (event) => {
    const detail = (event as CustomEvent<{ status: string; statusLabel: string }>).detail;
    setTitle(panel, detail.statusLabel);
    if (detail.status === "building") setMessage(panel, "Building and starting the new container.");
  });
  panel.addEventListener(
    "nz:deploy-end",
    (event) => {
      const detail = (event as CustomEvent<{ status: string; error: string | null }>).detail;
      panel.querySelector<HTMLElement>("[data-build-spinner]")?.setAttribute("hidden", "");
      if (detail.status === "active") {
        setTitle(panel, "Deployment complete");
        void liveUrl(serviceId, log).then((url) => {
          if (!url) {
            setMessage(
              panel,
              "Deployment complete. This app has no domain yet, so it isn't reachable from the internet. Add one from its page.",
            );
            return;
          }
          setMessage(panel, "Deployment complete. It's live at:");
          const row = panel.querySelector<HTMLElement>("[data-build-url]");
          const text = panel.querySelector<HTMLElement>("[data-build-url-text]");
          const visit = panel.querySelector<HTMLAnchorElement>("[data-build-visit]");
          if (text) text.textContent = url;
          if (visit) visit.href = url;
          for (const button of row?.querySelectorAll<HTMLElement>("[data-copy]") ?? [])
            button.dataset.copy = url;
          if (row) row.hidden = false;
          rememberLiveAt(serviceId, url);
        });
      } else {
        setTitle(
          panel,
          detail.status === "cancelled" ? "Deployment cancelled" : "Deployment failed",
        );
        setMessage(panel, detail.error ?? "The deployment failed. The build log says why.");
      }
    },
    { once: true },
  );
  openDeployLog(log, started.deploymentId, { live: true });
  return true;
}
