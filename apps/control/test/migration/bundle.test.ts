import { describe, expect, test } from "bun:test";
import { readArchive, safeArchivePath, writeArchive } from "../../src/migration/archive.ts";
import {
  BUNDLE_MESSAGES,
  BundleError,
  bundleFiles,
  bundleLines,
  createBundle,
  openBundle,
  SOURCE_REFS,
  sealArchive,
  sha256Hex,
} from "../../src/migration/bundle.ts";

/** The export bundle's reader (spec 29a.2–29a.4). Tests use scrypt's lowest accepted cost. */

const PASSPHRASE = "correct horse battery staple";
const FAST = { N: 2 ** 14 };

const content = {
  sourceVersion: "0.1.80",
  records: {
    "people.jsonl": [{ ref: "per_1", email: "a@example.com" }],
    "workspaces.jsonl": [{ ref: "wsp_1", name: "Acme", slug: "acme" }],
  },
  extra: {
    "install.json": { platformDomain: "apps.example.com" },
    "acme/host/acme.json": { letsencrypt: { Account: null, Certificates: [] } },
  },
  notes: [{ kind: "install", reason: "Something didn't map." }],
};

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BundleError);
    return (error as Error).message;
  }
  throw new Error("expected a refusal");
}

/** The clear header of a bundle, and its length. */
function headerOf(bytes: Uint8Array): { json: Record<string, unknown>; length: number } {
  const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, false);
  return { json: JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + length))), length };
}

/** The same bundle with its header replaced (the ciphertext and tag unchanged). */
function withHeader(bytes: Uint8Array, header: Record<string, unknown>): Uint8Array {
  const { length } = headerOf(bytes);
  const json = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(12 + json.length + bytes.length - 12 - length);
  out.set(bytes.subarray(0, 8), 0);
  new DataView(out.buffer).setUint32(8, json.length, false);
  out.set(json, 12);
  out.set(bytes.subarray(12 + length), 12 + json.length);
  return out;
}

describe("archive", () => {
  test("round trip, long paths, and unsafe paths refused", () => {
    const long = `${"deep/".repeat(30)}file.json`;
    const files = new Map<string, Uint8Array>([
      ["a.jsonl", new TextEncoder().encode("one\n")],
      [long, new Uint8Array(1500).fill(7)],
    ]);
    const read = readArchive(writeArchive(files));
    expect([...read.keys()]).toEqual(["a.jsonl", long]);
    expect(read.get(long)?.length).toBe(1500);
    expect(safeArchivePath("../etc/passwd")).toBeNull();
    expect(safeArchivePath("/abs")).toBeNull();
    expect(safeArchivePath("a/./b")).toBeNull();
    expect(safeArchivePath("./acme/host/acme.json")).toBe("acme/host/acme.json");
  });
});

