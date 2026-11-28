import { describe, expect, test } from "bun:test";
import { withLegacySettingNames } from "@nearzero/shared";
import { runnerEnvironmentLines } from "../src/server-setup/scripts.ts";
import { serverRunnerPins } from "../src/server-setup/settings.ts";

/**
 * 31d G4-18: the router image and the builder image pins given at install reach every server's
 * runner through setup, not only the Nearzero host's.
 */

const DIGEST = `sha256:${"ab".repeat(32)}`;

describe("install pins for every server (G4-18)", () => {
  test("the router image and digest-pinned builder images go into each server's runner settings", () => {
    const pins = serverRunnerPins(
      withLegacySettingNames({
        // 0.1.x's name for the router image counts too (G4-19).
        TRAEFIK_IMAGE: "registry.example.com/traefik:v3.6.17",
        NEARZERO_HEROKU_BUILDER_IMAGE: `heroku/builder@${DIGEST}`,
        NEARZERO_PAKETO_BUILDER_IMAGE: "paketobuildpacks/builder-jammy-full:latest",
        NEARZERO_STATIC_NGINX_IMAGE: `nginx@${DIGEST}`,
      }),
    );
    expect(pins.routerImage).toBe("registry.example.com/traefik:v3.6.17");
    // Only digests, as the runner reads them; a tag is left out.
    expect(pins.runnerEnvironment).toEqual({
      NEARZERO_HEROKU_BUILDER_IMAGE: `heroku/builder@${DIGEST}`,
      NEARZERO_STATIC_NGINX_IMAGE: `nginx@${DIGEST}`,
    });
    const lines = runnerEnvironmentLines({
      controlUrl: "https://nz.example.com",
      routerImage: pins.routerImage,
      acmeEmail: null,
      extra: pins.runnerEnvironment,
    });
    expect(lines).toContain("NEARZERO_ROUTER_IMAGE='registry.example.com/traefik:v3.6.17'");
    expect(lines).toContain(`NEARZERO_HEROKU_BUILDER_IMAGE='heroku/builder@${DIGEST}'`);
    expect(lines).toContain(`NEARZERO_STATIC_NGINX_IMAGE='nginx@${DIGEST}'`);
  });

  test("nothing given: the runner's own pins", () => {
    expect(serverRunnerPins({})).toEqual({ routerImage: null, runnerEnvironment: {} });
  });
});

describe("the pinned fallback for servers set up on the domain (C4-06)", () => {
  test("written beside the domain, so the runner can reach the TLS port when the domain can't", () => {
    const fingerprint = "cd".repeat(32);
    const lines = runnerEnvironmentLines({
      controlUrl: "https://nz.example.com",
      controlFallback: { url: "https://203.0.113.10:3443", fingerprint },
      routerImage: null,
      acmeEmail: null,
      extra: {},
    });
    expect(lines).toContain("NEARZERO_CONTROL_URL='https://nz.example.com'");
    expect(lines).toContain("NEARZERO_CONTROL_FALLBACK_URL='https://203.0.113.10:3443'");
    expect(lines).toContain(`NEARZERO_CONTROL_FALLBACK_FINGERPRINT='sha256:${fingerprint}'`);
    expect(lines.join("\n")).not.toContain("NEARZERO_CONTROL_FINGERPRINT=");
    // Never an unpinned fallback.
    const unpinned = runnerEnvironmentLines({
      controlUrl: "https://nz.example.com",
      controlFallback: { url: "https://203.0.113.10:3443", fingerprint: null },
      routerImage: null,
      acmeEmail: null,
      extra: {},
    });
    expect(unpinned.join("\n")).not.toContain("FALLBACK");
  });
});
