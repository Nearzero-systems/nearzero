import type { APIRoute } from "astro";
import { consoleData } from "../../../lib/data/index.ts";
import { finishConnect, param } from "../../../lib/git-callbacks.ts";

// GitHub created the person's app from the manifest (spec 16.2): finish it, then install it.
export const GET: APIRoute = (context) =>
  finishConnect(context, async () => {
    const created = await consoleData(context).completeGithubManifest(
      param(context, "code"),
      param(context, "state"),
    );
    return { redirect: created.installUrl, external: true };
  });
