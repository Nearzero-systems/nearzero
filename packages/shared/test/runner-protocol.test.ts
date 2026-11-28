import { describe, expect, test } from "bun:test";
import {
  agreeProtocol,
  COMMAND_KINDS,
  capSlug,
  commandParamsSchemas,
  decodeChunk,
  encodeChunk,
  isRouteHostname,
  parseControlMessage,
  parseRunnerMessage,
  RUNNER_PROTOCOL_MIN_SUPPORTED,
  RUNNER_PROTOCOL_VERSION,
  STREAMING_COMMANDS,
  slugify,
} from "../src/index.ts";
import {
  isServerAddress,
  isSshUser,
  labelCandidates,
  privateKeyBlockKind,
  publicKeyLineType,
  serverLabelBase,
} from "../src/servers.ts";

/** The runner protocol's rules both ends share (docs/runner-protocol.md). */

describe("the version window", () => {
  test("the newest protocol both ends speak is used", () => {
    expect(
      agreeProtocol(
        { protocol: 3, minProtocol: 1, version: "1.2.0" },
        { protocol: 2, minSupported: 1 },
      ),
    ).toEqual({
      ok: true,
      protocol: 2,
    });
  });

  test("a runner older than the window is told to update", () => {
    const result = agreeProtocol(
      { protocol: 1, minProtocol: 1, version: "1.0.0" },
      { protocol: 3, minSupported: 2 },
    );
    expect(result).toMatchObject({ ok: false, reason: "runner_outdated" });
    // Only what exists: Run setup again (G3-05).
    if (!result.ok) {
      expect(result.message).toBe(
        "This server's runner (version 1.0.0, protocol 1) is older than this Nearzero supports (protocol 2 or newer). Run setup again on the server's page to update it.",
      );
      expect(result.message).not.toContain("Update runner");
    }
  });

  test("a runner that needs a newer control plane says so", () => {
    const result = agreeProtocol({ protocol: 4, minProtocol: 4, version: "2.0.0" });
    expect(result).toMatchObject({ ok: false, reason: "control_outdated" });
    if (!result.ok) expect(result.message).toContain("running the install command again");
  });

  test("this build accepts itself", () => {
    expect(
      agreeProtocol({
        protocol: RUNNER_PROTOCOL_VERSION,
        minProtocol: RUNNER_PROTOCOL_MIN_SUPPORTED,
        version: "x",
      }).ok,
    ).toBe(true);
  });
});

describe("messages", () => {
  test("valid frames parse; anything else is refused", () => {
    expect(parseRunnerMessage('{"type":"heartbeat","seq":1,"at":5}')).toEqual({
      type: "heartbeat",
      seq: 1,
      at: 5,
    });
    expect(
      parseRunnerMessage('{"type":"result","commandId":"c","ok":true,"data":{"a":1}}'),
    ).toMatchObject({
      ok: true,
    });
    expect(parseRunnerMessage("not json")).toBeNull();
    expect(
      parseRunnerMessage('{"type":"stream.data","streamId":"s","offset":-1,"data":""}'),
    ).toBeNull();
    expect(
      parseRunnerMessage('{"type":"stream.data","streamId":"s","offset":0,"data":"not base64!"}'),
    ).toBeNull();
    expect(parseRunnerMessage('{"type":"nope"}')).toBeNull();
    expect(parseControlMessage('{"type":"stream.ack","streamId":"s","offset":12}')).toEqual({
      type: "stream.ack",
      streamId: "s",
      offset: 12,
    });
    expect(
      parseControlMessage('{"type":"stream.resize","streamId":"s","cols":0,"rows":10}'),
    ).toBeNull();
  });

  test("unknown fields are ignored, so either side can add optional ones", () => {
    expect(parseControlMessage('{"type":"heartbeat.ack","seq":2,"later":"field"}')).toEqual({
      type: "heartbeat.ack",
      seq: 2,
    });
  });

  test("stream bytes survive the trip through base64", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 10]);
    expect(decodeChunk(encodeChunk(bytes))).toEqual(bytes);
  });

  test("every command has a parameter schema, and streaming ones are known commands", () => {
    for (const kind of STREAMING_COMMANDS) expect(COMMAND_KINDS).toContain(kind);
    expect(commandParamsSchemas["container.logs"].parse({ id: "web" })).toEqual({
      id: "web",
      follow: true,
      tail: 200,
      timestamps: false,
    });
    expect(
      commandParamsSchemas["container.exec"].safeParse({ id: "web", command: [] }).success,
    ).toBe(false);
  });

  test("route hostnames are plain DNS names", () => {
    expect(isRouteHostname("a-b.example.com")).toBe(true);
    for (const bad of ["", "a`b.com", "a b", "-x.com", "x-.com", `${"a".repeat(64)}.com`]) {
      expect(isRouteHostname(bad)).toBe(false);
    }
  });
});

