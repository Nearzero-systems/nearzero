import { describe, expect, test } from "bun:test";
import { connectionUrl, encodeCredential, MASK, publicHint } from "../src/lib/connection.ts";
import type { ServiceView } from "../src/lib/data/index.ts";
import { startDeploy } from "../src/lib/deploys.ts";
import { nameHint, variablesHint } from "../src/lib/environments.ts";
import {
  imageProblem,
  isPublicGitUrl,
  portProblem,
  repositoryName,
} from "../src/lib/new-application.ts";
import {
  canvasDetail,
  databaseSettings,
  onCanvas,
  SERVICE_STATUS,
  serverChoices,
  serviceKindName,
  serviceTypeLabel,
} from "../src/lib/projects.ts";
import { newApplicationPath, servicePath } from "../src/lib/routes.ts";
import {
  type DeleteRun,
  ITEM_STATES,
  isUntracked,
  serviceDeleteOutcome,
} from "../src/lib/teardown.ts";
import {
  apiProblems,
  formProblems,
  pasteRows,
  problemLabel,
  sizeLabel,
  startEditing,
  textOfRows,
  textProblems,
  warningsFor,
} from "../src/lib/variables-editor.ts";

function service(overrides: Partial<ServiceView>): ServiceView {
  return {
    id: "s1",
    projectId: "p1",
    environmentId: "e1",
    kind: "application",
    kindLabel: "Application",
    name: "web",
    appName: "shop-web-abc123",
    description: "",
    status: "idle",
    serverId: "host",
    onHost: true,
    settings: {},
    publicPort: null,
    publicPortNote: null,
    copyGroupId: null,
    deleting: false,
    createdAt: new Date(0),
    can: { configure: true, delete: true, deploy: true, variables: true },
    ...overrides,
  };
}

describe("database connection URLs (spec 08 8.2)", () => {
  const base = { user: "postgres", password: "p@ss:w/rd", databaseName: "postgres" };

  test("credentials are percent-encoded, including the characters encodeURIComponent keeps", () => {
    expect(encodeCredential("a!b'c(d)e*f")).toBe("a%21b%27c%28d%29e%2Af");
    expect(
      connectionUrl({ ...base, kind: "postgres", host: "shop-db-abc123", port: 5432 }, "internal"),
    ).toBe("postgresql://postgres:p%40ss%3Aw%2Frd@shop-db-abc123:5432/postgres");
  });

  test("a missing database name is the type's default: MySQL's app, never its system schema", () => {
    const missing = { password: "x", databaseName: null, host: "h", port: 3306 };
    expect(connectionUrl({ ...missing, kind: "mysql", user: "mysql" }, "internal")).toBe(
      "mysql://mysql:x@h:3306/app",
    );
    expect(connectionUrl({ ...missing, kind: "mariadb", user: "mariadb" }, "internal")).toBe(
      "mysql://mariadb:x@h:3306/mariadb",
    );
    expect(connectionUrl({ ...missing, kind: "postgres", user: "postgres" }, "internal")).toBe(
      "postgresql://postgres:x@h:3306/postgres",
    );
  });

  test("each type has its format", () => {
    expect(
      connectionUrl(
        {
          kind: "mysql",
          user: "mysql",
          password: "x",
          databaseName: "mysql",
          host: "h",
          port: 20001,
        },
        "public",
      ),
    ).toBe("mysql://mysql:x@h:20001/mysql");
    expect(
      connectionUrl(
        { kind: "redis", user: null, password: "x", databaseName: null, host: "h", port: 6379 },
        "internal",
      ),
    ).toBe("redis://default:x@h:6379");
    expect(
      connectionUrl(
        {
          kind: "libsql",
          user: "libsql",
          password: "x",
          databaseName: null,
          host: "h",
          port: 8080,
        },
        "internal",
      ),
    ).toBe("http://libsql:x@h:8080");
  });

  test("MongoDB authenticates against admin; a replica set differs inside and out", () => {
    const mongo = {
      kind: "mongodb" as const,
      user: "mongo",
      password: "x",
      databaseName: null,
      host: "h",
      port: 27017,
    };
    expect(connectionUrl(mongo, "internal")).toBe("mongodb://mongo:x@h:27017/?authSource=admin");
    expect(connectionUrl({ ...mongo, replicaSet: true }, "internal")).toBe(
      "mongodb://mongo:x@h:27017/?authSource=admin&replicaSet=rs0",
    );
    expect(connectionUrl({ ...mongo, replicaSet: true }, "public")).toBe(
      "mongodb://mongo:x@h:27017/?authSource=admin&directConnection=true",
    );
  });

  test("masked URLs never carry the password", () => {
    const url = connectionUrl({ ...base, kind: "postgres", host: "h", port: 1 }, "internal", {
      mask: true,
    });
    expect(url).toContain(MASK);
    expect(url).not.toContain("ss");
  });

  test("the hints under the public URL", () => {
    expect(publicHint({ publicPort: 20000, publicPortNote: null, addressKnown: true })).toBe(
      "If it doesn't connect, allow inbound TCP 20000 in the server's firewall or cloud security group.",
    );
    expect(publicHint({ publicPort: 20000, publicPortNote: null, addressKnown: false })).toContain(
      "use its IP with port 20000",
    );
    expect(publicHint({ publicPort: null, publicPortNote: null, addressKnown: true })).toBe(
      "Not reachable from outside this server.",
    );
  });
});

