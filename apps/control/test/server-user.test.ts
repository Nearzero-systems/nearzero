import { describe, expect, test } from "bun:test";
import { runnerEnvironmentLines } from "../src/server-setup/scripts.ts";

/** 30c R3-28: setup tells the runner which user the server was set up with. */

describe("the runner's settings name the setup user (R3-28)", () => {
  test("a server set up as ubuntu runs its tasks as ubuntu", () => {
    const lines = runnerEnvironmentLines({
      controlUrl: "https://nearzero.example.com",
      routerImage: null,
      acmeEmail: null,
      serverUser: "ubuntu",
      extra: {},
    });
    expect(lines).toContain("NEARZERO_SERVER_USER='ubuntu'");
  });

  test("without a user, the runner works it out (the router folder's owner)", () => {
    const lines = runnerEnvironmentLines({
      controlUrl: "https://nearzero.example.com",
      routerImage: null,
      acmeEmail: null,
      extra: {},
    });
    expect(lines.some((line) => line.startsWith("NEARZERO_SERVER_USER="))).toBe(false);
  });
});
