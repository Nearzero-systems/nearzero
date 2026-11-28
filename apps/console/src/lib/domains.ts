import type {
  DnsStatus,
  DomainsTab,
  HostnameEntry,
  HttpsState,
  Readiness,
} from "./data/operations-types.ts";
import type { HostnameView } from "./data/types.ts";

/**
 * Wording and small rules for the Domains page, a service's Add domain dialog, the Servers page
 * and the canvas's domain cards (spec 9.1, 10). Pure, so the unit tests cover them.
 */

export type Pill = "ok" | "run" | "warn" | "fail" | "idle";

export function dnsPill(status: DnsStatus | string): Pill {
  switch (status) {
    case "points_here":
      return "ok";
    case "waiting":
    case "check_records":
      return "run";
    case "no_record":
    case "proxied":
    case "ipv6_only":
      return "warn";
    case "points_elsewhere":
    case "lookup_failed":
      return "fail";
    default:
      return "idle";
  }
}

export function httpsPill(state: HttpsState | string): Pill {
  switch (state) {
    case "valid":
    case "uploaded":
      return "ok";
    case "queued":
    case "issuing":
    case "waiting_for_dns":
      return "run";
    case "expires_soon":
    case "rate_limited":
    case "paused":
    case "not_trusted":
      return "warn";
    case "expired":
    case "failed":
      return "fail";
    default:
      return "idle";
  }
}

export function badgePill(badge: string): Pill {
  if (badge === "points_here") return "ok";
  if (badge === "points_elsewhere") return "fail";
  if (badge === "not_set_up" || badge === "not_added") return "warn";
  return "idle";
}

export const READINESS: Record<Readiness, { pill: Pill; label: string }> = {
  ready: { pill: "ok", label: "Ready" },
  setup_needed: { pill: "idle", label: "Setup Needed" },
  setup_running: { pill: "run", label: "Setup running" },
  setup_failed: { pill: "fail", label: "Setup failed" },
  inactive: { pill: "idle", label: "Inactive" },
};

export const READINESS_FILTERS: { value: string; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "ready", label: "Ready" },
  { value: "setup_needed", label: "Setup Needed" },
  { value: "setup_running", label: "Setup running" },
  { value: "setup_failed", label: "Setup failed" },
  { value: "inactive", label: "Inactive" },
];

export const HOSTNAME_FILTERS = [
  { value: "all", label: "All hostnames" },
  { value: "attention", label: "Needs attention" },
  { value: "waiting", label: "Waiting for DNS" },
  { value: "unconnected", label: "Not connected" },
] as const;

export function parseHostnameFilter(
  value: string | null,
): (typeof HOSTNAME_FILTERS)[number]["value"] {
  return HOSTNAME_FILTERS.some((item) => item.value === value)
    ? (value as (typeof HOSTNAME_FILTERS)[number]["value"])
    : "all";
}

export const DOMAINS_TAB_IDS = [
  "hostnames",
  "dns-zones",
  "environment-defaults",
  "uploaded-certificates",
] as const;
export type DomainsTabId = (typeof DOMAINS_TAB_IDS)[number];

/** The tab in the address; hidden tabs stay reachable by address (spec 10.3). */
export function chooseDomainsTab(value: string | null): DomainsTabId {
  return (DOMAINS_TAB_IDS as readonly string[]).includes(value ?? "")
    ? (value as DomainsTabId)
    : "hostnames";
}

/** Tabs shown in the row: the API's `shown`, plus the one being viewed. */
export function visibleTabs(tabs: DomainsTab[], current: DomainsTabId): DomainsTab[] {
  return tabs.filter((tab) => tab.shown || tab.id === current);
}

/** "Checked at HH:MM" in the viewer's clock (the page renders UTC; the browser corrects it). */
export function checkedAtLabel(iso: string | null): string {
  if (!iso) return "Not checked yet";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Not checked yet";
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `Checked at ${hh}:${mm}`;
}

/** The Service column's words (spec 10.4). */
export function serviceLine(entry: Pick<HostnameEntry, "service" | "target">): string {
  if (!entry.service) return "Not connected";
  return `${entry.service.projectName} / ${entry.service.environmentName} · ${entry.target.name}`;
}

/** A DNS record split for phones: name, then type and value, then the copy buttons. */
export function recordLines(record: { type: string; name: string; value: string | null }): {
  name: string;
  typeAndValue: string;
} {
  return {
    name: record.name,
    typeAndValue: `${record.type} ${record.value ?? "(server address unknown)"}`,
  };
}

/** The Add domain wizard's steps (spec 10.5). */
export const WIZARD_STEPS = ["hostname", "service", "dns", "https"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];
export const WIZARD_STEP_LABELS: Record<WizardStep, string> = {
  hostname: "Hostname",
  service: "Service",
  dns: "DNS",
  https: "HTTPS",
};

/** How often the wizard checks DNS and HTTPS, and how many times HTTPS is followed. */
export const WIZARD_CHECK_MS = 8000;
export const WIZARD_HTTPS_TRIES = 20;

/** What the HTTPS step says from a hostname's state (spec 10.5 step 4). */
export function httpsStepMessage(
  entry: Pick<HostnameEntry, "hostname" | "https" | "service">,
  tries: number,
): { done: boolean; message: string } {
  if (!entry.service) {
    return {
      done: true,
      message: `Added ${entry.hostname}. Connect a service to it from the Hostnames list when you're ready.`,
    };
  }
  if (entry.https.state === "valid" || entry.https.state === "uploaded") {
    return { done: true, message: `HTTPS is ready. Open https://${entry.hostname}` };
  }
  if (tries >= WIZARD_HTTPS_TRIES) {
    return {
      done: true,
      message:
        "Still working on it. You can close this; the Hostnames list shows when HTTPS is ready.",
    };
  }
  return { done: false, message: `${entry.https.label}: ${entry.https.note}` };
}

/** The wizard's live DNS status words (spec 10.5 step 3). */
export function wizardDnsLabel(
  status: string,
  proxiedBy: string | null = null,
  addressKnown = true,
): string {
  if (!addressKnown) return "Server address unknown";
  switch (status) {
    case "points_here":
      return "Points here";
    case "points_elsewhere":
      return "Points somewhere else";
    case "proxied":
      return proxiedBy ? `Proxied by ${proxiedBy}` : "Proxied";
    case "ipv6_only":
      return "Only an IPv6 record";
    case "lookup_failed":
      return "Couldn't look up DNS";
    default:
      return "Waiting for DNS";
  }
}

/** DNS records' types the records dialog offers (spec 10.8). */
export const RECORD_TYPES = ["A", "AAAA", "CNAME", "TXT", "MX", "CAA", "NS"] as const;

/** A hostname as the canvas's domain card draws it (spec 5.2). */
export function canvasHostname(entry: HostnameEntry): HostnameView {
  if (entry.dns.status === "points_here" || entry.dns.status === "check_records") {
    return { host: entry.hostname, state: "live" };
  }
  if (entry.dns.record && entry.dns.status !== "unknown") {
    return {
      host: entry.hostname,
      state: "needs-dns",
      record: { name: entry.dns.record.name, value: entry.dns.record.value ?? "the server's IPv4" },
    };
  }
  return { host: entry.hostname, state: "checking" };
}