describe("environment names (spec 05 5.3)", () => {
  test("the live hint", () => {
    expect(nameHint("QA Team", []).message).toBe("It will be called qa-team.");
    expect(nameHint("production", []).message).toBe("This is your production environment.");
    expect(nameHint("staging", []).message).toBe("Looks good.");
    expect(nameHint("prod", []).ok).toBe(false);
    expect(nameHint("prd", []).message).toContain('Name it "production" instead');
    expect(nameHint("Staging", ["staging"])).toEqual({
      ok: false,
      name: "staging",
      message: 'This project already has an environment called "staging".',
    });
    expect(nameHint("", []).ok).toBe(false);
  });

  test("what the variables choice will do", () => {
    expect(
      variablesHint({ copy: false, values: false, sourceName: "dev", newName: "x" }),
    ).toBeNull();
    expect(
      variablesHint({ copy: true, values: false, sourceName: "development", newName: "qa" }),
    ).toBe("Names from development are copied with empty values. Fill them in after.");
    expect(variablesHint({ copy: true, values: true, sourceName: "staging", newName: "qa" })).toBe(
      "The values from staging, secrets included, will be copied.",
    );
    expect(
      variablesHint({ copy: true, values: true, sourceName: "staging", newName: "Production" }),
    ).toBe("The values from staging, secrets included, will be copied into production.");
  });
});

describe("the variables editor (spec 05 5.5)", () => {
  const saved = "# The API\nAPI_URL=https://x.example.com\n\n# Retries\nRETRIES=3\n";

  test("opens as a form keeping comments above their rows, and saves back byte for byte", () => {
    const start = startEditing(saved);
    expect(start.mode).toBe("form");
    expect(start.rows.map((row) => row.name)).toEqual(["API_URL", "RETRIES"]);
    expect(start.rows[1]?.above).toEqual(["", "# Retries"]);
    expect(textOfRows(saved, start.rows)).toBe(saved);
  });

  test("a changed row is rewritten; a removed row's comments move to the next row", () => {
    const rows = [{ name: "RETRIES", value: "5", above: [] }];
    expect(textOfRows(saved, rows)).toBe("# The API\n\n# Retries\nRETRIES=5\n");
  });

  test("text the form can't hold opens as text, saying nothing is lost", () => {
    const start = startEditing("A=1\nA=2\n");
    expect(start.mode).toBe("text");
    expect(start.reason).toContain("so nothing is changed or lost");
  });

  test("every blocking problem names its line", () => {
    const problems = textProblems("A=1\nA=2\nnot a line\n=value\n");
    expect(problems.map((problem) => problem.line)).toEqual([2, 3, 4]);
    expect(problems[0]?.message).toBe("A is set twice, on lines 1 and 2. Keep one.");
    expect(problemLabel(problems[1] ?? { line: 0, message: "" }, "text")).toStartWith("Line 3");
    const rows = formProblems("", [
      { name: "1BAD", value: "x" },
      { name: "", value: "y" },
    ]);
    expect(rows.map((problem) => problem.line)).toEqual([1, 2]);
    expect(problemLabel(rows[0] ?? { line: 0, message: "" }, "form")).toStartWith("Row 1:");
  });

  test("more than 256 KB is refused", () => {
    const big = `BIG=${"x".repeat(256 * 1024)}\n`;
    expect(textProblems(big)[0]?.message).toContain("256 KB");
    expect(formProblems("", [{ name: "BIG", value: "x".repeat(256 * 1024) }])[0]?.line).toBe(0);
    expect(sizeLabel(1536)).toBe("1.5 KB of 256 KB");
  });

  test("pasting an env file adds and updates rows, and says what it left out", () => {
    const merged = pasteRows([{ name: "A", value: "1", above: ["# a"] }], "A=2\n# c\nB=3\nnope\n");
    expect(merged.rows).toEqual([
      { name: "A", value: "2", above: ["# a"] },
      { name: "B", value: "3", above: [] },
    ]);
    expect(merged.messages).toEqual([
      "Added 1 variable and updated 1 from the paste.",
      "Left out line 4: not one-line NAME=value.",
      "Comments in the paste were left out.",
    ]);
  });

  test("API refusals map to their lines; public secrets warn", () => {
    expect(apiProblems({ "lines.3": "bad", "rows.1": "worse" }, "x")).toEqual([
      { line: 1, message: "worse" },
      { line: 3, message: "bad" },
    ]);
    expect(apiProblems({}, "Someone saved a newer version.")).toEqual([
      { line: 0, message: "Someone saved a newer version." },
    ]);
    expect(warningsFor(["NEXT_PUBLIC_API_KEY", "VITE_URL"])).toHaveLength(1);
  });
});

