import { describe, expect, test } from "bun:test";
import { BACKUP_MESSAGES } from "@nearzero/shared";
import {
  belongsTo,
  composeOutsiders,
  composeVolumes,
  ownershipProblem,
  savedVolumes,
} from "../src/backups/volumes.ts";

/**
 * Which volumes a service backs up (spec 17.3, 24 P4): a Compose stack's own volume definitions
 * with the inner services using them, saved mounts, and containers by their labels; never a
 * name prefix.
 */

const raw = (composeFile: string) => ({
  app_name: "reports-x1y2z3",
  settings: { source: { type: "raw", composeFile } },
});

describe("a Compose stack's volumes (P4, punch list 20)", () => {
  test("named after the project, a name: of their own, or the key for external ones", () => {
    const file = `
services:
  db:
    image: postgres:18
    volumes:
      - pgdata:/var/lib/postgresql
      - ./init:/docker-entrypoint-initdb.d
  web:
    image: nginx:alpine
    volumes:
      - type: volume
        source: assets
        target: /usr/share/nginx/html
      - type: bind
        source: /srv/conf
        target: /etc/nginx/conf.d
  worker:
    image: busybox
    volumes:
      - assets:/data:ro
volumes:
  pgdata: {}
  assets:
  shared:
    name: team-shared
  legacy:
    external: true
`;
    const names = composeVolumes(raw(file));
    expect(names).toContainEqual({
      name: "reports-x1y2z3_pgdata",
      key: "pgdata",
      innerServices: ["db"],
    });
    expect(names).toContainEqual({
      name: "reports-x1y2z3_assets",
      key: "assets",
      innerServices: ["web", "worker"],
    });
    expect(names).toContainEqual({ name: "team-shared", key: "shared", innerServices: [] });
    expect(names).toContainEqual({ name: "legacy", key: "legacy", innerServices: [] });
    expect(names).toHaveLength(4);
    // Only the stack's own may be backed up or restored over (B1-03).
    expect([...composeOutsiders(raw(file))]).toEqual([
      ["team-shared", BACKUP_MESSAGES.foreignNamedVolume],
      ["legacy", BACKUP_MESSAGES.externalVolume],
    ]);
    expect(
      composeOutsiders(
        raw("services:\n  a:\n    image: x\nvolumes:\n  v: { name: reports-x1y2z3-cache }\n"),
      ).size,
    ).toBe(0);
  });

  test("a repository's stack: the volumes read at its last deploy or Preview", () => {
    const fromRepository = composeVolumes({
      app_name: "shop-x1y2z3",
      settings: {
        source: { type: "git", url: "https://github.com/acme/shop", branch: "main" },
        composeInventory: {
          services: [{ name: "db", port: null, dependsOn: [] }],
          volumes: [
            {
              name: "shop-x1y2z3_pgdata",
              key: "pgdata",
              external: false,
              innerServices: ["db"],
            },
          ],
          fingerprint: "abc",
        },
      },
    });
    expect(fromRepository).toEqual([
      { name: "shop-x1y2z3_pgdata", key: "pgdata", innerServices: ["db"] },
    ]);
  });

  test("a file that doesn't parse, or a repository not read yet, declares nothing", () => {
    expect(composeVolumes(raw("services: ["))).toEqual([]);
    expect(composeVolumes(raw("just text"))).toEqual([]);
    expect(
      composeVolumes({
        app_name: "x",
        settings: { source: { type: "git", url: "https://github.com/a/b", branch: "main" } },
      }),
    ).toEqual([]);
  });
});

describe("saved volumes and labels", () => {
  test("apps' volume mounts and databases' data volume", () => {
    expect(
      savedVolumes({
        kind: "application",
        app_name: "shop-web-a1b2c3",
        settings: {
          mounts: [
            { type: "volume", id: "m1", name: "uploads", containerPath: "/data" },
            { type: "bind", id: "m2", hostPath: "/srv", containerPath: "/srv", readOnly: false },
          ],
        },
      }),
    ).toEqual(["shop-web-a1b2c3-uploads"]);
    expect(savedVolumes({ kind: "redis", app_name: "cache-z9", settings: {} })).toEqual([
      "cache-z9-data",
    ]);
    expect(savedVolumes({ kind: "compose", app_name: "stack", settings: {} })).toEqual([]);
  });

  test("a container belongs to a service by its labels only", () => {
    const service = { id: "s1", kind: "compose" as const, app_name: "reports-x1" };
    expect(belongsTo({ labels: { "dev.nearzero.service": "s1" } }, service)).toBe(true);
    expect(belongsTo({ labels: { "com.docker.compose.project": "reports-x1" } }, service)).toBe(
      true,
    );
    expect(
      belongsTo({ labels: { "com.docker.compose.project": "reports-x1-copy" } }, service),
    ).toBe(false);
    expect(belongsTo({ labels: {} }, { ...service, kind: "application" })).toBe(false);
  });
});

describe("whose a volume is (B1-03)", () => {
  test("Nearzero's own volumes, other services' and a stack's outsiders are never this service's", () => {
    const claims = { names: new Set(["victim-k9x8z7-data"]), prefixes: ["other-a1b2c3_"] };
    const outsiders = new Map([["shared-thing", BACKUP_MESSAGES.externalVolume]]);
    expect(ownershipProblem("nearzero-postgres-data", claims, outsiders)).toBe(
      BACKUP_MESSAGES.reservedVolume,
    );
    expect(ownershipProblem("nearzero-router-certificates", claims, outsiders)).toBe(
      BACKUP_MESSAGES.reservedVolume,
    );
    expect(ownershipProblem("victim-k9x8z7-data", claims, outsiders)).toBe(
      BACKUP_MESSAGES.foreignVolume,
    );
    expect(ownershipProblem("other-a1b2c3_pgdata", claims, outsiders)).toBe(
      BACKUP_MESSAGES.foreignVolume,
    );
    expect(ownershipProblem("shared-thing", claims, outsiders)).toBe(
      BACKUP_MESSAGES.externalVolume,
    );
    // A service whose app name starts with "nearzero" keeps its own volumes.
    expect(ownershipProblem("nearzero-x1y2z3-data", claims, outsiders)).toBeNull();
    expect(ownershipProblem("mine-a1b2c3_pgdata", claims, outsiders)).toBeNull();
  });
});
