import { describe, expect, test } from "bun:test";
import { consolePathKey, consolePathTail } from "../../src/migration/console-paths.ts";
import {
  controlPlaneDetails,
  controlPlaneLine,
  controlPlaneWorkloads,
  envFileValue,
  legacyWebhookPatterns,
  legacyWorkloads,
  matchWebhookPath,
} from "../../src/migration/legacy-fields.ts";

/** The optional fields of spec 29a.9 and 29a.9.1, read without a database. */

describe("legacy workloads (29a.9 controlPlane, servers[].legacy)", () => {
  test("every shape names its workloads; anything else is ignored", () => {
    expect(legacyWorkloads([{ kind: "swarm-service", name: "nearzero_app" }])).toEqual([
      { kind: "swarm-service", name: "nearzero_app" },
    ]);
    expect(
      legacyWorkloads({
        containers: ["nearzero-console"],
        services: ["nearzero_app"],
        composeProject: "nearzero",
        stack: "nearzero-stack",
        ports: [3000, 4321],
      }),
    ).toEqual([
      { kind: "container", name: "nearzero-console" },
      { kind: "swarm-service", name: "nearzero_app" },
      { kind: "compose-project", name: "nearzero" },
      { kind: "swarm-stack", name: "nearzero-stack" },
    ]);
    expect(legacyWorkloads({ container: "old-router" })).toEqual([
      { kind: "container", name: "old-router" },
    ]);
    expect(legacyWorkloads({ service: "nearzero_traefik" })).toEqual([
      { kind: "swarm-service", name: "nearzero_traefik" },
    ]);
    expect(legacyWorkloads("old-router")).toEqual([{ kind: "container", name: "old-router" }]);
    expect(legacyWorkloads({ name: "old-router" })).toEqual([
      { kind: "container", name: "old-router" },
    ]);
    expect(legacyWorkloads([{ kind: "vm", name: "x" }, "bad name; rm -rf /", 7, null])).toEqual([]);
    expect(legacyWorkloads(undefined)).toEqual([]);
  });
});

describe("old webhook paths (29a.9 legacyWebhookPaths)", () => {
  test("a deploy path has {token}; the GitHub App's path is marked so", () => {
    expect(
      legacyWebhookPatterns({ deploy: "/api/deploy/{token}", github: "/api/deploy/github" }),
    ).toEqual([
      { pattern: "/api/deploy/{token}", kind: "deploy" },
      { pattern: "/api/deploy/github", kind: "github" },
    ]);
    expect(
      legacyWebhookPatterns([
        "/api/deploy/{token}",
        "/api/deploy/compose/{token}",
        "/api/providers/github/webhook",
      ]),
    ).toEqual([
      { pattern: "/api/deploy/{token}", kind: "deploy" },
      { pattern: "/api/deploy/compose/{token}", kind: "deploy" },
      { pattern: "/api/providers/github/webhook", kind: "github" },
    ]);
    expect(
      legacyWebhookPatterns([
        { kind: "deploy", path: "/hooks/{token}" },
        { kind: "githubApp", path: "/hooks/gh" },
      ]),
    ).toEqual([
      { pattern: "/hooks/{token}", kind: "deploy" },
      { pattern: "/hooks/gh", kind: "github" },
    ]);
  });

  test("1.0's own addresses, relative paths and plain paths that aren't marked are left out", () => {
    expect(
      legacyWebhookPatterns([
        "/api/v1/webhooks/deploy/{token}",
        "api/deploy/{token}",
        "/plain/path",
        "/with space/{token}",
      ]),
    ).toEqual([]);
    expect(legacyWebhookPatterns(null)).toEqual([]);
  });

  test("a path matches its pattern and gives the token", () => {
    expect(matchWebhookPath("/api/deploy/{token}", "/api/deploy/abc123")).toBe("abc123");
    expect(matchWebhookPath("/api/deploy/{token}", "/api/deploy/abc123/")).toBe("abc123");
    expect(matchWebhookPath("/api/deploy/{token}", "/api/deploy/abc/def")).toBeNull();
    expect(matchWebhookPath("/api/deploy/{token}", "/api/deployx/abc")).toBeNull();
    expect(matchWebhookPath("/api/deploy/github", "/api/deploy/github")).toBe("");
    expect(matchWebhookPath("/api/deploy/github", "/api/deploy/github/")).toBe("");
    expect(matchWebhookPath("/api/deploy/github", "/api/deploy/gitlab")).toBeNull();
    expect(matchWebhookPath("/a.b/{token}", "/aXb/t")).toBeNull();
  });
});