describe("server fields (spec 9.2, 10.2)", () => {
  test("addresses are an IP or a hostname, nothing more", () => {
    for (const ok of ["203.0.113.10", "2001:db8::1", "server.example.com", "localhost"]) {
      expect(isServerAddress(ok)).toBe(true);
    }
    for (const bad of ["https://x.com", "x.com/path", "x.com:22", "a b", "999.1.1.1", ""]) {
      expect(isServerAddress(bad)).toBe(false);
    }
  });

  test("SSH users start with a letter or _ and stay within 32 characters", () => {
    expect(isSshUser("ec2-user")).toBe(true);
    expect(isSshUser("_svc")).toBe(true);
    expect(isSshUser("1root")).toBe(false);
    expect(isSshUser("a".repeat(33))).toBe(false);
  });

  test("labels: a slug of the name, server- before a digit, at most 40, -2 on a clash", () => {
    expect(serverLabelBase("Prod 1 (EU)")).toBe("prod-1-eu");
    expect(serverLabelBase("0x1f")).toBe("server-0x1f");
    expect(serverLabelBase("Ünïcode Box")).toBe("unicode-box");
    expect(serverLabelBase("!!!")).toBe("server");
    expect(serverLabelBase("a".repeat(60))).toHaveLength(40);
    const candidates = labelCandidates("a".repeat(40));
    expect(candidates.next().value).toBe("a".repeat(40));
    expect(candidates.next().value).toBe(`${"a".repeat(38)}-2`);
  });

  test("key formats: one public line, one private block", () => {
    expect(publicKeyLineType("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA== me")).toBe("ed25519");
    expect(publicKeyLineType("ssh-rsa AAAAB3Nza")).toBe("rsa");
    expect(publicKeyLineType("ssh-ed25519 AAAA\nssh-rsa AAAA")).toBeNull();
    expect(
      privateKeyBlockKind(
        "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----",
      ),
    ).toBe("openssh");
    expect(
      privateKeyBlockKind("-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n"),
    ).toBe("rsa");
    expect(
      privateKeyBlockKind("-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----"),
    ).toBeNull();
  });
});

describe("the shared slug rule", () => {
  test("one pass: accents dropped, other characters become single dashes, none at the ends", () => {
    expect(slugify("  Café  Ünïcode -- Team ")).toBe("cafe-unicode-team");
    expect(slugify("İstanbul ﬁles")).toBe("istanbul-files");
    expect(slugify("!!!")).toBe("");
    expect(slugify(`${"a".repeat(47)} b`, 48)).toBe("a".repeat(47));
    expect(capSlug("abc-def", 4)).toBe("abc");
  });
});

describe("where a welcome may send a runner (spec 31, C4-04, C4-06, C4-10)", () => {
  const base = {
    type: "welcome",
    protocol: 1,
    controlVersion: "1.0.0",
    serverId: "s1",
    serverName: "one",
    publicIPv4: null,
    heartbeatIntervalMs: 10_000,
    resume: [],
    close: [],
    received: [],
  };
  const pin = "a".repeat(64);

  test("a move only to a pinned address, or to a host name checked by a public authority", () => {
    // probe-schema: all four were accepted before.
    for (const link of [
      { url: "http://203.0.113.66:80", fingerprint: null },
      { url: "http://203.0.113.66", fingerprint: pin },
      { url: "https://203.0.113.66:3443", fingerprint: null },
      { url: "https://[2001:db8::66]", fingerprint: null },
      // Other spellings of an IP address (recheck-schema), as the runner's own check reads them.
      { url: "https://2130706433:3443", fingerprint: null },
      { url: "https://0x7f.1", fingerprint: null },
      { url: "https://127.1", fingerprint: null },
      { url: "https://1.2.3.4.", fingerprint: null },
      { url: "https://0177.0.0.1", fingerprint: null },
      { url: "https://[::ffff:127.0.0.1]", fingerprint: null },
    ]) {
      expect([link, parseControlMessage(JSON.stringify({ ...base, link }))]).toEqual([link, null]);
    }
    for (const link of [
      { url: "https://203.0.113.66:3443", fingerprint: pin },
      { url: "https://nz.example.com", fingerprint: null },
    ]) {
      expect(parseControlMessage(JSON.stringify({ ...base, link }))).toMatchObject({ link });
    }
  });

  test("the fallback is always pinned, and the next fingerprint is a fingerprint", () => {
    const fallback = { url: "https://203.0.113.66:3443", fingerprint: pin };
    expect(
      parseControlMessage(JSON.stringify({ ...base, fallback, nextFingerprint: "b".repeat(64) })),
    ).toMatchObject({ fallback, nextFingerprint: "b".repeat(64) });
    for (const extra of [
      { fallback: { url: "https://203.0.113.66:3443", fingerprint: null } },
      { fallback: { url: "http://203.0.113.66:3000", fingerprint: pin } },
      { nextFingerprint: "nope" },
    ]) {
      expect(parseControlMessage(JSON.stringify({ ...base, ...extra }))).toBeNull();
    }
    expect(
      parseRunnerMessage(JSON.stringify({ type: "heartbeat", seq: 1, at: 1, next: pin })),
    ).toMatchObject({ next: pin });
    expect(
      parseRunnerMessage(JSON.stringify({ type: "heartbeat", seq: 1, at: 1, next: "x" })),
    ).toBeNull();
  });
});
