import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type BundleContent, createBundle, openBundle } from "../../src/migration/bundle.ts";
import { importBundle } from "../../src/migration/importer.ts";
import type { ImportReport } from "../../src/migration/report.ts";
import { createMigrationHarness, type MigrationHarness } from "./support.ts";

/**
 * GitLab, Bitbucket and Gitea push webhooks after a move (spec 29.4, 29.5, 24 G4; 30c R3-36). In
 * 0.1.x a person added the service's deploy webhook URL at the Git host by hand, with no secret.
 * After the import, that webhook's pushes keep deploying through the same URL (its token is the
 * credential, as for every generic webhook), pushes to other branches don't, and the move report
 * names the service so someone presses Register webhook to have each push signed.
 */

const PASSPHRASE = "provider webhooks passphrase";
const TOKEN = "legacy-gitlab-token-0123456789abcdef";

function content(): BundleContent {
  return {
    sourceVersion: "0.1.80",
    installId: "install-gitlab",
    records: {
      "people.jsonl": [{ ref: "per_owner", email: "owner@example.com", firstName: "Owner" }],
      "workspaces.jsonl": [{ ref: "wsp_1", name: "Acme", slug: "acme", firstWorkspace: true }],
      "memberships.jsonl": [
        { ref: "mem_1", personRef: "per_owner", workspaceRef: "wsp_1", role: "Owner" },
      ],
      "git-providers.jsonl": [
        {
          ref: "git_gitlab",
          workspaceRef: "wsp_1",
          ownerRef: "per_owner",
          shared: true,
          kind: "GitLab",
          name: "Acme GitLab",
          connection: null,
          urls: { web: "https://gitlab.example.com", internal: null, redirect: null },
          app: null,
          oauth: null,
          installationIds: [],
          tokens: { accessToken: "glpat-old-token", refreshToken: null, expiresAt: null },
          account: { group: null, username: "acme", email: null, workspace: null },
        },
      ],
      "projects.jsonl": [{ ref: "prj_1", workspaceRef: "wsp_1", name: "Shop" }],
      "environments.jsonl": [
        { ref: "env_1", projectRef: "prj_1", name: "production", default: true },
      ],
      "services.jsonl": [
        {
          ref: "svc_web",
          environmentRef: "env_1",
          kind: "Application",
          name: "web",
          appName: "web-g1t2l3",
          place: { host: true },
          variables: "",
          settings: {
            source: {
              type: "GitLab",
              gitProviderRef: "git_gitlab",
              owner: "group",
              repository: "web",
              branch: "main",
              path: "",
            },
            webhookToken: TOKEN,
          },
          servicePort: 3000,
        },
      ],
    },
    extra: {
      "install.json": { legacyWebhookPaths: { deploy: "/api/deploy/{token}", github: null } },
    },
  };
}

let h: MigrationHarness;
let report: ImportReport;
let serviceId = "";

beforeAll(async () => {
  h = await createMigrationHarness();
  const bytes = await createBundle(content(), PASSPHRASE, { N: 2 ** 14 });
  const result = await importBundle(h.services, await openBundle(bytes, PASSPHRASE), {
    dryRun: false,
    inPlace: false,
  });
  report = result.report;
  serviceId = (
    await h.db
      .selectFrom("service")
      .select("id")
      .where("name", "=", "web")
      .executeTakeFirstOrThrow()
  ).id;
}, 240_000);

afterAll(async () => {
  await h?.drop();
});

const push = (branch: string, sha: string) => ({
  object_kind: "push",
  ref: `refs/heads/${branch}`,
  checkout_sha: sha,
  project: { id: 11, path_with_namespace: "group/web" },
  commits: [{ id: sha, title: "From GitLab", message: "From GitLab", added: [], modified: ["a"] }],
});

describe("a 0.1.x GitLab webhook after the move (30c R3-36)", () => {
  test("the move report names the service and what to do", () => {
    const line = report.changed.find((item) => item.kind === "services" && item.name === "web");
    expect(line?.message).toContain("pushes from its GitLab webhook keep deploying");
    expect(line?.message).toContain("Register webhook");
  });

  test("a push from the unchanged webhook deploys; other branches don't", async () => {
    const browser = h.browser();
    const headers = { "content-type": "application/json", "x-gitlab-event": "Push Hook" };
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    const other = await browser.request(
      "POST",
      `/webhooks/legacy/api/deploy/${TOKEN}`,
      encode(push("develop", "1".repeat(40))),
      headers,
    );
    expect(other.status).toBe(200);
    expect(other.body.deployed).toBe(false);
    const main = await browser.request(
      "POST",
      `/webhooks/legacy/api/deploy/${TOKEN}`,
      encode(push("main", "2".repeat(40))),
      headers,
    );
    expect(main.status).toBe(202);
    const rows = await h.db
      .selectFrom("deployment")
      .select(["requested_commit", "title"])
      .where("service_id", "=", serviceId)
      .execute();
    expect(rows).toEqual([{ requested_commit: "2".repeat(40), title: "From GitLab" }]);
  });
});
