import { describe, expect, test } from "bun:test";
import {
  CONTROL_DEFAULTS,
  IGNORED_LEGACY_SETTINGS,
  ignoredLegacySettings,
  LEGACY_SETTING_ALIASES,
  MISSING_PRODUCTION_SECRET,
  parseControlConfig,
  withLegacySettingNames,
} from "../src/config.ts";

const DATABASE_URL = "postgres://nearzero:s3cr3t-pass@127.0.0.1:5432/nearzero";
const SECRET = "4f1c9a0be27d83c6a5f04e19b7d2c8a3e6f5b1d09c4a7e2f8b3d6c1a5e9f0b47";

function problemsOf(env: Record<string, string | undefined>): string[] {
  const result = parseControlConfig(env);
  if (result.ok) throw new Error("expected the configuration to be refused");
  return result.problems;
}

describe("control configuration", () => {
  test("production with a generated secret starts with defaults", () => {
    const result = parseControlConfig({ DATABASE_URL, NEARZERO_AUTH_SECRET: SECRET });
    expect(result).toEqual({
      ok: true,
      config: {
        mode: "production",
        databaseUrl: DATABASE_URL,
        authSecret: SECRET,
        http: { hostname: CONTROL_DEFAULTS.bindAddress, port: CONTROL_DEFAULTS.port },
        logLevel: "info",
        jobs: {
          concurrency: CONTROL_DEFAULTS.jobConcurrency,
          deployConcurrency: CONTROL_DEFAULTS.deployConcurrency,
          buildsPerServer: CONTROL_DEFAULTS.buildsPerServer,
          pollIntervalMs: CONTROL_DEFAULTS.jobPollIntervalMs,
        },
        databaseWaitSeconds: 120,
        consoleUrl: null,
        trustedProxies: ["127.0.0.1", "::1", "::ffff:127.0.0.1"],
        instanceEmail: null,
        instanceEmailProblem: null,
        publicIp: null,
        gitPublicUrl: null,
        runner: { handoffDirectory: null, controlUrl: null, ignoredControlUrl: null, link: null },
        domains: {
          platformDomain: null,
          managementHostname: null,
          managedZone: null,
          managedZoneEmail: null,
          acmeEmail: null,
          sharedEdge: false,
          resolvers: ["1.1.1.1", "8.8.8.8"],
        },
        legacySettings: {
          registrationMode: "bootstrap",
          trustedOrigins: [],
          metricsRetentionDays: null,
          metricsRefreshSeconds: null,
        },
        ssh: { strictHostKeyChecking: false, runnerBinariesDirectory: null },
      },
    });
  });

  test("domain settings: a leading *. is dropped, resolvers are listed", () => {
    const result = parseControlConfig({
      DATABASE_URL,
      NEARZERO_AUTH_SECRET: SECRET,
      NEARZERO_PLATFORM_DOMAIN: "*.Apps.Example.com",
      NEARZERO_DNS_RESOLVERS: "10.0.0.2:5353, 9.9.9.9",
      NEARZERO_ADMIN_EMAIL: "owner@example.com",
    });
    if (!result.ok) throw new Error(result.problems.join("; "));
    expect(result.config.domains).toMatchObject({
      platformDomain: "apps.example.com",
      managedZoneEmail: "owner@example.com",
      resolvers: ["10.0.0.2:5353", "9.9.9.9"],
    });
    expect(
      problemsOf({ DATABASE_URL, NEARZERO_AUTH_SECRET: SECRET, NEARZERO_PLATFORM_DOMAIN: "x" }),
    ).toEqual([
      'NEARZERO_PLATFORM_DOMAIN must be a domain name, like apps.example.com; it is "x".',
    ]);
  });

  test("production is the default mode, so a missing secret is refused", () => {
    expect(problemsOf({ DATABASE_URL })).toEqual([MISSING_PRODUCTION_SECRET]);
    expect(
      problemsOf({ DATABASE_URL, NEARZERO_ENV: "production", NEARZERO_AUTH_SECRET: "  " }),
    ).toEqual([MISSING_PRODUCTION_SECRET]);
  });

  test("development and test may run without a secret", () => {
    for (const mode of ["development", "test"]) {
      const result = parseControlConfig({ DATABASE_URL, NEARZERO_ENV: mode });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.config.authSecret).toBeNull();
    }
  });

  test("hand-written or short secrets are refused in every mode", () => {
    const short = problemsOf({
      DATABASE_URL,
      NEARZERO_ENV: "development",
      NEARZERO_AUTH_SECRET: "abc",
    });
    expect(short).toHaveLength(1);
    expect(short[0]).toContain("too short (3 characters)");

    const typed = problemsOf({
      DATABASE_URL,
      NEARZERO_AUTH_SECRET: "changemechangemechangemechangeme",
    });
    expect(typed).toEqual([expect.stringContaining("doesn't look randomly generated")]);
  });

  test("reads ports, bind address, log level and job settings", () => {
    const result = parseControlConfig({
      DATABASE_URL,
      NEARZERO_ENV: "development",
      NEARZERO_CONTROL_PORT: "4100",
      NEARZERO_MANAGEMENT_BIND_ADDRESS: "127.0.0.1",
      NEARZERO_LOG_LEVEL: "debug",
      NEARZERO_JOB_CONCURRENCY: "2",
      NEARZERO_DEPLOY_CONCURRENCY: "3",
      NEARZERO_BUILDS_PER_SERVER: "2",
      NEARZERO_JOB_POLL_INTERVAL_MS: "250",
      NEARZERO_DATABASE_WAIT_SECONDS: "30",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.http).toEqual({ hostname: "127.0.0.1", port: 4100 });
    expect(result.config.logLevel).toBe("debug");
    expect(result.config.jobs).toEqual({
      concurrency: 2,
      deployConcurrency: 3,
      buildsPerServer: 2,
      pollIntervalMs: 250,
    });
    expect(result.config.databaseWaitSeconds).toBe(30);
  });

  test("reports every problem at once, each naming the variable", () => {
    const problems = problemsOf({
      NEARZERO_ENV: "staging",
      DATABASE_URL: "mysql://root@localhost/app",
      NEARZERO_CONTROL_PORT: "70000",
      NEARZERO_LOG_LEVEL: "loud",
      NEARZERO_JOB_CONCURRENCY: "two",
    });
    expect(problems).toHaveLength(5);
    expect(problems.join("\n")).toContain(
      'NEARZERO_ENV must be one of "production", "development", "test"',
    );
    expect(problems.join("\n")).toContain(
      "DATABASE_URL must start with postgres:// or postgresql://",
    );
    expect(problems.join("\n")).toContain(
      "NEARZERO_CONTROL_PORT must be a whole number from 1 to 65535",
    );
    expect(problems.join("\n")).toContain("NEARZERO_LOG_LEVEL must be one of");
    expect(problems.join("\n")).toContain(
      "NEARZERO_JOB_CONCURRENCY must be a whole number from 1 to 64",
    );
  });

  test("the missing secret is reported alongside other problems", () => {
    const problems = problemsOf({ NEARZERO_CONTROL_PORT: "abc" });
    expect(problems).toContain(MISSING_PRODUCTION_SECRET);
    expect(problems.some((p) => p.startsWith("DATABASE_URL is not set"))).toBe(true);
  });

  test("a bad database address is explained without repeating its password", () => {
    for (const url of [
      "not a url s3cr3t",
      "postgres://user:s3cr3t@/",
      "postgres://user:s3cr3t@db",
    ]) {
      const problems = problemsOf({ DATABASE_URL: url, NEARZERO_ENV: "development" });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toStartWith("DATABASE_URL");
      expect(problems[0]).not.toContain("s3cr3t");
    }
  });

  test("a secret is never repeated in a message", () => {
    const secret = "short-but-secret";
    const problems = problemsOf({ DATABASE_URL, NEARZERO_AUTH_SECRET: secret });
    expect(problems.join(" ")).not.toContain(secret);
  });

  test("G3-01, C2-07, C2-09: servers never get a plain address; the encrypted link's settings", () => {
    const base = { DATABASE_URL, NEARZERO_AUTH_SECRET: SECRET };
    const runner = (env: Record<string, string>) => {
      const result = parseControlConfig({ ...base, ...env });
      if (!result.ok) throw new Error(result.problems.join("\n"));
      return result.config.runner;
    };
    expect(runner({}).controlUrl).toBeNull();
    // No plain address is ever derived: not the API's port (B2-04 gave http://<ip>:3000), not a
    // console address set outright (C2-09), not the console's port.
    const plainOnes: Record<string, string>[] = [
      { NEARZERO_PUBLIC_IP: "203.0.113.9" },
      { NEARZERO_PUBLIC_IP: "203.0.113.9", NEARZERO_CONSOLE_URL: "http://203.0.113.9:4321" },
      { CONSOLE_URL: "http://203.0.113.9:4321" },
      { PUBLIC_BACKEND_URL: "http://203.0.113.9:4321" },
      { NEARZERO_PUBLIC_IP: "203.0.113.9", NEARZERO_MANAGEMENT_HOSTNAME: "nz.example.com" },
    ];
    for (const env of plainOnes) {
      expect(runner(env).controlUrl).toBeNull();
    }
    expect(runner({ NEARZERO_RUNNER_CONTROL_URL: "https://runners.example.com" }).controlUrl).toBe(
      "https://runners.example.com",
    );
    // A plain address set outright is ignored, and named so the start log can say so.
    const plain = runner({ NEARZERO_RUNNER_CONTROL_URL: "http://203.0.113.9:3000" });
    expect(plain.controlUrl).toBeNull();
    expect(plain.ignoredControlUrl).toBe("http://203.0.113.9:3000");
    // C4-03: an https:// IP address set outright has no fingerprint to check it by, and runners
    // check no IP address against a certificate, so it is ignored and named too.
    for (const address of ["https://203.0.113.9:8443", "https://[2001:db8::9]"]) {
      const ip = runner({ NEARZERO_RUNNER_CONTROL_URL: address });
      expect(ip.controlUrl).toBeNull();
      expect(ip.ignoredControlUrl).toBe(new URL(address).origin);
    }
    // The runner link's own TLS port: on when its certificate folder is set (compose.yml).
    expect(runner({}).link).toBeNull();
    expect(runner({ NEARZERO_RUNNER_TLS_DIR: "/var/lib/nearzero/runner-link" }).link).toEqual({
      tlsDirectory: "/var/lib/nearzero/runner-link",
      port: 3443,
      listenPort: 3443,
      bindAddress: "0.0.0.0",
    });
    expect(
      runner({
        NEARZERO_RUNNER_TLS_DIR: "/srv/link",
        NEARZERO_RUNNER_LINK_PORT: "5443",
        NEARZERO_MANAGEMENT_BIND_ADDRESS: "127.0.0.1",
      }).link,
    ).toEqual({ tlsDirectory: "/srv/link", port: 5443, listenPort: 3443, bindAddress: "0.0.0.0" });
    expect(problemsOf({ ...base, NEARZERO_RUNNER_TLS_DIR: "relative" })).toEqual([
      'NEARZERO_RUNNER_TLS_DIR must be an absolute folder path without spaces; it is "relative".',
    ]);
  });

  test("the console address: set outright, else from the management hostname, else the public IP", () => {
    const base = { DATABASE_URL, NEARZERO_AUTH_SECRET: SECRET };
    const url = (env: Record<string, string>) => {
      const result = parseControlConfig({ ...base, ...env });
      if (!result.ok) throw new Error(result.problems.join("\n"));
      return result.config.consoleUrl;
    };
    expect(url({})).toBeNull();
    expect(url({ NEARZERO_PUBLIC_IP: "203.0.113.9" })).toBe("http://203.0.113.9:4321");
    expect(
      url({ NEARZERO_PUBLIC_IP: "203.0.113.9", NEARZERO_MANAGEMENT_HOSTNAME: "Nz.Example.com" }),
    ).toBe("https://nz.example.com");
    expect(url({ NEARZERO_CONSOLE_URL: "https://console.example.com/some/path" })).toBe(
      "https://console.example.com",
    );
    expect(problemsOf({ ...base, NEARZERO_CONSOLE_URL: "ftp://x" })).toEqual([
      "NEARZERO_CONSOLE_URL must start with https:// or http://.",
    ]);
  });

  test("trusted proxies default to loopback and take addresses and ranges", () => {
    const result = parseControlConfig({
      DATABASE_URL,
      NEARZERO_AUTH_SECRET: SECRET,
      NEARZERO_TRUSTED_PROXIES: "127.0.0.1, 10.0.0.0/8",
    });
    expect(result.ok && result.config.trustedProxies).toEqual(["127.0.0.1", "10.0.0.0/8"]);
    expect(
      problemsOf({
        DATABASE_URL,
        NEARZERO_AUTH_SECRET: SECRET,
        NEARZERO_TRUSTED_PROXIES: "proxy.local",
      })[0],
    ).toContain("NEARZERO_TRUSTED_PROXIES");
  });

  test("this server's email settings: Resend or SMTP, always with a sender", () => {
    const base = { DATABASE_URL, NEARZERO_AUTH_SECRET: SECRET };
    const resend = parseControlConfig({
      ...base,
      NEARZERO_EMAIL_FROM: "Nearzero <nz@example.com>",
      NEARZERO_RESEND_API_KEY: "re_123",
    });
    expect(resend.ok && resend.config.instanceEmail).toEqual({
      provider: "resend",
      from: "Nearzero <nz@example.com>",
      apiKey: "re_123",
    });
    const smtp = parseControlConfig({
      ...base,
      NEARZERO_EMAIL_FROM: "nz@example.com",
      NEARZERO_SMTP_URL: "smtps://mailer:p%40ss@smtp.example.com",
    });
    expect(smtp.ok && smtp.config.instanceEmail).toEqual({
      provider: "smtp",
      from: "nz@example.com",
      host: "smtp.example.com",
      port: 465,
      security: "tls",
      username: "mailer",
      password: "p@ss",
    });
    // Half-made settings leave the server without email and say why, but never stop the start
    // (30a R1-04).
    const keyOnly = parseControlConfig({ ...base, NEARZERO_RESEND_API_KEY: "re_123" });
    expect(keyOnly.ok).toBe(true);
    expect(keyOnly.ok && keyOnly.config.instanceEmail).toBeNull();
    expect(keyOnly.ok && keyOnly.config.instanceEmailProblem).toContain(
      "NEARZERO_EMAIL_FROM is not set",
    );
    const senderOnly = parseControlConfig({ ...base, NEARZERO_EMAIL_FROM: "a@b.co" });
    expect(senderOnly.ok && senderOnly.config.instanceEmailProblem).toContain(
      "neither NEARZERO_RESEND_API_KEY nor NEARZERO_SMTP_URL is",
    );
    const both = parseControlConfig({
      ...base,
      NEARZERO_EMAIL_FROM: "a@b.co",
      NEARZERO_RESEND_API_KEY: "re_1",
      NEARZERO_SMTP_URL: "smtp://h",
    });
    expect(both.ok && both.config.instanceEmailProblem).toContain("are both set");
    expect(both.ok && both.config.instanceEmail).toBeNull();
    expect(resend.ok && resend.config.instanceEmailProblem).toBeNull();
    // Secret values never appear in problems.
    const badSmtp = problemsOf({
      ...base,
      NEARZERO_EMAIL_FROM: "a@b.co",
      NEARZERO_SMTP_URL: "http://u:hunter2@h",
    });
    expect(badSmtp.join(" ")).not.toContain("hunter2");
  });
});

