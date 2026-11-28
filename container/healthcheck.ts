/**
 * The image's health check: the API must report "ok" on /api/v1/health and the console must
 * answer its own health path through to the API. Exit 0 when both do, 1 otherwise.
 */

const TIMEOUT_MS = 4_000;

async function ok(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) return false;
    const body = (await response.json()) as { status?: unknown };
    return body.status === "ok";
  } catch {
    return false;
  }
}

if (import.meta.main) {
  const results = await Promise.all([
    ok("http://127.0.0.1:3000/api/v1/health"),
    ok("http://127.0.0.1:4321/api/v1/health"),
  ]);
  process.exit(results.every(Boolean) ? 0 : 1);
}
