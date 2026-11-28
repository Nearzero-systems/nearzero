import { describe, expect, test } from "bun:test";
import {
  COPY_REFUSED_MESSAGE,
  type CopyEnvironment,
  copyText,
  fallbackHost,
} from "../src/lib/copy-text.ts";

interface FakeField {
  value: string;
  readOnly: boolean;
  attributes: Record<string, string>;
  style: { cssText: string };
  selected: boolean;
  removed: boolean;
  setAttribute(name: string, value: string): void;
  focus(): void;
  select(): void;
  setSelectionRange(start: number, end: number): void;
  remove(): void;
}

function fakeField(): FakeField {
  return {
    value: "",
    readOnly: false,
    attributes: {},
    style: { cssText: "" },
    selected: false,
    removed: false,
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    focus() {},
    select() {
      this.selected = true;
    },
    setSelectionRange() {},
    remove() {
      this.removed = true;
    },
  };
}

function environment(options: {
  clipboard?: CopyEnvironment["clipboard"];
  execResult?: boolean | "throw";
  dialogs?: number;
}) {
  const created: FakeField[] = [];
  const appended: { host: string; node: FakeField }[] = [];
  const copiedWhileSelected: string[] = [];
  const host = (name: string) => ({
    append: (node: FakeField) => appended.push({ host: name, node }),
  });
  const env = {
    clipboard: options.clipboard,
    createField: () => {
      const field = fakeField();
      created.push(field);
      return field;
    },
    openDialogs: () => Array.from({ length: options.dialogs ?? 0 }, (_, i) => host(`dialog-${i}`)),
    body: host("body"),
    activeElement: () => null,
    execCopy: () => {
      if (options.execResult === "throw") throw new Error("not allowed");
      const field = created[created.length - 1];
      if (field?.selected) copiedWhileSelected.push(field.value);
      return options.execResult ?? true;
    },
  } as unknown as CopyEnvironment;
  return { env, created, appended, copiedWhileSelected };
}

describe("copy with the plain-HTTP fallback (spec 21.9)", () => {
  test("uses the clipboard API when the browser offers it", async () => {
    const written: string[] = [];
    const { env, created } = environment({
      clipboard: { writeText: async (text) => void written.push(text) },
    });
    expect(await copyText("https://shop.example.com", env)).toBe(true);
    expect(written).toEqual(["https://shop.example.com"]);
    expect(created).toHaveLength(0);
  });

  test("without the clipboard API, selects a hidden read-only field and copies it", async () => {
    const { env, created, appended, copiedWhileSelected } = environment({ clipboard: undefined });
    expect(await copyText("203.0.113.10", env)).toBe(true);
    expect(copiedWhileSelected).toEqual(["203.0.113.10"]);
    expect(created[0]?.readOnly).toBe(true);
    expect(created[0]?.style.cssText).toContain("opacity:0");
    expect(created[0]?.removed).toBe(true);
    expect(appended[0]?.host).toBe("body");
  });

  test("falls back when the clipboard API refuses", async () => {
    const { env, copiedWhileSelected } = environment({
      clipboard: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
    });
    expect(await copyText("secret-free text", env)).toBe(true);
    expect(copiedWhileSelected).toEqual(["secret-free text"]);
  });

  test("puts the field inside the topmost open dialog, because the page behind it is inert", async () => {
    const { env, appended } = environment({ clipboard: undefined, dialogs: 2 });
    await copyText("inside a dialog", env);
    expect(appended[0]?.host).toBe("dialog-1");
    const noDialog = environment({ clipboard: undefined, dialogs: 0 });
    expect(fallbackHost(noDialog.env)).toBe(noDialog.env.body);
  });

  test("reports failure when both ways fail, so the page can say so", async () => {
    const refused = environment({ clipboard: undefined, execResult: false });
    expect(await copyText("x", refused.env)).toBe(false);
    const thrown = environment({ clipboard: undefined, execResult: "throw" });
    expect(await copyText("x", thrown.env)).toBe(false);
    expect(thrown.created[0]?.removed).toBe(true);
    expect(COPY_REFUSED_MESSAGE).toBe("The browser refused to copy.");
  });
});
