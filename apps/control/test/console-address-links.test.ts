import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { runCommand } from "../src/cli/commands.ts";
import { HOST_TARGET } from "../src/runners/hub.ts";
import { webhookUrl } from "../src/webhooks/tokens.ts";
import { createHarness, fakeIo, type Harness } from "./support/harness.ts";

/**
 * The console's hostname saved under About Nearzero (G4-20, G4-21): generated links (webhook
 * URLs, invitation and notification links, OAuth redirects) use it once its certificate is valid,
 * without the installer running again; and the installer can read it, so a rerun doesn't ask for
 * a domain or set another one.
 */

setDefaultTimeout(120_000);

let h: Harness;

beforeAll(async () => {
  h = await createHarness({ consoleUrl: "http://203.0.113.10:4321" });
});

afterAll(async () => {
  await h.drop();
});

const status = (notAfter: number) =>
  JSON.stringify({
    readable: true,
    error: null,
    certificates: [{ names: ["nz.example.com"], notBefore: 0, notAfter, issuer: "R11" }],
    uploaded: [],
    attempts: [],
    holds: [],
    backoff: [],
    checkedAt: Date.now(),
  });

describe("generated links follow the saved hostname once it serves HTTPS (G4-21)", () => {
  test("the webhook address moves to https://<hostname> without a rerun, and back when it lapses", async () => {
    expect(webhookUrl(h.services, "tok")).toBe(
      "http://203.0.113.10:4321/api/v1/webhooks/deploy/tok",
    );
    await h.test.db
      .insertInto("address_setting")
      .values({ key: "console_hostname", value: "nz.example.com" })
      .execute();
    // Saved, but no certificate yet: the old address still works, so it stays.
    await h.services.refreshConsoleUrl();
    expect(h.services.consoleUrl()).toBe("http://203.0.113.10:4321");
    await h.test.db
      .insertInto("certificate_snapshot")
      .values({ target: HOST_TARGET, status: status(Date.now() + 86_400_000), error: null })
      .execute();
    expect(await h.services.refreshConsoleUrl()).toBe("https://nz.example.com");
    expect(webhookUrl(h.services, "tok")).toBe("https://nz.example.com/api/v1/webhooks/deploy/tok");
    // The certificate lapses: back to the address the install set.
    await h.test.db
      .updateTable("certificate_snapshot")
      .set({ status: status(Date.now() - 1000) })
      .execute();
    expect(await h.services.refreshConsoleUrl()).toBe("http://203.0.113.10:4321");
  });
});

describe("the installer reads the saved hostname (G4-20)", () => {
  test("console-hostname --json answers it, or null", async () => {
    const io = fakeIo([]);
    expect(await runCommand(["console-hostname", "--json"], h.services, io)).toBe(0);
    expect(JSON.parse(io.output.at(-1) ?? "")).toEqual({ hostname: "nz.example.com" });
    await h.test.db.deleteFrom("address_setting").execute();
    const none = fakeIo([]);
    await runCommand(["console-hostname", "--json"], h.services, none);
    expect(JSON.parse(none.output.at(-1) ?? "")).toEqual({ hostname: null });
  });
});

describe("0.1.x's PUBLIC_GIT_PROVIDER_BASE_URL (G4-19)", () => {
  test("Git callbacks and webhook addresses use it; other links keep the console's", async () => {
    const { createServices } = await import("../src/services.ts");
    const { silentLogger } = await import("../src/log.ts");
    const { consoleAddress } = await import("../src/git-providers/records.ts");
    const services = createServices({
      db: h.test.db,
      log: silentLogger,
      consoleUrl: "https://console.example.com",
      gitPublicUrl: "https://git-hooks.example.com",
    });
    expect(webhookUrl(services, "tok")).toBe(
      "https://git-hooks.example.com/api/v1/webhooks/deploy/tok",
    );
    expect(consoleAddress(services, "/api/v1/git-providers/gitlab/callback")).toBe(
      "https://git-hooks.example.com/api/v1/git-providers/gitlab/callback",
    );
    expect(services.consoleUrl()).toBe("https://console.example.com");
    services.runners.stop();
  });
});
