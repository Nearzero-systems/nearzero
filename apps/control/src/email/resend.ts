import type { HttpFetch } from "../services.ts";
import type { DeliveryResult, OutgoingEmail } from "./transport.ts";

/** Sending through Resend's HTTP API. Never throws; the reason is written for people. */

const RESEND_URL = "https://api.resend.com/emails";
const TIMEOUT_MS = 10_000;

export async function sendWithResend(
  http: HttpFetch,
  apiKey: string,
  mail: OutgoingEmail & { from: string },
): Promise<DeliveryResult> {
  let response: Response;
  try {
    response = await http(RESEND_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: mail.from,
        to: [mail.to],
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return {
      sent: false,
      reason: "Resend couldn't be reached from this server. Check its internet connection.",
    };
  }
  if (response.ok) return { sent: true };
  if (response.status === 401 || response.status === 403) {
    return { sent: false, reason: "Resend rejected the API key. Check it and save it again." };
  }
  if (response.status === 429) {
    return {
      sent: false,
      reason: "Resend is limiting how fast this key sends. Try again in a minute.",
    };
  }
  if (response.status >= 500) {
    return {
      sent: false,
      reason: `Resend had a problem (HTTP ${response.status}). Try again later.`,
    };
  }
  let detail = "";
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === "string") detail = body.message.replace(/\s+/g, " ").slice(0, 200);
  } catch {
    // No readable reason; the status is enough.
  }
  return {
    sent: false,
    reason: detail
      ? `Resend refused the email: ${detail}`
      : `Resend refused the email (HTTP ${response.status}).`,
  };
}