describe("0.1.x setting names (spec 03 3.5)", () => {
  const base = {
    NEARZERO_ENV: "development",
    DATABASE_URL: "postgres://nearzero:secret@localhost:5432/nearzero",
  };

  test("aliases fill the 1.0 setting they stand for; the 1.0 name wins", () => {
    expect(
      withLegacySettingNames({ CONSOLE_URL: "https://a.example.com" }).NEARZERO_CONSOLE_URL,
    ).toBe("https://a.example.com");
    expect(
      withLegacySettingNames({
        PUBLIC_BACKEND_URL: "https://b.example.com",
        NEARZERO_CONSOLE_URL: "https://c.example.com",
      }).NEARZERO_CONSOLE_URL,
    ).toBe("https://c.example.com");
    expect(withLegacySettingNames({ NEARZERO_PLATFORM_PORT: "3100" }).NEARZERO_API_PORT).toBe(
      "3100",
    );
    expect(withLegacySettingNames({ EXTERNAL_SERVICES: "true" }).NEARZERO_DATA_MODE).toBe(
      "external",
    );
    expect(
      withLegacySettingNames({ EXTERNAL_SERVICES: "false" }).NEARZERO_DATA_MODE,
    ).toBeUndefined();
    expect(LEGACY_SETTING_ALIASES.NEARZERO_NONINTERACTIVE).toBe("NEARZERO_UNATTENDED");
    expect(Object.keys(IGNORED_LEGACY_SETTINGS)).toContain("NEARZERO_METRICS_PORT");
  });

  test("G4-19: the router's, the auth address's and the Git address's 0.1.x names are read", () => {
    const env = withLegacySettingNames({
      TRAEFIK_IMAGE: "traefik:v3.6.17",
      TRAEFIK_PORT: "8080",
      TRAEFIK_SSL_PORT: "8443",
      BETTER_AUTH_URL: "https://auth.example.com",
      PUBLIC_GIT_PROVIDER_BASE_URL: "https://git-hooks.example.com",
    });
    expect(env.NEARZERO_ROUTER_IMAGE).toBe("traefik:v3.6.17");
    expect(env.NEARZERO_HTTP_PORT).toBe("8080");
    expect(env.NEARZERO_HTTPS_PORT).toBe("8443");
    expect(env.NEARZERO_CONSOLE_URL).toBe("https://auth.example.com");
    expect(env.NEARZERO_GIT_PUBLIC_URL).toBe("https://git-hooks.example.com");
    // BETTER_AUTH_URL counts only without NEARZERO_CONSOLE_URL and CONSOLE_URL.
    expect(
      withLegacySettingNames({
        CONSOLE_URL: "https://a.example.com",
        BETTER_AUTH_URL: "https://b.example.com",
      }).NEARZERO_CONSOLE_URL,
    ).toBe("https://a.example.com");
    const parsed = parseControlConfig({
      ...base,
      PUBLIC_GIT_PROVIDER_BASE_URL: "https://git-hooks.example.com/path",
    });
    expect(parsed.ok && parsed.config.gitPublicUrl).toBe("https://git-hooks.example.com");
    // Every other 0.1.x name is named as ignored, with why.
    expect(
      ignoredLegacySettings({
        NEARZERO_MONITORING_IMAGE: "x",
        JOBS_URL: "http://jobs",
        POSTGRES_DB: "nearzero",
        NEARZERO_MANAGEMENT_HOSTNAME: "kept.example.com",
      }),
    ).toEqual(["NEARZERO_MONITORING_IMAGE", "JOBS_URL", "POSTGRES_DB"]);
    for (const name of [
      "TRAEFIK_HTTP3_PORT",
      "NEARZERO_SCHEDULE_IMAGE",
      "TRAEFIK_SOCKET_PROXY_IMAGE",
      "NEARZERO_ALLOW_MONITORING_DOCKER_METADATA",
      "API_KEY",
      "POSTGRES_USER",
    ]) {
      expect(Object.keys(IGNORED_LEGACY_SETTINGS)).toContain(name);
    }
  });

  test("the control plane reads them: the console address by its old name, and the settings 0.1.x had", () => {
    const result = parseControlConfig({
      ...base,
      PUBLIC_BACKEND_URL: "https://old.example.com",
      NEARZERO_REGISTRATION_MODE: "open",
      NEARZERO_TRUSTED_ORIGINS: "https://a.example.com, http://203.0.113.7:4321/",
      NEARZERO_METRICS_RETENTION_DAYS: "30",
      NEARZERO_METRICS_REFRESH_SECONDS: "15",
      NEARZERO_METRICS_PORT: "9100",
      NEARZERO_METRICS_CRON: "*/5 * * * *",
    });
    if (!result.ok) throw new Error(result.problems.join("\n"));
    expect(result.config.consoleUrl).toBe("https://old.example.com");
    expect(result.config.legacySettings).toEqual({
      registrationMode: "bootstrap",
      trustedOrigins: ["https://a.example.com", "http://203.0.113.7:4321"],
      metricsRetentionDays: 30,
      metricsRefreshSeconds: 15,
    });
  });

  test("registration mode invite_only, as 0.1.x wrote it, means invite-only (30a R1-03)", () => {
    for (const value of ["invite_only", "INVITE_ONLY", "invite-only"]) {
      const result = parseControlConfig({ ...base, NEARZERO_REGISTRATION_MODE: value });
      if (!result.ok) throw new Error(result.problems.join("\n"));
      expect(result.config.legacySettings?.registrationMode).toBe("invite-only");
    }
  });

  test("0.1.x names for this server's email give the same email as 1.0's (30a R1-04)", () => {
    const resend = (env: Record<string, string>) => {
      const result = parseControlConfig({ ...base, ...env });
      if (!result.ok) throw new Error(result.problems.join("\n"));
      return result.config.instanceEmail;
    };
    const expected = {
      provider: "resend",
      from: "Nearzero <nz@example.com>",
      apiKey: "re_old",
    } as const;
    expect(
      resend({ RESEND_API_KEY: "re_old", RESEND_FROM_EMAIL: "Nearzero <nz@example.com>" }),
    ).toEqual(expected);
    expect(
      resend({ RESEND_API_KEY: "re_old", NEARZERO_AUTH_FROM_EMAIL: "Nearzero <nz@example.com>" }),
    ).toEqual(expected);
    expect(
      resend({
        NEARZERO_RESEND_API_KEY: "re_old",
        NEARZERO_AUTH_FROM_EMAIL: "Nearzero <nz@example.com>",
      }),
    ).toEqual(expected);
    // The 1.0 names win when both are set, and NEARZERO_AUTH_FROM_EMAIL before RESEND_FROM_EMAIL.
    expect(
      resend({
        RESEND_API_KEY: "re_old",
        NEARZERO_RESEND_API_KEY: "re_new",
        NEARZERO_AUTH_FROM_EMAIL: "auth@example.com",
        RESEND_FROM_EMAIL: "resend@example.com",
        NEARZERO_EMAIL_FROM: "new@example.com",
      }),
    ).toEqual({ provider: "resend", from: "new@example.com", apiKey: "re_new" });
    expect(
      resend({
        RESEND_API_KEY: "re_old",
        NEARZERO_AUTH_FROM_EMAIL: "auth@example.com",
        RESEND_FROM_EMAIL: "resend@example.com",
      }),
    ).toEqual({ provider: "resend", from: "auth@example.com", apiKey: "re_old" });
    // A half-made 0.1.x setup starts too, without server email.
    const half = parseControlConfig({ ...base, RESEND_API_KEY: "re_old" });
    expect(half.ok).toBe(true);
    expect(half.ok && half.config.instanceEmail).toBeNull();
  });

  test("bad values are refused, naming the setting", () => {
    const result = parseControlConfig({
      ...base,
      NEARZERO_REGISTRATION_MODE: "everyone",
      NEARZERO_TRUSTED_ORIGINS: "not an address",
      NEARZERO_METRICS_RETENTION_DAYS: "0",
      NEARZERO_METRICS_REFRESH_SECONDS: "fast",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join("\n")).toContain("NEARZERO_REGISTRATION_MODE");
    expect(result.problems.join("\n")).toContain("NEARZERO_TRUSTED_ORIGINS");
    expect(result.problems.join("\n")).toContain("NEARZERO_METRICS_RETENTION_DAYS");
    expect(result.problems.join("\n")).toContain("NEARZERO_METRICS_REFRESH_SECONDS");
  });
});
