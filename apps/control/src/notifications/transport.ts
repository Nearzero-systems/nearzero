import type { ControlServices } from "../services.ts";
import { defaultTransport, type NotificationTransport } from "./senders.ts";

/**
 * How this process reaches notification providers: the install's outbound HTTP call and SMTP,
 * with Telegram, Pushover and Resend at their public addresses. Tests swap in local fakes, and
 * shorter retry delays, with {@link setNotificationTransport}.
 */

export interface DispatchSettings {
  transport: NotificationTransport;
  /** Delays before the 1st, 2nd and 3rd retry of a failed delivery (spec 15.3). */
  retryDelaysMs: readonly number[];
}

export const DEFAULT_RETRY_DELAYS_MS = [15_000, 60_000, 240_000] as const;

const settings = new WeakMap<ControlServices, DispatchSettings>();

export function dispatchSettingsOf(services: ControlServices): DispatchSettings {
  let found = settings.get(services);
  if (!found) {
    found = { transport: defaultTransport(services.http), retryDelaysMs: DEFAULT_RETRY_DELAYS_MS };
    settings.set(services, found);
  }
  return found;
}

export function transportOf(services: ControlServices): NotificationTransport {
  return dispatchSettingsOf(services).transport;
}

export function setNotificationTransport(
  services: ControlServices,
  next: Partial<NotificationTransport> & { retryDelaysMs?: readonly number[] },
): void {
  const current = dispatchSettingsOf(services);
  const { retryDelaysMs, ...transport } = next;
  settings.set(services, {
    transport: { ...current.transport, ...transport },
    retryDelaysMs: retryDelaysMs ?? current.retryDelaysMs,
  });
}
