import { describe, expect, test } from "bun:test";
import { AppError, ERROR_STATUS, isApiErrorBody, unknownErrorMessage } from "../src/errors.ts";

describe("API errors", () => {
  test("an AppError carries its code, status, message and fields", () => {
    const error = new AppError("invalid_request", "Enter a project name.", {
      fields: { name: "Enter a project name." },
    });
    expect(error.status).toBe(400);
    expect(error.toBody("req_12345678")).toEqual({
      error: {
        code: "invalid_request",
        message: "Enter a project name.",
        fields: { name: "Enter a project name." },
        reference: "req_12345678",
      },
    });
  });

  test("bodies leave out empty optional parts", () => {
    expect(new AppError("not_found", "There is no such project.").toBody()).toEqual({
      error: { code: "not_found", message: "There is no such project." },
    });
  });

  test("every code maps to an error status", () => {
    for (const status of Object.values(ERROR_STATUS)) {
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });

  test("clients accept codes they don't know yet", () => {
    expect(
      isApiErrorBody({ error: { code: "dns_record_missing", message: "Add the record." } }),
    ).toBe(true);
    expect(isApiErrorBody({ error: { code: "Bad Code", message: "x" } })).toBe(false);
    expect(isApiErrorBody({ error: { code: "internal", message: "" } })).toBe(false);
    expect(isApiErrorBody({ message: "nope" })).toBe(false);
  });

  test("the unknown-error message gives the log reference and a next step", () => {
    const message = unknownErrorMessage("req_abcdef12");
    expect(message).toContain("req_abcdef12");
    expect(message).toContain("Try again");
    expect(message).not.toContain("Internal server error");
  });
});
