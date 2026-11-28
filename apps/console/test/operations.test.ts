import { describe, expect, test } from "bun:test";
import type { HostnameEntry } from "../src/lib/data/operations-types.ts";
import { deploymentsQuery, pageHref } from "../src/lib/deployments-page.ts";
import {
  bellStatus,
  confirmText,
  deploymentPill,
  durationLabel,
  headerActions,
  liveAtFromLog,
  liveUrl,
} from "../src/lib/deploys.ts";
import {
  canvasHostname,
  checkedAtLabel,
  chooseDomainsTab,
  dnsPill,
  httpsPill,
  httpsStepMessage,
  parseHostnameFilter,
  READINESS,
  serviceLine,
  visibleTabs,
  WIZARD_HTTPS_TRIES,
  wizardDnsLabel,
} from "../src/lib/domains.ts";
import {
  appSource,
  checkMountRows,
  checkPortRows,
  deploySettings,
  logsUrl,
  mountRows,
  portRows,
  sizeLabel,
} from "../src/lib/runtime-rules.ts";
import { bridgedPath, upstreamHeaders, upstreamUrl } from "../src/lib/socket-bridge.ts";

const app = (status: string, extra: Partial<Parameters<typeof headerActions>[0]> = {}) => ({
  kind: "application",
  status,
  can: { deploy: true },
  ...extra,
});

describe("the service header's actions (spec 6.2, 7.2, 8.2)", () => {
  test("apps: Deploy first, then Redeploy; Reload and Stop while running; Start when stopped", () => {
    const plain = { redeploy: false, busy: false };
    expect(headerActions(app("idle"))).toEqual({
      primary: "deploy",
      runtime: [],
      terminal: false,
      ...plain,
    });
    expect(headerActions(app("running"))).toEqual({
      primary: "redeploy",
      runtime: ["reload", "stop"],
      terminal: true,
      ...plain,
    });
    expect(headerActions(app("stopped"))).toEqual({
      primary: "redeploy",
      runtime: ["start"],
      terminal: false,
      ...plain,
    });
    expect(headerActions(app("failed")).runtime).toEqual(["stop"]);
  });

  test("nothing but Cancel while deploying, and nothing without deploy rights", () => {
    expect(headerActions(app("deploying"))).toEqual({
      primary: null,
      runtime: [],
      terminal: false,
      redeploy: false,
      busy: false,
    });
    expect(
      headerActions(app("running", { deploy: { inProgress: { id: "d", status: "queued" } } }))
        .primary,
    ).toBeNull();
    expect(headerActions(app("running", { can: { deploy: false } }))).toEqual({
      primary: null,
      runtime: [],
      terminal: false,
      redeploy: false,
      busy: false,
    });
  });

  test("databases: Deploy only when stopped, failed or never deployed; Stop and Terminal when running; Reload is for apps (B3-22)", () => {
    // A running database shows no Deploy: one click would stop it first (spec 8.2).
    expect(headerActions({ kind: "postgres", status: "running", can: { deploy: true } })).toEqual({
      primary: null,
      runtime: ["stop"],
      terminal: true,
      redeploy: false,
      busy: false,
    });
    for (const status of ["failed", "stopped", "idle"]) {
      expect(headerActions({ kind: "postgres", status, can: { deploy: true } }).primary).toBe(
        "deploy",
      );
    }
    expect(
      headerActions({ kind: "postgres", status: "stopped", can: { deploy: true } }).runtime,
    ).toEqual(["start"]);
    expect(
      headerActions({ kind: "compose", status: "running", can: { deploy: true } }).runtime,
    ).toEqual(["stop"]);
  });

  test("Compose: Deploy and Reload (redeploy), disabled while deploying; Stacks have no Start (spec 7.2)", () => {
    const compose = (status: string, format: "compose" | "stack" = "compose", inProgress = false) =>
      headerActions({
        kind: "compose",
        status,
        format,
        can: { deploy: true },
        deploy: { inProgress: inProgress ? { id: "d" } : null },
      });
    expect(compose("idle")).toMatchObject({ primary: "deploy", redeploy: false, busy: false });
    expect(compose("running")).toEqual({
      primary: "deploy",
      runtime: ["stop"],
      terminal: true,
      redeploy: true,
      busy: false,
    });
    expect(compose("stopped").runtime).toEqual(["start"]);
    expect(compose("stopped", "stack").runtime).toEqual([]);
    expect(compose("running", "compose", true)).toEqual({
      primary: "deploy",
      runtime: [],
      terminal: false,
      redeploy: true,
      busy: true,
    });
  });

  test("a database's Redeploy says it stops first", () => {
    expect(confirmText("redeploy", { name: "db", kind: "postgres" }, "production")).toBe(
      "Redeploy db in production? It stops for a moment while the new container starts on the same data.",
    );
    expect(confirmText("redeploy", { name: "stack", kind: "compose" }, "production")).toBe(
      "Redeploy stack in production?",
    );
  });

  test("every action asks first, in the spec's words for a rebuild", () => {
    expect(confirmText("redeploy", { name: "web", kind: "application" }, "production")).toBe(
      "Rebuild application",
    );
    expect(confirmText("deploy", { name: "db", kind: "postgres" }, "staging")).toBe(
      "Deploy db in staging?",
    );
    expect(confirmText("cancel", { name: "web", kind: "application" }, "x")).toContain(
      "keeps serving",
    );
  });
});

