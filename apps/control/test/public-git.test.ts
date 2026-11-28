import { describe, expect, test } from "bun:test";
import { AppError } from "@nearzero/shared";
import {
  advertisedDefaultBranch,
  BRANCH_UNRESOLVED,
  isBlockedHost,
  lookUpDefaultBranch,
} from "../src/sources/public-git.ts";

/** The default branch of a public repository URL (spec 6.1, punch list 27). */

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);

/** A pkt-line: four hex digits of length (including themselves), then the line. */
function pkt(line: string): string {
  return `${(line.length + 4).toString(16).padStart(4, "0")}${line}`;
}

function advertisement(lines: string[]): string {
  return `${pkt("# service=git-upload-pack\n")}0000${lines.map(pkt).join("")}0000`;
}

const DEVELOP = advertisement([
  `${SHA} HEAD\0multi_ack side-band-64k symref=HEAD:refs/heads/develop agent=git/2.45\n`,
  `${SHA} refs/heads/develop\n`,
  `${OTHER} refs/heads/main\n`,
]);

/** Every name resolves to one public address, except the ones a test names. */
const PUBLIC_IP = "93.184.215.14";
const resolveNames: Record<string, string[]> = {
  "169.254.169.254.nip.io": ["169.254.169.254"],
  "half.example.com": [PUBLIC_IP, "10.0.0.7"],
};
const fakeResolve = async (name: string) => resolveNames[name] ?? [PUBLIC_IP];

/**
 * A fake Git host. Requests arrive pinned to the checked address, with the hostname in the Host
 * header and the TLS server name, so routes are keyed by the URL as typed.
 */
function host(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const pinnedTo: string[] = [];
  const http = async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const headers = new Headers(init?.headers);
    pinnedTo.push(url.hostname);
    expect((init as { tls?: { serverName?: string } }).tls?.serverName).toBe(
      headers.get("host")?.split(":")[0],
    );
    url.host = headers.get("host") ?? url.host;
    calls.push(url.toString());
    expect(init?.redirect).toBe("manual");
    const route = routes[url.toString()];
    if (!route) throw new TypeError("fetch failed");
    return route();
  };
  return { http, calls, pinnedTo };
}

const look = (http: Parameters<typeof lookUpDefaultBranch>[0], url: string) =>
  lookUpDefaultBranch(http, url, fakeResolve);