describe("old console addresses (29a.9.1)", () => {
  test("kept as a path without host, query, fragment or trailing slash", () => {
    expect(consolePathKey("/acme/project/p-1/")).toBe("/acme/project/p-1");
    expect(consolePathKey("https://old.example.com/acme/project/p-1?tab=x#y")).toBe(
      "/acme/project/p-1",
    );
    expect(consolePathKey("/acme//project")).toBe("/acme/project");
    expect(consolePathKey("/")).toBeNull();
    expect(consolePathKey("")).toBeNull();
    expect(consolePathTail("/acme/project/p-1")).toBe("/project/p-1");
    expect(consolePathTail("/project")).toBeNull();
  });
});

describe("the 0.1.x control plane (29a.9 controlPlane, controlPlaneDetails)", () => {
  test("a list of { kind, name } with the three kinds it runs as; nothing else", () => {
    expect(
      controlPlaneWorkloads([
        { kind: "container", name: "nearzero-console" },
        { kind: "swarm-service", name: "nearzero_api" },
        { kind: "compose-project", name: "nearzero" },
        { kind: "swarm-stack", name: "nearzero" },
        "nearzero-db",
        { kind: "container", name: "x; rm -rf /" },
      ]),
    ).toEqual([
      { kind: "container", name: "nearzero-console" },
      { kind: "swarm-service", name: "nearzero_api" },
      { kind: "compose-project", name: "nearzero" },
    ]);
    expect(controlPlaneWorkloads({ containers: ["nearzero-console"] })).toEqual([]);
    expect(controlPlaneWorkloads(null)).toEqual([]);
  });

  test("its details are read leniently, and a folder must be a plain absolute path", () => {
    expect(
      controlPlaneDetails({
        composeProject: "nearzero",
        folder: "/opt/nearzero/",
        ports: [3000, "4321/tcp", 0, 3000],
      }),
    ).toEqual({
      composeProject: "nearzero",
      folder: "/opt/nearzero",
      ports: [3000, 4321],
      composeFiles: [],
      envFile: null,
    });
    expect(controlPlaneDetails({ project: "np", directory: "/srv/np" })).toEqual({
      composeProject: "np",
      folder: "/srv/np",
      ports: [],
      composeFiles: [],
      envFile: null,
    });
    // 0.1.x's own Compose files, in order, and its env file: names inside the folder only.
    expect(
      controlPlaneDetails({
        composeProject: "nearzero",
        folder: "/opt/nearzero",
        composeFiles: [
          "docker-compose.prod.yml",
          "./docker-compose.local-db.yml",
          "../etc/passwd",
          "/abs.yml",
          "with space.yml",
        ],
        envFile: ".env",
      }),
    ).toMatchObject({
      composeFiles: ["docker-compose.prod.yml", "docker-compose.local-db.yml"],
      envFile: ".env",
    });
    expect(
      controlPlaneDetails({ folder: "/opt/nearzero", envFile: "../.env" })?.envFile,
    ).toBeNull();
    expect(controlPlaneDetails({ folder: "/opt/../etc" })).toBeNull();
    expect(controlPlaneDetails({ folder: "relative/path", composeProject: "bad name" })).toBeNull();
    expect(controlPlaneDetails("nearzero")).toBeNull();
  });

  test("the dry-run report says what stops and what rollback starts", () => {
    expect(
      controlPlaneLine([{ kind: "container", name: "nearzero-api" }], {
        composeProject: null,
        folder: "/opt/nearzero",
        ports: [3000],
        composeFiles: [],
        envFile: null,
      }),
    ).toBe(
      "The 0.1.x control plane (in /opt/nearzero, holding port 3000): container nearzero-api stops when the move starts, and rollback starts it again.",
    );
    expect(
      controlPlaneLine([], {
        composeProject: "nearzero",
        folder: null,
        ports: [],
        composeFiles: [],
        envFile: null,
      }),
    ).toBe(
      "The 0.1.x control plane (Compose project nearzero). The export doesn't say what runs it, so the installer stops nothing; while its ports are held, the move doesn't start.",
    );
    expect(controlPlaneLine([], null)).toBeNull();
  });
});

describe("env files outside a project's folder (29a.9)", () => {
  test("an absolute path of plain characters is kept; a way back up or a relative escape isn't", () => {
    expect(envFileValue(".env")).toBe(".env");
    expect(envFileValue("/opt/nearzero/data/secrets/compose-env/shop.env")).toBe(
      "/opt/nearzero/data/secrets/compose-env/shop.env",
    );
    expect(envFileValue("/opt/nearzero//secrets/shop.env")).toBe("/opt/nearzero/secrets/shop.env");
    expect(envFileValue("/opt/nearzero/../etc/shadow")).toBeNull();
    expect(envFileValue("../shop.env")).toBeNull();
    expect(envFileValue("/")).toBeNull();
    expect(envFileValue("/opt/near zero/shop.env")).toBeNull();
    // Compose files stay names inside the folder.
    expect(
      controlPlaneDetails({ folder: "/opt/nearzero", composeFiles: ["/opt/x.yml"] })?.composeFiles,
    ).toEqual([]);
  });
});
