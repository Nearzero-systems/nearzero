import { API_PREFIX, newRequestId, REQUEST_ID_HEADER } from "@nearzero/shared";
import type { AstroCookies } from "astro";
import { apiErrorFrom, unreachableError } from "./api-error.ts";
import { connectionOf, controlUrl, firstByteTimeoutFor } from "./control-api.ts";
import {
  cookieHeader,
  decodeCookieValue,
  parseCookieHeader,
  parseSetCookie,
} from "./cookie-jar.ts";
import { forwardedHeaders } from "./forwarding.ts";

/**
 * How a page's server code calls the control plane for the browser that asked for the page
 * (spec 22.4, rule 5: one fixed internal address). It sends the browser's cookies and the
 * console's account of who the browser is (X-Forwarded-For, X-Forwarded-Proto), and passes the
 * API's Set-Cookie answers back to the browser through Astro's cookies, so a sign-in made while
 * rendering a page holds in the browser. One client lives for one request; it remembers GET
 * answers until something changes.
 */

export interface ControlRequestContext {
  request: Request;
  cookies: AstroCookies;
  /** The connecting peer, when the adapter can tell. */
  clientAddress?: string | undefined;
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export class ControlClient {
  private readonly jar: Map<string, string>;
  private readonly memo = new Map<string, Promise<unknown>>();

  constructor(private readonly context: ControlRequestContext) {
    this.jar = parseCookieHeader(context.request.headers.get("cookie"));
  }

  /** Whether the browser sent (or the API has since set) a cookie by this name. */
  hasCookie(name: string): boolean {
    return this.jar.has(name);
  }

  get<T>(path: string): Promise<T> {
    const cached = this.memo.get(path);
    if (cached) return cached as Promise<T>;
    const pending = this.send<T>("GET", path);
    this.memo.set(path, pending);
    pending.catch(() => this.memo.delete(path));
    return pending;
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.change<T>("POST", path, body);
  }

  put<T>(path: string, body?: unknown): Promise<T> {
    return this.change<T>("PUT", path, body);
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.change<T>("PATCH", path, body);
  }

  delete<T>(path: string): Promise<T> {
    return this.change<T>("DELETE", path);
  }

  private change<T>(method: Method, path: string, body?: unknown): Promise<T> {
    this.memo.clear();
    return this.send<T>(method, path, body);
  }

  private async send<T>(method: Method, path: string, body?: unknown): Promise<T> {
    const target = new URL(`${API_PREFIX}${path}`, controlUrl());
    const headers = new Headers({ accept: "application/json" });
    const cookie = cookieHeader(this.jar);
    if (cookie) headers.set("cookie", cookie);
    const agent = this.context.request.headers.get("user-agent");
    if (agent) headers.set("user-agent", agent);
    const connection = connectionOf(this.context.request, this.context.clientAddress);
    for (const [name, value] of Object.entries(forwardedHeaders(connection)))
      headers.set(name, value);
    headers.set(REQUEST_ID_HEADER, newRequestId());
    if (body !== undefined) headers.set("content-type", "application/json");

    let response: Response;
    try {
      response = await fetch(target, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(firstByteTimeoutFor(method, target.pathname)),
      });
    } catch {
      throw unreachableError();
    }
    this.takeCookies(response);
    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (!response.ok) throw apiErrorFrom(response.status, parsed);
    return parsed as T;
  }

  /** Applies the API's Set-Cookie answers to this request's jar and to the browser. */
  private takeCookies(response: Response): void {
    for (const line of response.headers.getSetCookie()) {
      const cookie = parseSetCookie(line);
      if (!cookie) continue;
      if (cookie.cleared) {
        this.jar.delete(cookie.name);
        this.context.cookies.delete(cookie.name, { path: cookie.path });
        continue;
      }
      this.jar.set(cookie.name, cookie.value);
      this.context.cookies.set(cookie.name, decodeCookieValue(cookie.value), {
        path: cookie.path,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: cookie.sameSite,
        ...(cookie.maxAge !== undefined ? { maxAge: cookie.maxAge } : {}),
        ...(cookie.maxAge === undefined && cookie.expires ? { expires: cookie.expires } : {}),
      });
    }
  }
}
