import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, createHarness, type Harness, setUpNamedOwner } from "./support/harness.ts";

/**
 * B1-36: a malformed id is a refusal in the platform's words (400 or 404), never an unexplained
 * internal error (spec 23.8), on every parameterized GET and DELETE route of the API.
 */

setDefaultTimeout(240_000);

let h: Harness;
let owner: Browser;

beforeAll(async () => {
  h = await createHarness();
  owner = await setUpNamedOwner(h);
});

afterAll(async () => {
  await h.drop();
});

/** Every `app.get`/`app.delete` path with a parameter, read from the route files themselves. */
async function parameterizedRoutes(): Promise<{ method: string; path: string }[]> {
  const root = join(import.meta.dir, "..", "src");
  const files: string[] = [];
  for (const entry of await readdir(root, { recursive: true })) {
    if (entry.endsWith(".ts")) files.push(join(root, entry));
  }
  const routes = new Map<string, { method: string; path: string }>();
  for (const file of files) {
    const text = await Bun.file(file).text();
    for (const match of text.matchAll(/app\.(get|delete)\("([^"]*:[A-Za-z]+[^"]*)"/g)) {
      const method = (match[1] as string).toUpperCase();
      const path = (match[2] as string).replace(/:[A-Za-z]+/g, "not-a-uuid");
      routes.set(`${method} ${path}`, { method, path });
    }
  }
  return [...routes.values()];
}

describe("malformed ids (B1-36)", () => {
  test("the two that answered 500 now say what's wrong", async () => {
    const listed = await owner.get("/deployments?serviceId=not-a-uuid");
    expect(listed.status).toBe(400);
    expect(listed.body.error.fields.serviceId).toBe(
      "That isn't a service's id. Choose the service from the list.",
    );
    const removed = await owner.delete("/servers/not-a-uuid");
    expect(removed.status).toBe(404);
  });

  test("no parameterized GET or DELETE route answers 500 for a malformed id", async () => {
    const routes = await parameterizedRoutes();
    expect(routes.length).toBeGreaterThan(60);
    const internal: string[] = [];
    for (const route of routes) {
      // Streams and terminals answer before streaming; give each a moment at most.
      const reply = await Promise.race([
        owner.request(route.method, route.path),
        Bun.sleep(15_000).then(() => null),
      ]);
      if (reply && reply.status >= 500)
        internal.push(`${route.method} ${route.path} → ${reply.status}`);
    }
    expect(internal).toEqual([]);
  });
});
