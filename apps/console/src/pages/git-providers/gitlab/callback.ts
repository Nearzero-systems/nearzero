import type { APIRoute } from "astro";
import { consoleData } from "../../../lib/data/index.ts";
import { finishConnect, param } from "../../../lib/git-callbacks.ts";

// The OAuth redirect URI shown in the GitLab dialog (spec 16.3): the code becomes tokens.
export const GET: APIRoute = (context) =>
  finishConnect(context, async () => {
    const done = await consoleData(context).completeOAuth({
      kind: "gitlab",
      code: param(context, "code"),
      state: param(context, "state"),
      error: param(context, "error") || null,
    });
    return { redirect: done.returnTo ?? "", message: done.message };
  });
