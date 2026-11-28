import { asApiError, callApi } from "./api.ts";
import { showToast } from "./toasts.ts";

/**
 * About Nearzero's switches for instance administrators (spec 18.2, 24 G3, 9.4): which
 * workspaces may place services on the host, and the host's daily Docker cleanup.
 */
export function initAbout(): void {
  // The host's daily Docker cleanup (spec 9.4, 18.2), for instance administrators.
  document.addEventListener("change", (event) => {
    const input = event.target as HTMLInputElement | null;
    if (!input?.matches?.("[data-docker-cleanup]")) return;
    const enabled = input.checked;
    input.disabled = true;
    void callApi(
      "PUT",
      `/servers/${encodeURIComponent(input.dataset.dockerCleanup ?? "")}/docker-cleanup`,
      {
        enabled,
      },
    )
      .then(() =>
        showToast(enabled ? "Daily Docker cleanup is on" : "Daily Docker cleanup is off", {
          tone: "success",
        }),
      )
      .catch((error) => {
        input.checked = !enabled;
        showToast(asApiError(error).message, { tone: "error", persist: true });
      })
      .finally(() => {
        input.disabled = false;
      });
  });

  document.addEventListener("change", (event) => {
    const input = event.target as HTMLInputElement | null;
    if (!input?.matches?.("[data-host-allow]")) return;
    const workspaceId = input.dataset.hostAllow ?? "";
    const allowed = input.checked;
    input.disabled = true;
    void callApi("PUT", `/host/allowed-workspaces/${encodeURIComponent(workspaceId)}`, { allowed })
      .then(() => {
        const name =
          input.closest("label")?.querySelector(".nz-switch-label")?.textContent ?? "The workspace";
        showToast(
          allowed
            ? `${name} may deploy to the Nearzero host`
            : `${name} can't deploy to the Nearzero host any more`,
          {
            tone: "success",
          },
        );
      })
      .catch((error) => {
        input.checked = !allowed;
        showToast(asApiError(error).message, { tone: "error", persist: true });
      })
      .finally(() => {
        input.disabled = false;
      });
  });
}