const git = (body: string) => () =>
  new Response(body, {
    headers: { "content-type": "application/x-git-upload-pack-advertisement" },
  });

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error.message;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("default branch of a public repository", () => {
  test("reads HEAD's symref from the ref advertisement", () => {
    expect(advertisedDefaultBranch(new TextEncoder().encode(DEVELOP))).toBe("develop");
    // Old servers without symref: the branch at HEAD's commit, preferring main.
    const old = advertisement([
      `${SHA} HEAD\0multi_ack\n`,
      `${SHA} refs/heads/feature\n`,
      `${SHA} refs/heads/main\n`,
    ]);
    expect(advertisedDefaultBranch(new TextEncoder().encode(old))).toBe("main");
    expect(advertisedDefaultBranch(new TextEncoder().encode(advertisement([])))).toBeNull();
    expect(advertisedDefaultBranch(new TextEncoder().encode("<html>sign in</html>"))).toBeNull();
  });

  test("C1-14: a ref list over the 1 MiB cap is read up to the cut (gitlab-foss's is 5 MB)", async () => {
    const huge = advertisement([
      `${SHA} HEAD\0multi_ack side-band-64k symref=HEAD:refs/heads/master agent=git/2.45\n`,
      ...Array.from(
        { length: 40_000 },
        (_, n) => `${OTHER} refs/merge-requests/${n}/head-with-a-long-name\n`,
      ),
    ]);
    expect(huge.length).toBeGreaterThan(2 * 1024 * 1024);
    const { http } = host({
      "https://gitlab.com/gitlab-org/gitlab-foss/info/refs?service=git-upload-pack": git(huge),
    });
    expect(await look(http, "https://gitlab.com/gitlab-org/gitlab-foss")).toEqual({
      branch: "master",
      lookedUp: true,
    });
    // Cut in the middle of a line, the line before still counts.
    const bytes = new TextEncoder().encode(huge).subarray(0, 1024 * 1024);
    expect(advertisedDefaultBranch(bytes)).toBe("master");
  });

  test("asks the host over HTTPS, following its redirects", async () => {
    const { http, calls } = host({
      "https://git.example.com/acme/shop/info/refs?service=git-upload-pack": () =>
        new Response(null, {
          status: 301,
          headers: {
            location: "https://git.example.com/acme/shop.git/info/refs?service=git-upload-pack",
          },
        }),
      "https://git.example.com/acme/shop.git/info/refs?service=git-upload-pack": git(DEVELOP),
    });
    expect(await look(http, "https://git.example.com/acme/shop")).toEqual({
      branch: "develop",
      lookedUp: true,
    });
    expect(calls).toHaveLength(2);
  });

  test("an SSH address starts at main without asking", async () => {
    const { http, calls } = host({});
    expect(await look(http, "git@github.com:acme/shop.git")).toEqual({
      branch: "main",
      lookedUp: false,
    });
    expect(calls).toEqual([]);
  });

  test("a repository the host won't advertise can't be resolved", async () => {
    const missing = host({
      "https://github.com/acme/private/info/refs?service=git-upload-pack": () =>
        new Response("Repository not found.", { status: 401 }),
    });
    expect(await refusal(look(missing.http, "https://github.com/acme/private"))).toBe(
      BRANCH_UNRESOLVED,
    );
    const page = host({
      "https://example.com/acme/site/info/refs?service=git-upload-pack": () =>
        new Response("<html></html>", { headers: { "content-type": "text/html" } }),
    });
    expect(await refusal(look(page.http, "https://example.com/acme/site"))).toBe(BRANCH_UNRESOLVED);
    const down = host({});
    expect(await refusal(look(down.http, "https://gone.example.com/a/b"))).toBe(BRANCH_UNRESOLVED);
    expect(await refusal(look(down.http, "not a url"))).toBe(
      "Enter a valid public Git URL (HTTPS or git@host:owner/repo).",
    );
  });

  test("never goes to this machine or a private network, even through a redirect", async () => {
    for (const blocked of [
      "localhost",
      "127.0.0.1",
      "10.1.2.3",
      "169.254.169.254",
      "192.168.0.4",
      "::1",
      "fd00::1",
    ]) {
      expect(isBlockedHost(blocked)).toBe(true);
    }
    expect(isBlockedHost("github.com")).toBe(false);
    expect(isBlockedHost("140.82.112.3")).toBe(false);
    const sneaky = host({
      "https://git.example.com/acme/shop/info/refs?service=git-upload-pack": () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://127.0.0.1/acme/shop/info/refs?service=git-upload-pack" },
        }),
    });
    expect(await refusal(look(sneaky.http, "https://git.example.com/acme/shop"))).toBe(
      BRANCH_UNRESOLVED,
    );
    expect(sneaky.calls).toHaveLength(1);
  });

  test("B1-35: a name that resolves to a private address is refused; others are asked at the checked address", async () => {
    // The review's attack: a public-looking name for the cloud metadata address.
    const probe = host({});
    expect(
      await refusal(look(probe.http, "https://169.254.169.254.nip.io/latest/meta-data/x")),
    ).toBe(BRANCH_UNRESOLVED);
    // A name with one private address among public ones is refused too.
    expect(await refusal(look(probe.http, "https://half.example.com/acme/shop"))).toBe(
      BRANCH_UNRESOLVED,
    );
    expect(probe.calls).toEqual([]);
    const fine = host({
      "https://git.example.com/acme/shop/info/refs?service=git-upload-pack": git(DEVELOP),
    });
    expect(await look(fine.http, "https://git.example.com/acme/shop")).toEqual({
      branch: "develop",
      lookedUp: true,
    });
    expect(fine.pinnedTo).toEqual([PUBLIC_IP]);
  });
});
