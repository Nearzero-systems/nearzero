import { describe, expect, test } from "bun:test";
import { buildComposeDeploySpec } from "./composeDeploySpec";

describe("buildComposeDeploySpec", () => {
  test("treats Next.js preset as service by default", () => {
    const result = buildComposeDeploySpec({
      projectName: "demo",
      preset: "Next.js",
      suggestedType: "",
      root: ".",
      buildCommand: "npm run build",
      outputDir: "out",
      envEntries: [],
    });

    expect(result.errors).toEqual([]);
    expect(result.spec?.type).toBe("service");
    expect(result.spec?.build?.command).toBe("npm run build");
    expect(result.spec?.start?.command).toBe("npm run start");
  });

  test("honors explicit suggestedType overrides", () => {
    const result = buildComposeDeploySpec({
      projectName: "demo",
      preset: "Other",
      suggestedType: "worker",
      root: ".",
      buildCommand: "npm run build",
      outputDir: "dist",
      envEntries: [],
    });

    expect(result.errors).toEqual([]);
    expect(result.spec?.type).toBe("worker");
    expect(result.spec?.worker?.entry).toBe("dist/index.js");
  });

  test("uses preset start defaults for non-node services", () => {
    const result = buildComposeDeploySpec({
      projectName: "demo",
      preset: "FastAPI",
      suggestedType: "",
      root: ".",
      buildCommand: "",
      outputDir: "dist",
      envEntries: [],
    });

    expect(result.errors).toEqual([]);
    expect(result.spec?.type).toBe("service");
    expect(result.spec?.build).toBeUndefined();
    expect(result.spec?.start?.command).toBe(
      "python -m uvicorn main:app --host 0.0.0.0 --port 3000",
    );
  });
});
