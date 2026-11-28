import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { VARIABLES_MAX_BYTES } from "@nearzero/shared";
import { SecretBox } from "../src/security/secret-box.ts";
import { variablesForDeploy } from "../src/variables/deploy.ts";
import { setUpNamedOwner } from "./support/harness.ts";
import {
  createProjectsHarness,
  makeProject,
  makeService,
  type ProjectsHarness,
} from "./support/projects.ts";

setDefaultTimeout(120_000);

let p: ProjectsHarness;

beforeAll(async () => {
  p = await createProjectsHarness();
});

afterAll(async () => {
  await p.drop();
});

beforeEach(async () => {
  await p.reset();
});

const WITH_COMMENTS =
  "# Where the API lives\r\nAPI_URL=https://api.example.com\r\n\r\n  # secrets\r\nTOKEN='abc 123'\r\nEMPTY=\r\n# end\r\n";

async function setUp() {
  const owner = await setUpNamedOwner(p.h);
  const { environments } = await makeProject(owner, "Web", ["production"]);
  const development = environments.development as string;
  const app = await makeService(owner, development, { kind: "application", name: "api" });
  return {
    owner,
    development,
    production: environments.production as string,
    serviceId: app.service.id as string,
  };
}

describe("shared variables (spec 05 5.5)", () => {
  test("an env file with comments survives save and reload byte for byte in text mode", async () => {
    const { owner, development } = await setUp();
    const saved = await owner.put(`/environments/${development}/variables`, {
      text: WITH_COMMENTS,
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      message: "Variables saved",
      detail: "They reach the service on its next deploy.",
    });
    const revealed = await owner.post(`/environments/${development}/variables/reveal`);
    expect(revealed.body.text).toBe(WITH_COMMENTS);
    expect(revealed.body.formProblem).toBeNull();
    expect(
      revealed.body.rows.map((row: { name: string; value: string }) => [row.name, row.value]),
    ).toEqual([
      ["API_URL", "https://api.example.com"],
      ["TOKEN", "abc 123"],
      ["EMPTY", ""],
    ]);
    // Stored sealed: the values aren't in the row.
    const stored = await p.h.test.db
      .selectFrom("variable_set")
      .select(["sealed", "names"])
      .executeTakeFirstOrThrow();
    expect(stored.sealed).not.toContain("abc 123");
    expect(stored.names).toEqual(["API_URL", "TOKEN", "EMPTY"]);
  });

  test("values are masked by default, and empty ones say so", async () => {
    const { owner, development, serviceId } = await setUp();
    await owner.put(`/environments/${development}/variables`, { text: WITH_COMMENTS });
    const page = await owner.get(`/environments/${development}/variables`);
    expect(page.status).toBe(200);
    expect(JSON.stringify(page.body)).not.toContain("abc 123");
    expect(page.body.shared.variables).toEqual([
      { name: "API_URL", empty: false },
      { name: "TOKEN", empty: false },
      { name: "EMPTY", empty: true },
    ]);
    expect(page.body.shared.updatedBy.name).toBe("Olivia Owner");
    expect(page.body.notice).toBeNull();
    expect(page.body.services).toEqual([
      { id: serviceId, name: "api", kind: "application", count: 0 },
    ]);
  });

  test("production says changes reach services when they next deploy", async () => {
    const { owner, production } = await setUp();
    const page = await owner.get(`/environments/${production}/variables`);
    expect(page.body.environment.isProduction).toBe(true);
    expect(page.body.notice).toBe(
      "This is production. Saved changes reach services when they next deploy.",
    );
  });

  test("save is blocked with the line named", async () => {
    const { owner, development } = await setUp();
    const twice = await owner.put(`/environments/${development}/variables`, {
      text: "A=1\nB=2\nA=3\n",
    });
    expect(twice.status).toBe(400);
    expect(twice.body.error.message).toBe("A is set twice, on lines 1 and 3. Keep one.");
    expect(twice.body.error.fields["lines.3"]).toBe("A is set twice, on lines 1 and 3. Keep one.");
    const big = await owner.put(`/environments/${development}/variables`, {
      text: `A=${"x".repeat(VARIABLES_MAX_BYTES)}`,
    });
    expect(big.status).toBe(400);
    expect(big.body.error.message).toContain("256 KB");
  });

  test("the form saves rows, keeps comments and lines it didn't change, and keeps hidden values", async () => {
    const { owner, development } = await setUp();
    const first = await owner.put(`/environments/${development}/variables`, {
      text: WITH_COMMENTS,
    });
    const version = first.body.variables.version;
    const saved = await owner.put(`/environments/${development}/variables`, {
      rows: [
        { name: "API_URL", keep: true },
        { name: "TOKEN", value: "new token" },
        { name: "ADDED", value: "1" },
      ],
      baseVersion: version,
    });
    expect(saved.status).toBe(200);
    const text = (await owner.post(`/environments/${development}/variables/reveal`)).body.text;
    expect(text).toBe(
      "# Where the API lives\r\nAPI_URL=https://api.example.com\r\n\r\n  # secrets\r\nTOKEN=new token\r\nADDED=1\r\n# end\r\n",
    );
    // An editor that opened the older version can't overwrite the newer one.
    const stale = await owner.put(`/environments/${development}/variables`, {
      text: "A=1\n",
      baseVersion: version,
    });
    expect(stale.status).toBe(409);
    const missing = await owner.put(`/environments/${development}/variables`, {
      rows: [{ name: "NOPE", keep: true }],
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error.message).toBe("NOPE has no saved value to keep. Enter a value.");
  });

  test("text the form can't hold opens as text with the reason", async () => {
    const { owner, development } = await setUp();
    // Written straight to storage, as an import from an older version could.
    const { writeVariables } = await import("../src/variables/store.ts");
    const environment = await p.h.test.db
      .selectFrom("environment")
      .select(["id", "workspace_id"])
      .where("id", "=", development)
      .executeTakeFirstOrThrow();
    await writeVariables(
      p.h.test.db,
      p.h.services.secrets,
      { kind: "environment", id: environment.id, workspaceId: environment.workspace_id },
      "A=1\nA=2\n",
      { by: null },
    );
    const revealed = await owner.post(`/environments/${development}/variables/reveal`);
    expect(revealed.body.formProblem).toStartWith(
      "This opens as .env text, so nothing is changed or lost.",
    );
  });

  test("values saved with another install secret are reported, not shown as empty", async () => {
    const { owner, development } = await setUp();
    await owner.put(`/environments/${development}/variables`, { text: "A=1\n" });
    const other = new SecretBox("a-completely-different-install-secret");
    await p.h.test.db
      .updateTable("variable_set")
      .set({ sealed: other.seal("A=1\n", `variables:environment:${development}`) })
      .execute();
    const page = await owner.get(`/environments/${development}/variables`);
    expect(page.body.shared.unreadable).toContain("another install secret");
    expect(page.body.shared.variables).toEqual([{ name: "A", empty: false }]);
    expect((await owner.post(`/environments/${development}/variables/reveal`)).status).toBe(409);
  });
});

describe("a service's own variables", () => {
  test("its own wins over shared ones, shown as such", async () => {
    const { owner, development, serviceId } = await setUp();
    await owner.put(`/environments/${development}/variables`, {
      text: "API_URL=https://shared\nREGION=eu\n",
    });
    const saved = await owner.put(`/services/${serviceId}/variables`, {
      text: "API_URL=https://own\nNEXT_PUBLIC_SECRET_KEY=x\n",
    });
    expect(saved.status).toBe(200);
    expect(saved.body.variables.warnings[0].name).toBe("NEXT_PUBLIC_SECRET_KEY");
    const tab = await owner.get(`/services/${serviceId}/variables`);
    expect(tab.body.own.variables.map((variable: { name: string }) => variable.name)).toEqual([
      "API_URL",
      "NEXT_PUBLIC_SECRET_KEY",
    ]);
    expect(tab.body.shared.variables).toEqual([
      { name: "API_URL", empty: false, overridden: true },
      { name: "REGION", empty: false, overridden: false },
    ]);
    expect((await owner.post(`/services/${serviceId}/variables/reveal`)).body.text).toBe(
      "API_URL=https://own\nNEXT_PUBLIC_SECRET_KEY=x\n",
    );

    const resolved = await variablesForDeploy(
      p.h.test.db,
      p.h.services.secrets,
      serviceId,
      "runtime",
    );
    expect(resolved).toEqual({
      ok: true,
      variables: [
        { name: "API_URL", value: "https://own" },
        { name: "REGION", value: "eu" },
        { name: "NEXT_PUBLIC_SECRET_KEY", value: "x" },
      ],
    });
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: a variable reference, not a template
  test("${{environment.MISSING}} fails the deploy with MISSING named", async () => {
    const { owner, serviceId } = await setUp();
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a variable reference, not a template
    await owner.put(`/services/${serviceId}/variables`, { text: "URL=${{environment.MISSING}}\n" });
    const resolved = await variablesForDeploy(
      p.h.test.db,
      p.h.services.secrets,
      serviceId,
      "runtime",
    );
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.errors[0]?.message).toContain("MISSING");
  });

  test("copies in other environments have their own variables", async () => {
    const { owner, serviceId } = await setUp();
    await owner.put(`/services/${serviceId}/variables`, { text: "A=dev\n" });
    const copyId = (await owner.get(`/services/${serviceId}`)).body.service.copies[0].id;
    await owner.put(`/services/${copyId}/variables`, { text: "A=prod\n" });
    expect((await owner.post(`/services/${serviceId}/variables/reveal`)).body.text).toBe("A=dev\n");
    expect((await owner.post(`/services/${copyId}/variables/reveal`)).body.text).toBe("A=prod\n");
  });
});
