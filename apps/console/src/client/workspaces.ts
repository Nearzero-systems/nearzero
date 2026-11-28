import { navigate } from "astro:transitions/client";
import { pathAfterWorkspace } from "../lib/routes.ts";
import { asApiError, callApi, showErrors } from "./api.ts";
import { showToast } from "./toasts.ts";

/**
 * After Rename workspace the address follows the new slug (spec 4.4), on the same page; after
 * Add workspace the person switches into it and lands on its Agent.
 */

interface WorkspaceAnswer {
  workspace?: { id: string; slug: string; name: string };
}

export function initWorkspaceDialogs(): void {
  document.addEventListener("nz:api-success", async (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const then = form.dataset.apiThen;
    if (then !== "workspace" && then !== "new-workspace") return;
    const workspace = (event as CustomEvent<WorkspaceAnswer>).detail?.workspace;
    if (!workspace) return;
    if (then === "workspace") {
      form.closest("dialog")?.close();
      // The switcher's dialogs keep 0.1.79's word, "Organization" (21.10, 31a G1-10).
      showToast("Organization renamed", { tone: "success" });
      const rest = pathAfterWorkspace(location.pathname);
      await navigate(`/${encodeURIComponent(workspace.slug)}/dashboard${rest}${location.search}`, {
        history: "replace",
      });
      return;
    }
    try {
      await callApi("POST", `/workspaces/${encodeURIComponent(workspace.id)}/switch`);
      form.closest("dialog")?.close();
      showToast("Organization created", { tone: "success" });
      await navigate(`/${encodeURIComponent(workspace.slug)}/dashboard/agent`);
    } catch (error) {
      showErrors(form, asApiError(error));
    }
  });
}
