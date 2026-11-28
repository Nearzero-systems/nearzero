import { describe, expect, test } from "bun:test";
import { routerStoreFrom } from "../../src/migration/acme.ts";
import { selfSigned } from "./support.ts";

/** A server's certificate authority state from the bundle, as the 1.0 router's store (spec 29.5). */

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

describe("routerStoreFrom", () => {
  test("the bundle's shape and a router store both become one resolver's store", async () => {
    const issued = await selfSigned(["a.example.com", "b.example.com"]);
    const own = routerStoreFrom({
      account: {
        email: "x@example.com",
        registration: { uri: "https://acme/1" },
        privateKey: "KEY",
      },
      // Plain PEM is accepted as well as base64 of it.
      certificates: [
        { domain: { main: "a.example.com" }, certificate: issued.certificate, key: issued.key },
      ],
    });
    expect(own.ok).toBe(true);
    if (!own.ok) return;
    expect(own.certificates).toBe(1);
    expect(own.store.letsencrypt.Account).toEqual({
      Email: "x@example.com",
      Registration: { uri: "https://acme/1" },
      PrivateKey: "KEY",
      KeyType: "4096",
    });
    const certificate = own.store.letsencrypt.Certificates[0];
    // Names the certificate covers besides the main one are read from it.
    expect(certificate?.domain).toEqual({ main: "a.example.com", sans: ["b.example.com"] });
    expect(Buffer.from(certificate?.certificate ?? "", "base64").toString()).toContain(
      "BEGIN CERTIFICATE",
    );
    expect(certificate?.Store).toBe("default");

    const traefik = routerStoreFrom({
      le: {
        Account: {
          Email: "y@example.com",
          Registration: { uri: "https://acme/2" },
          PrivateKey: "K2",
          KeyType: "EC256",
        },
        Certificates: [
          {
            domain: { main: "a.example.com", sans: ["b.example.com"] },
            certificate: b64(issued.certificate),
            key: b64(issued.key),
            Store: "default",
          },
          {
            domain: { main: "a.example.com" },
            certificate: b64(issued.certificate),
            key: b64(issued.key),
          },
          { domain: { main: "bad.example.com" }, certificate: "bm9wZQ==", key: "bm9wZQ==" },
        ],
      },
    });
    expect(traefik).toMatchObject({ ok: true, certificates: 1, skipped: 2 });
    if (traefik.ok)
      expect(traefik.store.letsencrypt.Certificates[0]?.domain).toEqual({
        main: "a.example.com",
        sans: ["b.example.com"],
      });
  });

  test("nothing usable is refused with a reason", () => {
    expect(routerStoreFrom("x")).toEqual({ ok: false, reason: "it isn't a JSON object" });
    expect(routerStoreFrom({ certificates: [] })).toEqual({
      ok: false,
      reason: "it holds no certificate authority account and no certificates",
    });
  });
});
