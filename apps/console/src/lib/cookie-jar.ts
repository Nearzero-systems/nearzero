/**
 * Cookies the console passes between the browser and the control plane when a page talks to the
 * API on the browser's behalf: the browser's Cookie header goes up, and the API's Set-Cookie
 * answers (the session, a two-factor challenge) come back down unchanged in meaning.
 */

export interface SetCookie {
  name: string;
  /** As sent (percent-encoded the way the API wrote it). */
  value: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax" | "strict" | "none" | undefined;
  maxAge: number | undefined;
  expires: Date | undefined;
  /** True when the cookie is being cleared (Max-Age 0 or an expiry in the past). */
  cleared: boolean;
}

/** "a=1; b=2" → Map { a → "1", b → "2" }, values left encoded. */
export function parseCookieHeader(header: string | null | undefined): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    if (name && !jar.has(name)) jar.set(name, part.slice(index + 1).trim());
  }
  return jar;
}

export function cookieHeader(jar: Map<string, string>): string {
  return Array.from(jar, ([name, value]) => `${name}=${value}`).join("; ");
}

export function parseSetCookie(line: string, now: Date = new Date()): SetCookie | null {
  const [pair = "", ...attributes] = line.split(";");
  const index = pair.indexOf("=");
  if (index <= 0) return null;
  const cookie: SetCookie = {
    name: pair.slice(0, index).trim(),
    value: pair.slice(index + 1).trim(),
    path: "/",
    httpOnly: false,
    secure: false,
    sameSite: undefined,
    maxAge: undefined,
    expires: undefined,
    cleared: false,
  };
  for (const attribute of attributes) {
    const [rawKey = "", ...rest] = attribute.split("=");
    const key = rawKey.trim().toLowerCase();
    const value = rest.join("=").trim();
    if (key === "path" && value) cookie.path = value;
    else if (key === "httponly") cookie.httpOnly = true;
    else if (key === "secure") cookie.secure = true;
    else if (key === "samesite") {
      const lower = value.toLowerCase();
      if (lower === "lax" || lower === "strict" || lower === "none") cookie.sameSite = lower;
    } else if (key === "max-age" && /^-?\d+$/.test(value)) cookie.maxAge = Number(value);
    else if (key === "expires") {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) cookie.expires = date;
    }
  }
  cookie.cleared =
    (cookie.maxAge !== undefined && cookie.maxAge <= 0) ||
    (cookie.maxAge === undefined &&
      cookie.expires !== undefined &&
      cookie.expires.getTime() <= now.getTime());
  return cookie;
}

/** Decodes a cookie value the way the API encoded it; a malformed one is kept as is. */
export function decodeCookieValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
