import type { APIRoute } from "astro";
import { consoleData } from "../../../lib/data/index.ts";
import { finishConnect, param } from "../../../lib/git-callbacks.ts";

// GitHub installed (or updated) the app (spec 16.2). A late install without its state still
// binds to the person's waiting app once GitHub confirms that app owns it.
export const GET: APIRoute = (context) =>
  finishConnect(context, async () => {
    const done = await consoleData(context).completeGithubInstall({
      installationId: param(context, "installation_id"),
      state: param(context, "state") || null,
      setupAction: param(context, "setup_action") || null,
    });
    return { redirect: done.returnTo ?? "", message: done.message };
  });