describe("openBundle", () => {
  test("a good bundle opens: 29a.2 layout, manifest, records, stores and notes", async () => {
    const bytes = await createBundle(content, PASSPHRASE, FAST);
    expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe("NZEXPORT");
    expect(headerOf(bytes).json).toMatchObject({
      format: 1,
      cipher: "aes-256-gcm",
      kdf: { name: "scrypt", input: "utf8-nfc", N: 16384, r: 8, p: 1, keyLength: 32 },
      tagLength: 16,
    });
    const bundle = await openBundle(bytes, PASSPHRASE);
    expect(bundle.manifest.format).toBe(1);
    expect(bundle.manifest.sourceVersion).toBe("0.1.80");
    expect(bundle.manifest.counts).toMatchObject({ people: 1, workspaces: 1, acme: 1, volumes: 0 });
    expect(bundle.manifest.acme).toEqual([
      { path: "acme/host/acme.json", serverRef: null, host: true, certificates: 0 },
    ]);
    expect(bundle.manifest.notes).toEqual([{ kind: "install", reason: "Something didn't map." }]);
    expect(bundle.manifest.files.map((file) => file.path)).toEqual([
      "install.json",
      "people.jsonl",
      "workspaces.jsonl",
      "acme/host/acme.json",
    ]);
    expect(bundle.sourceInstall).toBe(SOURCE_REFS);
    expect(bundle.sha256).toBe(sha256Hex(bytes));
    expect(bundleLines(bundle, "people.jsonl").map((item) => item.value)).toEqual([
      { ref: "per_1", email: "a@example.com" },
    ]);
    expect(bundle.files.has("manifest.json")).toBe(false);
  });

  test("the default work factor is scrypt N=2^17, r=8, p=1, and the passphrase is NFC", async () => {
    const bytes = await createBundle(content, "café passphrase");
    expect(headerOf(bytes).json).toMatchObject({ kdf: { N: 131072, r: 8, p: 1 } });
    // The same words typed with a composed é open it.
    expect((await openBundle(bytes, "café passphrase")).manifest.sourceVersion).toBe("0.1.80");
  });

  test("a wrong passphrase is refused with 29a's words", async () => {
    const bytes = await createBundle(content, PASSPHRASE, FAST);
    expect(await refusal(openBundle(bytes, "not the passphrase"))).toBe(
      "Wrong passphrase, or the bundle was changed.",
    );
    expect(await refusal(openBundle(bytes, ""))).toBe(BUNDLE_MESSAGES.noPassphrase);
  });

  test("a changed byte or a changed header fails like a wrong passphrase", async () => {
    const bytes = await createBundle(content, PASSPHRASE, FAST);
    const flipped = new Uint8Array(bytes);
    flipped[flipped.length - 40] = (flipped[flipped.length - 40] ?? 0) ^ 1;
    expect(await refusal(openBundle(flipped, PASSPHRASE))).toBe(BUNDLE_MESSAGES.wrongPassphrase);
    const { json } = headerOf(bytes);
    const edited = withHeader(bytes, { ...json, kdf: { ...(json.kdf as object), r: 9 } });
    expect(await refusal(openBundle(edited, PASSPHRASE))).toBe(BUNDLE_MESSAGES.wrongPassphrase);
  });

  test("a header asking for too much memory is refused before any work", async () => {
    const bytes = await createBundle(content, PASSPHRASE, FAST);
    const { json } = headerOf(bytes);
    for (const kdf of [{ N: 2 ** 21 }, { r: 33 }, { p: 17 }, { N: 3000 }]) {
      const crafted = withHeader(bytes, { ...json, kdf: { ...(json.kdf as object), ...kdf } });
      expect(await refusal(openBundle(crafted, PASSPHRASE))).toBe(BUNDLE_MESSAGES.unsafeHeader);
    }
  });

  test("a file that doesn't match its checksum is refused (tampered and re-encrypted)", async () => {
    const files = bundleFiles(content);
    files.set(
      "people.jsonl",
      new TextEncoder().encode('{"ref":"per_1","email":"mallory@example.com"}\n'),
    );
    expect(await refusal(openBundle(await sealArchive(files, PASSPHRASE, FAST), PASSPHRASE))).toBe(
      BUNDLE_MESSAGES.checksum("people.jsonl"),
    );
  });

  test("a missing or unlisted file is refused", async () => {
    const missing = bundleFiles(content);
    missing.delete("workspaces.jsonl");
    expect(
      await refusal(openBundle(await sealArchive(missing, PASSPHRASE, FAST), PASSPHRASE)),
    ).toBe(BUNDLE_MESSAGES.missing("workspaces.jsonl"));
    const extra = bundleFiles(content);
    extra.set("evil.jsonl", new TextEncoder().encode("{}\n"));
    expect(await refusal(openBundle(await sealArchive(extra, PASSPHRASE, FAST), PASSPHRASE))).toBe(
      BUNDLE_MESSAGES.unlisted("evil.jsonl"),
    );
  });

  test("a newer bundle format is refused with the update instruction", async () => {
    const newer = await createBundle({ ...content, format: 2 }, PASSPHRASE, FAST);
    expect(await refusal(openBundle(newer, PASSPHRASE))).toBe(BUNDLE_MESSAGES.newerFormat(2));
    // A header that says 1 around a manifest that says 2 is refused too.
    const files = bundleFiles({ ...content, format: 2 });
    expect(await refusal(openBundle(await sealArchive(files, PASSPHRASE, FAST), PASSPHRASE))).toBe(
      BUNDLE_MESSAGES.newerFormat(2),
    );
  });

  test("something that isn't a bundle, and a bad line, are refused plainly", async () => {
    expect(
      await refusal(
        openBundle(
          new TextEncoder().encode("PK\u0003\u0004 a zip file, not an export"),
          PASSPHRASE,
        ),
      ),
    ).toBe(BUNDLE_MESSAGES.notBundle);
    const files = bundleFiles(content);
    const broken = new TextEncoder().encode('{"ref":"per_1"}\nnot json\n');
    files.set("people.jsonl", broken);
    const manifest = JSON.parse(new TextDecoder().decode(files.get("manifest.json")));
    const entry = manifest.files.find((item: { path: string }) => item.path === "people.jsonl");
    entry.sha256 = sha256Hex(broken);
    entry.bytes = broken.length;
    files.set("manifest.json", new TextEncoder().encode(JSON.stringify(manifest)));
    const bundle = await openBundle(await sealArchive(files, PASSPHRASE, FAST), PASSPHRASE);
    expect(() => bundleLines(bundle, "people.jsonl")).toThrow(
      BUNDLE_MESSAGES.badLine("people.jsonl", 2),
    );
  });
});
