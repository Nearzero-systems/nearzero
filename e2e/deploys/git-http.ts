/**
 * A Git server over HTTP for the deploy suite, run inside the Docker-in-Docker host: it hands
 * each request to `git http-backend` (Git's own smart HTTP program, as CGI) for the bare
 * repositories under a folder, so the runner clones the way it would from any Git host.
 *
 *   git-http <repositories folder> <port>
 */

const root = process.argv[2] ?? "/srv/git";
const port = Number(process.argv[3] ?? "8081");

function headerEnd(bytes: Uint8Array): { at: number; length: number } | null {
  for (let index = 0; index < bytes.length - 1; index++) {
    if (bytes[index] === 10 && bytes[index + 1] === 10) return { at: index, length: 2 };
    if (
      bytes[index] === 13 &&
      bytes[index + 1] === 10 &&
      bytes[index + 2] === 13 &&
      bytes[index + 3] === 10
    ) {
      return { at: index, length: 4 };
    }
  }
  return null;
}

Bun.serve({
  hostname: "0.0.0.0",
  port,
  async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === "POST" ? new Uint8Array(await request.arrayBuffer()) : null;
    const child = Bun.spawn(["git", "http-backend"], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: request.method,
        CONTENT_TYPE: request.headers.get("content-type") ?? "",
        CONTENT_LENGTH: String(body?.length ?? 0),
        HTTP_CONTENT_ENCODING: request.headers.get("content-encoding") ?? "",
        GIT_PROTOCOL: request.headers.get("git-protocol") ?? "",
        REMOTE_ADDR: "127.0.0.1",
        SERVER_PROTOCOL: "HTTP/1.1",
      },
      stdin: body ? new Blob([body]) : "ignore",
      stdout: "pipe",
      stderr: "inherit",
    });
    const out = new Uint8Array(await new Response(child.stdout).arrayBuffer());
    await child.exited;
    const end = headerEnd(out);
    if (!end) return new Response("git http-backend gave no answer", { status: 500 });
    const headers = new Headers();
    let status = 200;
    for (const line of new TextDecoder().decode(out.subarray(0, end.at)).split(/\r?\n/)) {
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const name = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]) || 200;
      else headers.append(name, value);
    }
    return new Response(out.subarray(end.at + end.length), { status, headers });
  },
});
console.error(`serving ${root} on ${port}`);