describe("services on the Overview (spec 05 5.2)", () => {
  test("status pills", () => {
    expect(SERVICE_STATUS.idle.label).toBe("Not running");
    expect(SERVICE_STATUS.failed).toEqual({ pill: "fail", label: "Error" });
    expect(SERVICE_STATUS.deploying.label).toBe("Deploying");
  });

  test("the canvas holds services whose last deploy succeeded", () => {
    const last = (succeeded: boolean) => ({
      id: "d",
      status: succeeded ? ("active" as const) : ("failed" as const),
      statusLabel: "",
      succeeded,
      title: "",
      commit: null,
      shortCommit: null,
      finishedAt: null,
    });
    expect(onCanvas({ status: "running", deploy: { last: last(true), inProgress: null } })).toBe(
      true,
    );
    expect(onCanvas({ status: "stopped", deploy: { last: last(true), inProgress: null } })).toBe(
      true,
    );
    expect(onCanvas({ status: "running", deploy: { last: last(false), inProgress: null } })).toBe(
      false,
    );
    expect(
      onCanvas({
        status: "deploying",
        deploy: { last: null, inProgress: { id: "d", status: "building" } },
      }),
    ).toBe(false);
    // Without the API's summary, a service counts once it has run.
    expect(onCanvas(service({ status: "idle" }))).toBe(false);
    expect(onCanvas(service({ status: "failed" }))).toBe(false);
    expect(onCanvas(service({ status: "running" }))).toBe(true);
    expect(onCanvas(service({ status: "stopped" }))).toBe(true);
  });

  test("Framework for apps, Runtime (the container's app name) for the rest", () => {
    expect(canvasDetail(service({ settings: { framework: "Next.js" } }))).toEqual({
      label: "Framework",
      value: "Next.js",
    });
    expect(canvasDetail(service({ settings: { build: { type: "dockerfile" } } })).value).toBe(
      "Dockerfile",
    );
    expect(
      canvasDetail(service({ settings: { source: { type: "image", image: "nginx" } } })).value,
    ).toBe("Docker");
    expect(canvasDetail(service({ settings: { build: { type: "automatic" } } })).value).toBe(
      "Unknown",
    );
    expect(
      canvasDetail(service({ kind: "postgres", appName: "shop-db-x1y2z3", settings: {} })),
    ).toEqual({ label: "Runtime", value: "shop-db-x1y2z3" });
    expect(
      canvasDetail(service({ kind: "postgres", appName: "", settings: { image: "postgres:18" } })),
    ).toEqual({ label: "Runtime", value: "postgres:18" });
    expect(
      canvasDetail(service({ kind: "compose", appName: "", settings: { format: "stack" } })).value,
    ).toBe("Stack");
  });

  test("database settings fall back to the type's defaults", () => {
    const settings = databaseSettings(service({ kind: "mysql", settings: { user: "app" } }));
    expect(settings).toMatchObject({
      image: "mysql:8",
      port: 3306,
      user: "app",
      databaseName: null,
    });
  });

  test("the server picker: the host as Nearzero (local), then ready servers", () => {
    expect(
      serverChoices([
        { id: "s2", name: "builder", readiness: "setup_needed", host: false },
        { id: "host", name: "Nearzero host", readiness: "inactive", host: true },
        { id: "s1", name: "eu-1", readiness: "ready", host: false },
      ]),
    ).toEqual([
      { id: "host", label: "Nearzero (local)" },
      { id: "s1", label: "eu-1" },
    ]);
    expect(serverChoices([])).toEqual([]);
  });
});

