import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { fetchRepository, httpAuthConfig } from "../src/sources/git.ts";

/**
 * Clones through a connected Git provider (spec 16, 6.5): the provider's short-lived credentials
 * reach git only as an Authorization header for the repository's own host, never in the URL,
 * never on disk, and never in anything printed. Checked against a real git smart-HTTP server
 * (git http-backend behind a small Basic-auth gate).
 */

const USER = "x-access-token";
const TOKEN = "ghs_very_secret_installation_token";

let root: string;
let server: Server<undefined>;
let commit = "";

async function run(
  argv: string[],
  cwd: string,
  input?: Uint8Array,
  env: Record<string, string> = {},
) {
  const proc = Bun.spawn(argv, {
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: root, ...env },
    stdin: input ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0 && !input) throw new Error(`${argv.join(" ")} failed: ${err}`);
  return new Uint8Array(out);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "nz-git-auth-"));
  const work = join(root, "work");
  await run(["git", "init", "--quiet", "-b", "main", work], root);
  await Bun.write(join(work, "index.html"), "<h1>hello</h1>\n");
  await run(["git", "add", "."], work);
  await run(
    [
      "git",
      "-c",
      "user.name=Test",
      "-c",
      "user.email=t@example.com",
      "commit",
      "--quiet",
      "-m",
      "First page",
    ],
    work,
  );
  commit = new TextDecoder().decode(await run(["git", "rev-parse", "HEAD"], work)).trim();
  await run(["git", "clone", "--quiet", "--bare", work, join(root, "repos", "app.git")], root);
  const expected = `Basic ${Buffer.from(`${USER}:${TOKEN}`).toString("base64")}`;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.headers.get("authorization") !== expected) {
        return new Response("auth required", {
          status: 401,
          headers: { "www-authenticate": 'Basic realm="git"' },
        });
      }
      const url = new URL(request.url);
      const body = new Uint8Array(await request.arrayBuffer());
      const output = await run(["git", "http-backend"], root, body, {
        GIT_PROJECT_ROOT: join(root, "repos"),
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: request.method,
        CONTENT_TYPE: request.headers.get("content-type") ?? "",
        CONTENT_LENGTH: String(body.length),
        GIT_PROTOCOL: request.headers.get("git-protocol") ?? "",
        REMOTE_USER: USER,
      });
      // CGI: headers, a blank line, then the body.
      let split = -1;
      for (let index = 0; index < output.length - 3; index++) {
        if (
          output[index] === 13 &&
          output[index + 1] === 10 &&
          output[index + 2] === 13 &&
          output[index + 3] === 10
        ) {
          split = index;
          break;
        }
      }
      const head = new TextDecoder().decode(output.slice(0, split));
      const headers = new Headers();
      let status = 200;
      for (const line of head.split("\r\n")) {
        const [name, ...rest] = line.split(":");
        if (!name) continue;
        if (name.toLowerCase() === "status") status = Number.parseInt(rest.join(":").trim(), 10);
        else headers.set(name, rest.join(":").trim());
      }
      return new Response(output.slice(split + 4), { status, headers });
    },
  });
});

afterAll(async () => {
  server?.stop(true);
  await rm(root, { recursive: true, force: true });
});

describe("cloning with a provider's credentials", () => {
  test("the header is scoped to the repository's host and the token is listed for redaction", () => {
    const config = httpAuthConfig("https://github.com/acme/web.git", {
      username: USER,
      password: TOKEN,
    });
    expect(config.env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraHeader");
    expect(config.env.GIT_CONFIG_VALUE_0).toStartWith("Authorization: Basic ");
    expect(config.secrets).toContain(TOKEN);
  });

  test("a private repository fetches with the header; nothing printed or stored holds the token", async () => {
    const folder = join(root, "service");
    const url = `http://127.0.0.1:${server.port}/app.git`;
    const printed: string[] = [];
    const fetched = await fetchRepository(
      { url, branch: "main", httpAuth: { username: USER, password: TOKEN }, submodules: false },
      {
        folder,
        home: join(root, "home"),
        signal: new AbortController().signal,
        onOutput: (text) => printed.push(text),
      },
    );
    expect(fetched.commit).toBe(commit);
    expect(fetched.subject).toBe("First page");
    expect(await readFile(join(folder, "source", "index.html"), "utf8")).toContain("hello");
    const log = printed.join("");
    expect(log).toContain(`from ${url}`);
    expect(log).not.toContain(TOKEN);
    expect(log).not.toContain(Buffer.from(`${USER}:${TOKEN}`).toString("base64"));
  });

  test("without the credentials the same fetch is refused", async () => {
    const url = `http://127.0.0.1:${server.port}/app.git`;
    await expect(
      fetchRepository(
        { url, branch: "main", submodules: false },
        {
          folder: join(root, "service-2"),
          home: join(root, "home"),
          signal: new AbortController().signal,
          onOutput: () => {},
        },
      ),
    ).rejects.toThrow("private or doesn't exist");
  });
});
