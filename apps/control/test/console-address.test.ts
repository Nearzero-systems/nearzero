import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { silentLogger } from "../src/log.ts";
import { HOST_TARGET } from "../src/runners/hub.ts";
import { createServices } from "../src/services.ts";
import { createHarness, type Harness } from "./support/harness.ts";

/**
 * 30a R1-01: the console sends plain-HTTP visits to the server's IP address to the HTTPS
 * address the control plane names here, only once that address can answer.
 */

setDefaultTimeout(120_000);

let h: Harness;

beforeAll(async () => {
  h = await createHarness({ consoleUrl: "http://203.0.113.10:4321" });
});

afterAll(async () => {
  await h.drop();
});

async function ask(consoleUrl: string | null) {
  const services = createServices({ db: h.test.db, log: silentLogger, consoleUrl });
  const app = createApp({ db: h.test.db, log: silentLogger, services });
  const response = await app.request("/api/v1/auth/console-address");
  expect(response.status).toBe(200);
  return ((await response.json()) as { httpsUrl: string | null }).httpsUrl;
}

describe("the console's HTTPS address (R1-01)", () => {
  test("an https:// console address is used as set, without anyone signed in", async () => {
    expect(await ask("https://console.example.com/")).toBe("https://console.example.com");
  });

  test("no HTTPS address: nothing to move to", async () => {
    expect(await ask("http://203.0.113.10:4321")).toBeNull();
    expect(await ask(null)).toBeNull();
  });

  test("a public domain set under About Nearzero counts once its certificate is valid", async () => {
    await h.test.db
      .insertInto("address_setting")
      .values({ key: "console_hostname", value: "nz.example.com" })
      .execute();
    expect(await ask("http://203.0.113.10:4321")).toBeNull();
    const status = (notAfter: number) =>
      JSON.stringify({
        readable: true,
        error: null,
        certificates: [
          { names: ["nz.example.com"], notBefore: 0, notAfter, issuer: "Let's Encrypt" },
        ],
        uploaded: [],
        attempts: [],
        holds: [],
        backoff: [],
        checkedAt: Date.now(),
      });
    await h.test.db
      .insertInto("certificate_snapshot")
      .values({ target: HOST_TARGET, status: status(Date.now() - 1000), error: null })
      .execute();
    expect(await ask("http://203.0.113.10:4321")).toBeNull();
    await h.test.db
      .updateTable("certificate_snapshot")
      .set({ status: status(Date.now() + 86_400_000) })
      .execute();
    expect(await ask("http://203.0.113.10:4321")).toBe("https://nz.example.com");
  });
});