describe("deployments (spec 11)", () => {
  test('durations, with "so far" while building', () => {
    expect(durationLabel(4_200, false)).toBe("4s");
    expect(durationLabel(72_000, true)).toBe("1m 12s so far");
    expect(durationLabel(3_725_000, false)).toBe("1h 2m");
    expect(durationLabel(null, false)).toBe("—");
  });

  test("pills: Failed everywhere, and the bell's four words", () => {
    expect(deploymentPill("failed")).toBe("fail");
    expect(deploymentPill("active")).toBe("ok");
    expect(deploymentPill("building")).toBe("run");
    expect(bellStatus("failed")).toEqual({ pill: "fail", label: "Failed" });
    expect(bellStatus("building").label).toBe("Running");
    expect(bellStatus("previous").label).toBe("Deployed");
    expect(bellStatus("cancelled").label).toBe("Cancelled");
  });

  test("the address keeps the filters, leaving defaults out", () => {
    const query = deploymentsQuery(
      new URLSearchParams("q=web&status=failed&type=nope&pageSize=7&page=3"),
    );
    expect(query).toEqual({ search: "web", status: "failed", type: "all", pageSize: 50, page: 3 });
    expect(pageHref("/a/dashboard/deployments", query, 4)).toBe(
      "/a/dashboard/deployments?q=web&status=failed&page=4",
    );
    expect(pageHref("/a/dashboard/deployments", { pageSize: 25 }, 1)).toBe(
      "/a/dashboard/deployments?pageSize=25",
    );
  });

  test("the live address comes from the closing log line, else the first connected hostname", () => {
    expect(
      liveAtFromLog(
        "…\nDeployment complete. It's live at: https://a.example.com, https://b.example.com\n",
      ),
    ).toBe("https://a.example.com");
    expect(liveAtFromLog("Deployment complete. This app has no domain yet")).toBeNull();
    expect(
      liveUrl([
        { url: "https://x", service: null },
        { url: "https://y", service: {} },
      ]),
    ).toBe("https://y");
  });
});

