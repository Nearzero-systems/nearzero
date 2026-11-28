import { type CookieContext, isSecureRequest } from "./secure-cookie.ts";

/**
 * One-shot messages carried across a redirect after a form post ("Project created"). They ride in
 * a short-lived cookie that the next page reads and clears, and appear there as toasts.
 */

export const FLASH_COOKIE = "nz_flash";

export type FlashTone = "info" | "success" | "error";
export interface FlashMessage {
  message: string;
  tone: FlashTone;
}

export function setFlash(context: CookieContext, message: string, tone: FlashTone = "success") {
  context.cookies.set(FLASH_COOKIE, JSON.stringify([{ message, tone }]), {
    path: "/",
    sameSite: "lax",
    httpOnly: true,
    secure: isSecureRequest(context),
    maxAge: 60,
  });
}

export function parseFlash(raw: string | undefined): FlashMessage[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (item): item is FlashMessage =>
          typeof item === "object" &&
          item !== null &&
          typeof item.message === "string" &&
          ["info", "success", "error"].includes(item.tone),
      )
      .slice(0, 3)
      .map((item) => ({ message: item.message.slice(0, 300), tone: item.tone }));
  } catch {
    return [];
  }
}
