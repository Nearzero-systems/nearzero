import type { HttpFetch } from "../services.ts";

/**
 * Web search and page reading through Firecrawl's public API (spec 19.10, 20.13), with the
 * workspace's own key. Limits: 1 to 10 results (default 5), queries up to 500 characters, pages
 * as text cut at 10,000 characters, http and https only. Refusals are explained in plain words.
 */

export const RESEARCH_LIMITS = {
  resultsDefault: 5,
  resultsMax: 10,
  queryMax: 500,
  pageMax: 10_000,
} as const;

export class ResearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResearchError";
  }
}

function explain(status: number): ResearchError {
  if (status === 401 || status === 403) {
    return new ResearchError(
      "Firecrawl rejected the workspace's research key. An owner or admin can add a new one in Settings → API keys.",
    );
  }
  if (status === 402) {
    return new ResearchError(
      "The workspace's Firecrawl account has no credits left. Add credits at firecrawl.dev.",
    );
  }
  if (status === 429)
    return new ResearchError("Firecrawl is limiting requests right now. Try again in a minute.");
  return new ResearchError(
    `Firecrawl couldn't do this right now (it answered ${status}). Try again later.`,
  );
}

async function post(
  fetch: HttpFetch,
  base: string,
  key: string,
  path: string,
  body: unknown,
  signal: AbortSignal,
) {
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
    });
  } catch (error) {
    if (signal.aborted) throw new ResearchError("Stopped.");
    throw new ResearchError(
      `Firecrawl couldn't be reached: ${(error as Error).message}. Try again later.`,
    );
  }
  if (!response.ok) throw explain(response.status);
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

export interface SearchResult {
  title: string;
  url: string;
  description: string;
}

export async function searchWeb(
  fetch: HttpFetch,
  base: string,
  key: string,
  query: string,
  limit: number,
  signal: AbortSignal,
): Promise<SearchResult[]> {
  const body = await post(
    fetch,
    base,
    key,
    "/v1/search",
    { query: query.slice(0, RESEARCH_LIMITS.queryMax), limit },
    signal,
  );
  const data = Array.isArray(body.data) ? (body.data as Record<string, unknown>[]) : [];
  return data.slice(0, limit).map((item) => ({
    title: String(item.title ?? ""),
    url: String(item.url ?? ""),
    description: String(item.description ?? "").slice(0, 500),
  }));
}

export function pageUrlProblem(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "That isn't a valid web address.";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return "Only http and https pages can be read.";
  if (parsed.username || parsed.password)
    return "Addresses with a user name or password aren't read.";
  return null;
}

export async function readPage(
  fetch: HttpFetch,
  base: string,
  key: string,
  url: string,
  signal: AbortSignal,
): Promise<{ title: string; url: string; text: string; cut: boolean }> {
  const problem = pageUrlProblem(url);
  if (problem) throw new ResearchError(problem);
  const body = await post(
    fetch,
    base,
    key,
    "/v1/scrape",
    { url, formats: ["markdown"], onlyMainContent: true },
    signal,
  );
  const data = (body.data ?? {}) as Record<string, unknown>;
  const text = String(data.markdown ?? "");
  const metadata = (data.metadata ?? {}) as Record<string, unknown>;
  return {
    title: String(metadata.title ?? ""),
    url: String(metadata.sourceURL ?? url),
    text: text.slice(0, RESEARCH_LIMITS.pageMax),
    cut: text.length > RESEARCH_LIMITS.pageMax,
  };
}