describe("runtime settings (spec 6.3, 6.6, 6.8)", () => {
  test("sources and deploy settings read from the API's public settings", () => {
    const source = appSource({
      source: {
        type: "image",
        image: "nginx:alpine",
        registry: { address: "ghcr.io", username: "me", passwordSet: true },
      },
    });
    expect(source.type).toBe("image");
    expect(source.registry?.passwordSet).toBe(true);
    expect(appSource({ source: null }).type).toBeNull();
    expect(
      appSource({
        source: { type: "git", url: "https://h/o/r", branch: "main", watchPaths: ["src/**"] },
      }).watchPaths,
    ).toEqual(["src/**"]);
    expect(
      deploySettings({ deploy: { autodeploy: true, cleanCache: false, stabilitySeconds: 3 } }),
    ).toEqual({
      autodeploy: true,
      cleanCache: false,
      stabilitySeconds: 3,
    });
  });

  test("ports: numbers from 1 to 65535, each published port once per protocol", () => {
    expect(
      portRows({
        ports: [{ containerPort: 53, publishedPort: 5353, protocol: "udp", mode: "host" }],
      }),
    ).toEqual([{ containerPort: 53, publishedPort: 5353, protocol: "udp", mode: "host" }]);
    expect(
      checkPortRows([
        { containerPort: "8080", publishedPort: "0", protocol: "tcp", mode: "routed" },
      ]),
    ).toEqual({
      problem: "Enter ports from 1 to 65535.",
      row: 1,
    });
    expect(
      checkPortRows([
        { containerPort: "1", publishedPort: "9000", protocol: "tcp", mode: "routed" },
        { containerPort: "2", publishedPort: "9000", protocol: "tcp", mode: "routed" },
      ]),
    ).toEqual({ problem: "Port 9000/TCP is listed twice. Keep one.", row: 2 });
    expect(
      checkPortRows([
        { containerPort: "1", publishedPort: "9000", protocol: "tcp", mode: "routed" },
        { containerPort: "2", publishedPort: "9000", protocol: "udp", mode: "host" },
      ]),
    ).toEqual({
      ports: [
        { containerPort: 1, publishedPort: 9000, protocol: "tcp", mode: "routed" },
        { containerPort: 2, publishedPort: 9000, protocol: "udp", mode: "host" },
      ],
    });
  });

  test("mounts: paths, volume names, and a saved file mount keeps its content when left empty", () => {
    expect(
      mountRows({ mounts: [{ type: "file", id: "m1", containerPath: "/etc/app.conf" }] }),
    ).toEqual([{ type: "file", id: "m1", containerPath: "/etc/app.conf" }]);
    const row = {
      id: "",
      name: "",
      hostPath: "",
      containerPath: "/data",
      readOnly: false,
      content: "",
    };
    expect(checkMountRows([{ ...row, type: "volume", name: "Data!" }])).toMatchObject({ row: 1 });
    expect(
      checkMountRows([{ ...row, type: "volume", containerPath: "data", name: "data" }]),
    ).toMatchObject({ row: 1 });
    expect(checkMountRows([{ ...row, type: "bind", hostPath: "/srv/../etc" }])).toMatchObject({
      row: 1,
    });
    expect(checkMountRows([{ ...row, type: "file" }])).toEqual({
      problem: "Enter the file's content.",
      row: 1,
    });
    expect(checkMountRows([{ ...row, type: "file", id: "m1" }])).toEqual({
      mounts: [{ type: "file", id: "m1", containerPath: "/data" }],
    });
    expect(checkMountRows([{ ...row, type: "volume", name: "data" }])).toEqual({
      mounts: [{ type: "volume", id: undefined, name: "data", containerPath: "/data" }],
    });
  });

  test("the Logs tab's stream address", () => {
    expect(
      logsUrl("s 1", { tail: "500", since: "", search: " error ", follow: false, container: "c1" }),
    ).toBe("/api/v1/services/s%201/logs?tail=500&search=error&follow=0&container=c1");
    expect(
      logsUrl("s", { tail: "9999", since: "not a date", search: "", follow: true, container: "" }),
    ).toBe("/api/v1/services/s/logs?tail=100&follow=1");
    expect(sizeLabel(12_582_912)).toBe("12.0 MB");
  });
});

const entry = (patch: Partial<HostnameEntry>): HostnameEntry =>
  ({
    id: "h1",
    hostname: "app.example.com",
    url: "https://app.example.com",
    source: "own",
    sourceLabel: "Your DNS provider",
    zone: null,
    automatic: false,
    service: {
      id: "s",
      name: "web",
      kind: "application",
      projectId: "p",
      projectName: "shop",
      environmentId: "e",
      environmentName: "production",
      composeService: null,
      port: 3000,
      path: "/",
    },
    target: { id: "host", name: "Nearzero host", host: true, address: "203.0.113.10" },
    dns: {
      status: "no_record",
      label: "No record",
      note: "",
      addresses: [],
      checkedAt: null,
      managed: false,
      record: {
        type: "A",
        name: "app",
        value: "203.0.113.10",
        ttl: "Auto or 300",
        proxy: "DNS only",
      },
    },
    https: {
      state: "waiting_for_dns",
      label: "Waiting for DNS",
      note: "…",
      until: null,
      lastError: null,
      retryRefusal: null,
      certificate: null,
    },
    needsAttention: false,
    waiting: true,
    can: { manage: true, move: true, retry: false },
    createdAt: "2026-11-25T00:00:00.000Z",
    ...patch,
  }) as HostnameEntry;

