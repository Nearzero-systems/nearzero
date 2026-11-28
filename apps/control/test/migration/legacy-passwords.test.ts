import { describe, expect, test } from "bun:test";
import { scryptSync } from "node:crypto";
import {
  isLegacyHash,
  LEGACY_HASH_PREFIX,
  parseLegacyPassword,
  verifyLegacyPassword,
} from "../../src/security/legacy-passwords.ts";
import { PasswordHasher, TEST_HASHING } from "../../src/security/passwords.ts";
import { scryptDeclared, scryptPhc } from "./fixture.ts";

/** Password hashes carried over from 0.1.x (spec 29.5 "Identity"). */

function stored(declaration: Parameters<typeof parseLegacyPassword>[0]): string {
  const parsed = parseLegacyPassword(declaration);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.stored;
}

describe("scrypt", () => {
  test("RFC 7914's test vector as a PHC string", async () => {
    // scrypt("password", "NaCl", N=1024, r=8, p=16, 64 bytes), from RFC 7914 section 12.
    const key = Buffer.from(
      "fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b3731622eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640",
      "hex",
    );
    const phc = `$scrypt$ln=10,r=8,p=16$${Buffer.from("NaCl").toString("base64").replace(/=+$/, "")}$${key.toString("base64").replace(/=+$/, "")}`;
    const hash = stored({ algorithm: "scrypt", hash: phc });
    expect(hash.startsWith(LEGACY_HASH_PREFIX)).toBe(true);
    expect(await verifyLegacyPassword("password", hash)).toBe(true);
    expect(await verifyLegacyPassword("Password", hash)).toBe(false);
  });

  test("a PHC string made here", async () => {
    const hash = stored({ algorithm: "scrypt", hash: scryptPhc("hunter2-hunter2") });
    expect(await verifyLegacyPassword("hunter2-hunter2", hash)).toBe(true);
    expect(await verifyLegacyPassword("hunter2", hash)).toBe(false);
  });

  test("salt:key with declared parameters as spec 29a gives them (NFKC, the salt text as bytes)", async () => {
    const declared = scryptDeclared("pässword-ﬁne");
    const hash = stored({
      algorithm: declared.algorithm,
      hash: declared.encoded,
      parameters: declared.params,
    });
    expect(await verifyLegacyPassword("pässword-ﬁne", hash)).toBe(true);
    // NFKC turns the ligature into "fi", as the 0.1.x side did when it hashed.
    expect(await verifyLegacyPassword("pässword-fine", hash)).toBe(true);
    expect(await verifyLegacyPassword("password-fine", hash)).toBe(false);
  });

  test("salt:key with a hex salt and a base64 key", async () => {
    const salt = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    const key = scryptSync("open sesame", salt, 32, { N: 16384, r: 8, p: 1 });
    const hash = stored({
      algorithm: "scrypt",
      hash: `${salt.toString("hex")}:${key.toString("base64")}`,
      parameters: { N: 16384, r: 8, p: 1, saltEncoding: "hex", keyEncoding: "base64" },
    });
    expect(await verifyLegacyPassword("open sesame", hash)).toBe(true);
  });

  test("scrypt:N:r:p$salt$hexkey", async () => {
    const key = scryptSync("letmein-please", "saltysalt", 64, { N: 16384, r: 8, p: 1 });
    const hash = stored({
      algorithm: "scrypt",
      hash: `scrypt:16384:8:1$saltysalt$${key.toString("hex")}`,
    });
    expect(await verifyLegacyPassword("letmein-please", hash)).toBe(true);
  });

  test("unusable declarations say why", () => {
    expect(parseLegacyPassword({ algorithm: "scrypt", hash: "abc:def" })).toEqual({
      ok: false,
      reason: "its scrypt parameters (N, r and p) are missing",
    });
    expect(
      parseLegacyPassword({
        algorithm: "scrypt",
        hash: "$scrypt$ln=40,r=8,p=1$c2FsdA$a2V5a2V5a2V5a2V5a2V5",
      }),
    ).toEqual({
      ok: false,
      reason: "its scrypt cost (N) isn't usable",
    });
    expect(
      parseLegacyPassword({ algorithm: "md5", hash: "5f4dcc3b5aa765d61d8327deb882cf99" }),
    ).toEqual({
      ok: false,
      reason: "its algorithm (md5) isn't one Nearzero can check",
    });
  });
});

describe("bcrypt and argon2", () => {
  test("$2b$, $2a$ and $2y$ hashes", async () => {
    const made = await Bun.password.hash("correct-horse", { algorithm: "bcrypt", cost: 4 });
    for (const variant of [made, made.replace("$2b$", "$2a$"), made.replace("$2b$", "$2y$")]) {
      const hash = stored({ algorithm: "bcrypt", hash: variant });
      expect(await verifyLegacyPassword("correct-horse", hash)).toBe(true);
      expect(await verifyLegacyPassword("correct-horsE", hash)).toBe(false);
    }
  });

  test("bcrypt reads the first 72 bytes, as other implementations do", async () => {
    const long = "x".repeat(72);
    const made = await Bun.password.hash(long, { algorithm: "bcrypt", cost: 4 });
    const hash = stored({ algorithm: "bcrypt", hash: made });
    expect(await verifyLegacyPassword(`${long}and-more`, hash)).toBe(true);
  });

  test("argon2 PHC strings", async () => {
    const made = await Bun.password.hash("argon-pass", {
      algorithm: "argon2i",
      memoryCost: 1024,
      timeCost: 1,
    });
    const hash = stored({ algorithm: "argon2", hash: made });
    expect(await verifyLegacyPassword("argon-pass", hash)).toBe(true);
    expect(await verifyLegacyPassword("argon-fail", hash)).toBe(false);
  });

  test("a damaged stored value never matches", async () => {
    expect(await verifyLegacyPassword("x", `${LEGACY_HASH_PREFIX}not-json`)).toBe(false);
  });
});

describe("PasswordHasher", () => {
  test("checks legacy hashes and asks for a re-hash; argon2id hashes don't need one", async () => {
    const hasher = new PasswordHasher(TEST_HASHING);
    const legacy = stored({ algorithm: "scrypt", hash: scryptPhc("old-and-good") });
    expect(await hasher.verify("old-and-good", legacy)).toBe(true);
    expect(await hasher.verify("old-and-bad!", legacy)).toBe(false);
    expect(hasher.needsRehash(legacy)).toBe(true);
    const fresh = await hasher.hash("old-and-good");
    expect(hasher.needsRehash(fresh)).toBe(false);
    expect(isLegacyHash(fresh)).toBe(false);
    expect(await hasher.verify("old-and-good", fresh)).toBe(true);
  });
});
