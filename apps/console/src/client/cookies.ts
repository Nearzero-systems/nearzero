/**
 * Writes a cookie for this console. The Cookie Store API exists only in secure contexts, and a
 * fresh install is served over plain HTTP (spec 21.9), so the classic `document.cookie` is the
 * one way that always works.
 */
export function writeCookie(name: string, value: string, maxAgeSeconds = 400 * 86_400): void {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    "SameSite=Lax",
  ];
  if (location.protocol === "https:") parts.push("Secure");
  // biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API needs HTTPS (see above).
  document.cookie = parts.join("; ");
}