describe("deleting (spec 05 5.1, 5.2)", () => {
  const run = (states: DeleteRun["items"][number]["state"][], message = "2 services removed") =>
    ({
      id: "r1",
      scope: "services",
      state: states.includes("not_removed") ? "failed" : "succeeded",
      tracked: true,
      project: { id: "p", name: "shop", kept: true },
      items: states.map((state, index) => ({
        serviceId: `s${index}`,
        name: "db",
        kind: "postgres",
        environmentName: index === 0 ? "development" : "production",
        production: index === 1,
        state,
        reason: state === "not_removed" ? "The server can't be reached." : null,
      })),
      counts: { waiting: 0, removing: 0, removed: 0, notRemoved: 0 },
      message,
      createdAt: "",
      finishedAt: "",
    }) satisfies DeleteRun;

  test("item states have the spec's words", () => {
    expect(Object.values(ITEM_STATES).map((state) => state.label)).toEqual([
      "Waiting",
      "Removing…",
      "Removed",
      "Not removed",
    ]);
  });

  test('"Service removed", or a persistent "Service removed, but not everywhere" naming what failed', () => {
    expect(serviceDeleteOutcome(run(["removed", "removed"]))).toEqual({
      message: "2 services removed",
      persist: false,
    });
    const partial = serviceDeleteOutcome(run(["removed", "not_removed"]));
    expect(partial.persist).toBe(true);
    expect(partial.message).toBe(
      "Service removed, but not everywhere. Not removed: production (db): The server can't be reached.",
    );
  });

  test("a running delete the platform stopped carrying out is untracked", () => {
    expect(isUntracked({ state: "running", tracked: false })).toBe(true);
    expect(isUntracked({ state: "failed", tracked: false })).toBe(false);
  });
});

describe("creating an application (spec 06 6.1)", () => {
  test("public repository URLs over HTTPS or git@host:owner/repo", () => {
    expect(isPublicGitUrl("https://github.com/acme/shop")).toBe(true);
    expect(isPublicGitUrl("https://git.example.org:8443/team/shop.git")).toBe(true);
    expect(isPublicGitUrl("git@gitlab.com:acme/shop.git")).toBe(true);
    expect(isPublicGitUrl("http://github.com/acme/shop")).toBe(false);
    expect(isPublicGitUrl("https://github.com/acme")).toBe(false);
    expect(isPublicGitUrl("https://user:token@github.com/acme/shop")).toBe(false);
    expect(isPublicGitUrl("github.com/acme/shop")).toBe(false);
    expect(repositoryName("https://github.com/acme/shop.git/")).toBe("shop");
    expect(repositoryName("git@host:acme/api")).toBe("api");
  });

  test("ports and images", () => {
    expect(portProblem("3000")).toBeNull();
    expect(portProblem("0")).toBe("Enter a valid service port (1–65535).");
    expect(portProblem("70000")).not.toBeNull();
    expect(imageProblem("nginx:alpine")).toBeNull();
    expect(imageProblem("nginx alpine")).toContain("no spaces");
  });

  test("addresses of the new pages", () => {
    expect(newApplicationPath("acme", "p", "e")).toBe(
      "/acme/dashboard/projects/p/e/new-application",
    );
    expect(servicePath("acme", "p", "e", "s")).toBe("/acme/dashboard/projects/p/e/services/s");
    expect(servicePath("acme", "p", "e", "s", "variables")).toBe(
      "/acme/dashboard/projects/p/e/services/s/variables",
    );
  });
});

describe("deploying goes through one place", () => {
  test("it asks the deploy API and reports what it answered", async () => {
    const calls: { method: string; path: string; body: unknown }[] = [];
    const send = async <T>(method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      return {
        deployment: { id: "d1" },
        replaced: false,
        waiting: true,
        message: "Deployment queued. It starts when the running one ends.",
      } as T;
    };
    expect(await startDeploy(send, "s 1")).toEqual({
      status: "started",
      deploymentId: "d1",
      message: "Deployment queued. It starts when the running one ends.",
      waiting: true,
      replaced: false,
    });
    expect(calls).toEqual([{ method: "POST", path: "/services/s%201/deployments", body: {} }]);
  });

  test("a refusal comes back in the API's words", async () => {
    const { ApiError } = await import("../src/lib/api-error.ts");
    const send = async <T>(): Promise<T> => {
      throw new ApiError({
        status: 409,
        code: "conflict",
        message: "Wait for the deployment to finish first.",
      });
    };
    expect(await startDeploy(send, "s1")).toEqual({
      status: "refused",
      message: "Wait for the deployment to finish first.",
      code: "conflict",
    });
  });
});

describe("database type names (spec 21.10 Wording; B3-21)", () => {
  test("every page uses the original's names", () => {
    const kinds = ["postgres", "mysql", "mariadb", "mongodb", "redis", "libsql"] as const;
    const names = ["Postgres", "Mysql", "Mariadb", "Mongo", "Redis", "LibSQL"];
    expect(kinds.map((kind) => serviceTypeLabel(kind))).toEqual(names);
    expect(kinds.map((kind) => serviceKindName(kind))).toEqual(names);
  });
});
