import { describe, expect, test } from "bun:test";
import {
  appNameProblem,
  createEnvironmentRequestSchema,
  createProjectRequestSchema,
  createServiceRequestSchema,
  DATABASE_DEFAULTS,
  databasePasswordProblem,
  environmentNameHint,
  environmentNameProblem,
  normalizeEnvironmentName,
  suggestAppNameBase,
} from "../src/projects.ts";

describe("environment names (spec 05 5.3)", () => {
  test('"QA Team" becomes "qa-team"', () => {
    expect(normalizeEnvironmentName("QA Team")).toBe("qa-team");
    expect(normalizeEnvironmentName("  my__env  -- 2 ")).toBe("my-env-2");
  });

  test('"prod" and "prd" are refused in favor of "production"', () => {
    expect(environmentNameProblem("prod")).toStartWith('Name it "production" instead');
    expect(environmentNameProblem("prd")).toStartWith('Name it "production" instead');
    expect(environmentNameProblem("production")).toBeNull();
  });

  test("up to 32 letters, numbers and dashes", () => {
    expect(environmentNameProblem("a".repeat(32))).toBeNull();
    expect(environmentNameProblem("a".repeat(33))).toBe("Use at most 32 characters.");
    expect(environmentNameProblem("qa.2")).toBe(
      "Use letters, numbers and dashes, like staging or qa-2.",
    );
  });

  test("the live hint", () => {
    expect(environmentNameHint("QA Team").message).toBe("It will be called qa-team.");
    expect(environmentNameHint("production").message).toBe("This is your production environment.");
    expect(environmentNameHint("staging").message).toBe("Looks good.");
  });

  test("the create schema normalizes and checks", () => {
    const parsed = createEnvironmentRequestSchema.parse({ name: "Staging Two" });
    expect(parsed).toEqual({
      name: "staging-two",
      description: "",
      variables: { from: null, values: false },
    });
    const refused = createEnvironmentRequestSchema.safeParse({ name: "PROD" });
    expect(refused.error?.issues[0]?.message).toStartWith('Name it "production"');
  });
});

describe("projects", () => {
  test("an empty name uses the dialog's words", () => {
    const result = createProjectRequestSchema.safeParse({ name: "  " });
    expect(result.error?.issues[0]?.message).toBe("Project name is required");
  });
});

describe("app names (spec 06 6.1)", () => {
  test("lowercase letters, numbers and single dashes, starting with a letter", () => {
    expect(appNameProblem("web-api-2")).toBeNull();
    for (const bad of ["Web", "2web", "web--api", "web-", "web_api"]) {
      expect(appNameProblem(bad)).not.toBeNull();
    }
  });

  test("the suggestion comes from the project and the service", () => {
    expect(suggestAppNameBase("Acme Shop", "API")).toBe("acme-shop-api");
    expect(suggestAppNameBase("2024 site", "web")).toBe("app-2024-site-web");
    expect(suggestAppNameBase("web", "web")).toBe("web");
    expect(appNameProblem(suggestAppNameBase("x".repeat(80), "y"))).toBeNull();
  });
});

describe("database settings (spec 08 8.1)", () => {
  test("a typed password may not contain $ ! ' \" \\ / or spaces", () => {
    for (const bad of [
      "pa$sword1",
      "pass!word",
      "it's-long",
      'quo"ted12',
      "back\\slash",
      "sla/shed1",
      "has space",
    ]) {
      expect(databasePasswordProblem(bad)).not.toBeNull();
    }
    expect(databasePasswordProblem("Good_pass-123")).toBeNull();
  });

  test("default database names never pick a system schema; MySQL's is app", () => {
    expect(DATABASE_DEFAULTS.mysql.databaseName).toBe("app");
    expect(DATABASE_DEFAULTS.postgres.databaseName).toBe("postgres");
    expect(DATABASE_DEFAULTS.mariadb.databaseName).toBe("mariadb");
  });

  test("the create schema fills each kind's defaults", () => {
    const postgres = createServiceRequestSchema.parse({
      kind: "postgres",
      name: "db",
      serverId: "host",
    });
    expect(postgres.settings).toEqual({ databaseName: "", user: "", password: "", image: "" });
    const replica = createServiceRequestSchema.safeParse({
      kind: "libsql",
      name: "edge",
      serverId: "host",
      settings: { nodeRole: "replica" },
    });
    expect(replica.success).toBe(false);
    const unknown = createServiceRequestSchema.safeParse({
      kind: "nginx",
      name: "x",
      serverId: "host",
    });
    expect(unknown.success).toBe(false);
  });
});
