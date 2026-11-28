import { describe, expect, test } from "bun:test";
import { isTrustedPeer } from "../src/http/client.ts";
import { isRealName, splitFullName } from "../src/identity/names.ts";
import { newBackupCodes, normalizeBackupCode } from "../src/identity/two-factor.ts";
import { PasswordHasher, TEST_HASHING } from "../src/security/passwords.ts";
import { SecretBox } from "../src/security/secret-box.ts";
import { constantTimeEqual, readableCode } from "../src/security/tokens.ts";
import {
  base32Decode,
  base32Encode,
  matchTotp,
  otpauthUri,
  totpCode,
  totpStep,
} from "../src/security/totp.ts";
import { RESERVED_SLUGS, slugFromName } from "../src/workspaces/slugs.ts";

const SECRET_A = "4f1c9a0be27d83c6a5f04e19b7d2c8a3e6f5b1d09c4a7e2f8b3d6c1a5e9f0b47";
const SECRET_B = "9e2b7c41d0f8a3e6b5c4d2a1f0e9d8c7b6a5f4e3d2c1b0a99e2b7c41d0f8a3e6";

describe("the secret box (encryption at rest, spec 23.4)", () => {
  test("opens what it sealed, for the same context only", () => {
    const box = new SecretBox(SECRET_A);
    const sealed = box.seal("sk-or-v1-abcdef", "workspace:1:model-key");
    expect(sealed).not.toContain("abcdef");
    expect(sealed.startsWith("nzs1.")).toBe(true);
    expect(box.open(sealed, "workspace:1:model-key")).toEqual({
      ok: true,
      value: "sk-or-v1-abcdef",
    });
    expect(box.open(sealed, "workspace:2:model-key")).toEqual({ ok: false, reason: "damaged" });
  });

  test("two seals of one value differ", () => {
    const box = new SecretBox(SECRET_A);
    expect(box.seal("same", "c")).not.toBe(box.seal("same", "c"));
  });

  test("a value sealed under another install secret says the key changed", () => {
    const sealed = new SecretBox(SECRET_A).seal("re_123", "ctx");
    expect(new SecretBox(SECRET_B).open(sealed, "ctx")).toEqual({
      ok: false,
      reason: "key_changed",
    });
  });

  test("tampering is detected", () => {
    const box = new SecretBox(SECRET_A);
    const sealed = box.seal("value", "ctx");
    const parts = sealed.split(".");
    const body = Buffer.from(parts[3] ?? "", "base64url");
    body[0] = (body[0] ?? 0) ^ 1;
    parts[3] = body.toString("base64url");
    expect(box.open(parts.join("."), "ctx")).toEqual({ ok: false, reason: "damaged" });
    expect(box.open("not a sealed value", "ctx")).toEqual({ ok: false, reason: "damaged" });
  });
});

describe("tokens and comparisons (spec 22.4, rule 7)", () => {
  test("constant-time comparison answers like ===", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });

  test("readable codes use only unambiguous characters", () => {
    for (let i = 0; i < 50; i++) expect(readableCode(12)).toMatch(/^[a-hjkmnp-z2-9]{12}$/);
  });
});

describe("one-time codes (RFC 6238)", () => {
  // RFC 6238 appendix B, SHA-1 secret "12345678901234567890"; 6-digit codes are the last 6 digits.
  const rfcSecret = base32Encode(Buffer.from("12345678901234567890", "ascii"));
  const vectors: [number, string][] = [
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
  ];

  for (const [seconds, code] of vectors) {
    test(`matches the RFC test vector at T=${seconds}`, () => {
      expect(totpCode(rfcSecret, totpStep(seconds * 1000))).toBe(code);
    });
  }

  test("base32 round-trips", () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 7]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    expect(rfcSecret).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  });

  test("accepts one step of drift and refuses a code used before", () => {
    const now = 1_700_000_000_000;
    const step = totpStep(now);
    const previous = totpCode(rfcSecret, step - 1);
    expect(matchTotp(rfcSecret, previous, now, null)).toBe(step - 1);
    expect(matchTotp(rfcSecret, previous, now, step - 1)).toBeNull();
    expect(matchTotp(rfcSecret, totpCode(rfcSecret, step - 3), now, null)).toBeNull();
    expect(matchTotp(rfcSecret, "12345", now, null)).toBeNull();
  });

  test("the otpauth link names the issuer and account", () => {
    const uri = otpauthUri("ABC", "ada@example.com", "Nearzero");
    expect(uri).toStartWith("otpauth://totp/Nearzero:ada%40example.com?");
    expect(uri).toContain("secret=ABC");
    expect(uri).toContain("issuer=Nearzero");
  });
});

