import { defineMiddleware } from "astro:middleware";
import { API_PREFIX } from "@nearzero/shared";
import { connectionOf } from "./lib/control-api.ts";
import { FLASH_COOKIE, parseFlash } from "./lib/flash.ts";
import {
  controlLegacyLookup,
  forwardLegacyWebhook,
  legacyWebhookGet,
} from "./lib/legacy-lookup.ts";
import { legacyObjectTarget, legacyPublicTarget } from "./lib/legacy-paths.ts";
import { signInPath } from "./lib/next-step.ts";
import { consoleHttpsAddress, httpsTarget, mayMoveToHttps } from "./lib/plain-http.ts";

type Context = Parameters<Parameters<typeof defineMiddleware>[0]>[0];
type Next = Parameters<Parameters<typeof defineMiddleware>[0]>[1];

function peerOf(context: Context): string | undefined {
  try {
    return context.clientAddress;
  } catch {
    return undefined;
  }
}

/** A plain-HTTP visit to the server's IP address, sent to the HTTPS address (spec 04 4.1). */
async function movedToHttps(context: Context): Promise<string | null> {
  const { request } = context;
  const movable = mayMoveToHttps({
    method: request.method,
    url: context.url,
    host: request.headers.get("host"),
    scheme: connectionOf(request, peerOf(context)).scheme,
  });
  return movable ? httpsTarget(context.url, await consoleHttpsAddress()) : null;
}

async function page(context: Context, next: Next): Promise<Response> {
  const secure = await movedToHttps(context);
  if (secure) return context.redirect(secure, 302);

  // Old sign-in, registration and invitation addresses (spec 29.5), with their query (a token).
  const moved = legacyPublicTarget(context.url.pathname, context.url.search);
  if (moved) return context.redirect(moved, 301);

  context.locals.flash = parseFlash(context.cookies.get(FLASH_COOKIE)?.value);

  const response = await next();
  // A message is used up by the page that shows it, not by one that only redirects ("/", a
  // workspace's old address), so "Invitation declined." reaches the page after "/" (C3-07).
  const redirected = response.status >= 300 && response.status < 400;
  if (context.locals.flash.length > 0 && !redirected) {
    context.cookies.delete(FLASH_COOKIE, { path: "/" });
  }
  // Pages hold per-person data and the saved theme: never let a shared cache keep them.
  if (response.headers.get("content-type")?.startsWith("text/html")) {
    response.headers.set("cache-control", "no-store");
  }
  return response;
}

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url;
  if (pathname.startsWith(`${API_PREFIX}/`)) return next();
  const method = context.request.method;

  // A POST no page takes may be a 0.1.x webhook address a move kept (spec 29.5): the control
  // plane answers it like 1.0's own. The copy is taken before anything reads the body.
  if (method === "POST") {
    const copy = context.request.clone();
    const response = pathname.startsWith("/api/") ? await next() : await page(context, next);
    if (response.status !== 404) {
      await copy.body?.cancel();
      return response;
    }
    return forwardLegacyWebhook(copy, peerOf(context));
  }

  const response = pathname.startsWith("/api/") ? await next() : await page(context, next);
  // A GET to a 0.1.x webhook address a move kept says to use POST (31d G4-17).
  if (
    response.status === 404 &&
    (method === "GET" || method === "HEAD") &&
    !pathname.startsWith("/_astro/")
  ) {
    const webhook = await legacyWebhookGet(context.request, peerOf(context));
    if (webhook) return webhook;
  }
  if (pathname.startsWith("/api/")) return response;
  // An address no page takes may be where 0.1.x showed a project, service, deployment or server
  // (spec 29a.9.1): its 1.0 page opens instead, after sign-in when signed out.
  if (response.status === 404 && method === "GET" && !pathname.startsWith("/_astro/")) {
    const target = await legacyObjectTarget(pathname, controlLegacyLookup(context));
    if (target?.kind === "redirect") return context.redirect(target.to, 301);
    if (target?.kind === "sign-in") {
      return context.redirect(signInPath(`${pathname}${context.url.search}`), 302);
    }
  }
  return response;
});
