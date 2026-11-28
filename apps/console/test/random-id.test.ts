import { describe, expect, test } from "bun:test";
import { randomId } from "../src/lib/random-id.ts";

describe("random ids without the insecure-context APIs (spec 21.9)", () => {
  test("never touches the UUID generator or subtle crypto", () => {
    const calls: string[] = [];
    const source = {
      getRandomValues<T extends ArrayBufferView | null>(array: T): T {
        calls.push("getRandomValues");
        return crypto.getRandomValues(array as unknown as Uint8Array) as unknown as T;
      },
      get randomUUID() {
        calls.push("randomUUID");
        return undefined;
      },
      get subtle() {
        calls.push("subtle");
        return undefined;
      },
    };
    const id = randomId(20, "", source);
    expect(id).toHaveLength(20);
    expect(calls.every((call) => call === "getRandomValues")).toBe(true);
  });

  test("works when the browser offers only getRandomValues, as on plain HTTP", () => {
    const real = globalThis.crypto;
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { getRandomValues: real.getRandomValues.bind(real) },
    });
    try {
      expect(randomId()).toMatch(/^[0-9a-z]{16}$/);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
    }
  });

  test("uses lowercase letters and digits, with an optional prefix", () => {
    expect(randomId(12, "prj")).toMatch(/^prj_[0-9a-z]{12}$/);
    expect(randomId(1)).toMatch(/^[0-9a-z]$/);
  });

  test("redraws bytes that would bias the result", () => {
    // 252 and above would favour the first characters; they must be skipped.
    let round = 0;
    const source = {
      getRandomValues<T extends ArrayBufferView | null>(array: T): T {
        const bytes = array as unknown as Uint8Array;
        bytes.fill(round++ === 0 ? 255 : 37);
        return array;
      },
    };
    expect(randomId(4, "", source)).toBe("1111");
  });

  test("is unique across many draws and refuses silly lengths", () => {
    const ids = new Set(Array.from({ length: 5000 }, () => randomId()));
    expect(ids.size).toBe(5000);
    expect(() => randomId(0)).toThrow();
    expect(() => randomId(129)).toThrow();
  });
});