describe("backup codes", () => {
  test("ten codes shaped xxxxx-xxxxx, all different", () => {
    const codes = newBackupCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[a-z0-9]{5}-[a-z0-9]{5}$/);
  });

  test("typed codes are read with or without the dash and in any case", () => {
    expect(normalizeBackupCode(" ABCDE-fghjk ")).toBe("abcde-fghjk");
    expect(normalizeBackupCode("abcdefghjk")).toBe("abcde-fghjk");
    expect(normalizeBackupCode("abc")).toBeNull();
  });
});

describe("passwords (argon2id)", () => {
  test("hashes with argon2id and verifies", async () => {
    const hasher = new PasswordHasher(TEST_HASHING);
    const hash = await hasher.hash("correct horse");
    expect(hash).toStartWith("$argon2id$");
    expect(await hasher.verify("correct horse", hash)).toBe(true);
    expect(await hasher.verify("wrong horse", hash)).toBe(false);
    expect(await hasher.verify("anything", null)).toBe(false);
    expect(await hasher.verify("anything", "not a hash")).toBe(false);
  });
});

describe("names (spec 04 4.3)", () => {
  test("email-derived names never count as real names", () => {
    expect(isRealName("Ada")).toBe(true);
    expect(isRealName("Mary Jane")).toBe(true);
    expect(isRealName("O'Brien")).toBe(true);
    expect(isRealName("")).toBe(false);
    expect(isRealName(null)).toBe(false);
    expect(isRealName("john1984")).toBe(false);
    expect(isRealName("admin")).toBe(false);
    expect(isRealName("Owner")).toBe(false);
    expect(isRealName("root")).toBe(false);
    expect(isRealName("johnsmithdevops")).toBe(false);
    expect(isRealName("ada@example.com")).toBe(false);
  });

  test("a full name splits into first and last", () => {
    expect(splitFullName("  Ada   King Lovelace ")).toEqual({
      firstName: "Ada",
      lastName: "King Lovelace",
    });
    expect(splitFullName("Cher")).toEqual({ firstName: "Cher", lastName: "" });
  });
});

describe("workspace slugs (spec 04 4.4)", () => {
  test("lowercase, dashes for other characters, at most 48 characters", () => {
    expect(slugFromName("Acme Inc.")).toBe("acme-inc");
    expect(slugFromName("  Café  Ünïcode -- Team ")).toBe("cafe-unicode-team");
    expect(slugFromName("x".repeat(60))).toHaveLength(48);
    expect(slugFromName(`${"a".repeat(47)} b`)).toBe("a".repeat(47));
    expect(slugFromName("!!!")).toBe("");
  });

  test("accents are dropped from letters", () => {
    expect(slugFromName("Ångström Équipe")).toBe("angstrom-equipe");
    expect(slugFromName("Ñandú Café")).toBe("nandu-cafe");
    expect(slugFromName("Crème Brûlée 2026")).toBe("creme-brulee-2026");
  });

  test("a run of symbols or spaces becomes one dash", () => {
    expect(slugFromName("Hello!!__World")).toBe("hello-world");
    expect(slugFromName("a   b...c///d")).toBe("a-b-c-d");
    expect(slugFromName("Team — Ops & Infra")).toBe("team-ops-infra");
  });

  test("separators at either end leave no dash", () => {
    expect(slugFromName("--Hello World--")).toBe("hello-world");
    expect(slugFromName("  ***Top***  ")).toBe("top");
    expect(slugFromName(".acme.")).toBe("acme");
    expect(slugFromName(`${"a".repeat(46)} b c`)).toBe(`${"a".repeat(46)}-b`);
  });

  test("console words are reserved", () => {
    expect(RESERVED_SLUGS.has("dashboard")).toBe(true);
    expect(RESERVED_SLUGS.has("api")).toBe(true);
  });
});

describe("trusted proxies", () => {
  test("exact addresses, mapped IPv4 and IPv4 ranges", () => {
    const trusted = ["127.0.0.1", "::1", "10.0.0.0/8"];
    expect(isTrustedPeer("127.0.0.1", trusted)).toBe(true);
    expect(isTrustedPeer("::ffff:127.0.0.1", trusted)).toBe(true);
    expect(isTrustedPeer("::1", trusted)).toBe(true);
    expect(isTrustedPeer("10.20.30.40", trusted)).toBe(true);
    expect(isTrustedPeer("11.0.0.1", trusted)).toBe(false);
    expect(isTrustedPeer("203.0.113.9", trusted)).toBe(false);
  });
});