describe("domains (spec 10)", () => {
  test("tabs: hidden ones stay reachable by address", () => {
    expect(chooseDomainsTab("dns-zones")).toBe("dns-zones");
    expect(chooseDomainsTab("nope")).toBe("hostnames");
    const tabs = [
      { id: "hostnames" as const, label: "Hostnames", count: 1, shown: true },
      { id: "dns-zones" as const, label: "DNS zones", count: 0, shown: false },
    ];
    expect(visibleTabs(tabs, "hostnames").map((tab) => tab.id)).toEqual(["hostnames"]);
    expect(visibleTabs(tabs, "dns-zones").map((tab) => tab.id)).toEqual(["hostnames", "dns-zones"]);
    expect(parseHostnameFilter("attention")).toBe("attention");
    expect(parseHostnameFilter("x")).toBe("all");
  });

  test("pills and the Service column", () => {
    expect(dnsPill("points_here")).toBe("ok");
    expect(dnsPill("points_elsewhere")).toBe("fail");
    expect(httpsPill("valid")).toBe("ok");
    expect(httpsPill("paused")).toBe("warn");
    expect(READINESS.inactive.label).toBe("Inactive");
    expect(serviceLine(entry({}))).toBe("shop / production · Nearzero host");
    expect(serviceLine(entry({ service: null }))).toBe("Not connected");
    expect(checkedAtLabel(null)).toBe("Not checked yet");
    expect(checkedAtLabel("2026-11-25T09:05:00.000Z")).toBe("Checked at 09:05");
  });

  test("the canvas's domain card names the record while DNS isn't ready", () => {
    expect(canvasHostname(entry({}))).toEqual({
      host: "app.example.com",
      state: "needs-dns",
      record: { name: "app", value: "203.0.113.10" },
    });
    expect(canvasHostname(entry({ dns: { ...entry({}).dns, status: "points_here" } })).state).toBe(
      "live",
    );
    expect(canvasHostname(entry({ dns: { ...entry({}).dns, status: "unknown" } })).state).toBe(
      "checking",
    );
  });

  test("the wizard's DNS and HTTPS words", () => {
    expect(wizardDnsLabel("proxied", "Cloudflare")).toBe("Proxied by Cloudflare");
    expect(wizardDnsLabel("lookup_failed")).toBe("Couldn't look up DNS");
    expect(wizardDnsLabel("no_record", null, false)).toBe("Server address unknown");
    expect(httpsStepMessage(entry({ service: null }), 1).message).toContain("Connect a service");
    const valid = entry({ https: { ...entry({}).https, state: "valid", label: "Valid" } });
    expect(httpsStepMessage(valid, 1)).toEqual({
      done: true,
      message: "HTTPS is ready. Open https://app.example.com",
    });
    expect(httpsStepMessage(entry({}), WIZARD_HTTPS_TRIES).message).toContain(
      "Still working on it.",
    );
    expect(httpsStepMessage(entry({}), 2).done).toBe(false);
  });
});

describe("terminals through the console (spec 6.7)", () => {
  test("only API paths are bridged, never the runner's own link", () => {
    expect(bridgedPath("/api/v1/services/s/terminal?shell=sh")).toBe(true);
    expect(bridgedPath("/api/v1/runner/connect")).toBe(false);
    expect(bridgedPath("/_vite/hmr")).toBe(false);
    expect(bridgedPath(undefined)).toBe(false);
  });

  test("the control plane's fixed address, as ws:// or wss://", () => {
    expect(
      upstreamUrl("/api/v1/services/s/terminal?cols=80", new URL("http://127.0.0.1:3000")),
    ).toBe("ws://127.0.0.1:3000/api/v1/services/s/terminal?cols=80");
    expect(upstreamUrl("/api/v1/x", new URL("https://control.internal"))).toBe(
      "wss://control.internal/api/v1/x",
    );
  });

  test("cookies pass; forwarded headers from the browser are replaced by the console's own", () => {
    const headers = upstreamHeaders({
      headers: { cookie: "nz_session=abc", "x-forwarded-for": "6.6.6.6", host: "console" },
      peer: "198.51.100.7",
      encrypted: false,
    });
    expect(headers.cookie).toBe("nz_session=abc");
    expect(headers["x-forwarded-for"]).toBe("198.51.100.7");
    expect(headers["x-forwarded-proto"]).toBe("http");
    expect(headers.host).toBeUndefined();
    expect(headers["x-request-id"]).toMatch(/^req_/);
  });
});
