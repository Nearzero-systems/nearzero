import { resolve } from "node:path";

/**
 * The console's brand files and the addresses they answer at (spec 21.9b), shared by the unit
 * test (test/brand.test.ts), the production-build test (e2e/brand.e2e.ts) and the sweep, which
 * runs the dev server.
 */

export const PUBLIC_DIR = resolve(import.meta.dir, "..", "public");

export interface BrandUrl {
  path: string;
  /** Content types that are right for it (without parameters such as charset). */
  types: string[];
}

export const BRAND_URLS: BrandUrl[] = [
  { path: "/favicon.svg", types: ["image/svg+xml"] },
  { path: "/icon.svg", types: ["image/svg+xml"] },
  { path: "/logo.svg", types: ["image/svg+xml"] },
  // Both names are registered for .ico; servers differ in which they pick.
  { path: "/favicon.ico", types: ["image/x-icon", "image/vnd.microsoft.icon"] },
  { path: "/apple-touch-icon.png", types: ["image/png"] },
  { path: "/icon-192.png", types: ["image/png"] },
  { path: "/icon-512.png", types: ["image/png"] },
  { path: "/og.png", types: ["image/png"] },
  { path: "/manifest.webmanifest", types: ["application/manifest+json"] },
  { path: "/robots.txt", types: ["text/plain"] },
];

/**
 * Fetches every brand address from `base` (with `headers`, to come in as the router would) and
 * returns what is wrong: a status other than 200, a wrong content type, or a body that isn't the
 * file in public/.
 */
export async function brandUrlProblems(
  base: string,
  headers: Record<string, string> = {},
): Promise<string[]> {
  const problems: string[] = [];
  for (const url of BRAND_URLS) {
    const response = await fetch(`${base}${url.path}`, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    const type = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
    const body = new Uint8Array(await response.arrayBuffer());
    if (response.status !== 200) {
      problems.push(`${url.path}: HTTP ${response.status}`);
      continue;
    }
    if (!type || !url.types.includes(type)) {
      problems.push(`${url.path}: content type "${type}", expected ${url.types.join(" or ")}`);
    }
    const file = new Uint8Array(
      await Bun.file(resolve(PUBLIC_DIR, url.path.slice(1))).arrayBuffer(),
    );
    if (Buffer.compare(Buffer.from(body), Buffer.from(file)) !== 0) {
      problems.push(`${url.path}: the body isn't public${url.path} (${body.length} bytes)`);
    }
  }
  return problems;
}

/** The <meta> and <link> values a page's HTML carries, read without a browser. */
export function headTags(html: string): {
  title: string | null;
  metas: Map<string, string>;
  links: { rel: string; href: string; type: string | null; sizes: string | null }[];
} {
  const head = html.split(/<\/head>/i)[0] ?? "";
  const attr = (tag: string, name: string) =>
    tag.match(new RegExp(`\\s${name}="([^"]*)"`, "i"))?.[1] ?? null;
  const decode = (value: string) =>
    value
      .replaceAll("&#39;", "'")
      .replaceAll("&quot;", '"')
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&amp;", "&");
  const metas = new Map<string, string>();
  for (const [tag] of head.matchAll(/<meta\b[^>]*>/gi)) {
    const key = attr(tag, "name") ?? attr(tag, "property");
    const content = attr(tag, "content");
    if (key && content !== null) metas.set(key, decode(content));
  }
  const links = [...head.matchAll(/<link\b[^>]*>/gi)].map(([tag]) => ({
    rel: attr(tag, "rel") ?? "",
    href: decode(attr(tag, "href") ?? ""),
    type: attr(tag, "type"),
    sizes: attr(tag, "sizes"),
  }));
  const title = head.match(/<title>([^<]*)<\/title>/i)?.[1];
  return { title: title === undefined ? null : decode(title), metas, links };
}
