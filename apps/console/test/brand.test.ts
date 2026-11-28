import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  absoluteUrl,
  consoleOrigin,
  DEFAULT_DESCRIPTION,
  documentTitle,
  HOME_TITLE,
  SECTION_DESCRIPTIONS,
} from "../src/lib/page-meta.ts";
import { PAGE_COLORS, THEME_NAMES } from "../src/lib/theme.ts";
import { BRAND_URLS, PUBLIC_DIR } from "../test-support/brand.ts";

/**
 * Spec 21.9b without a server: the brand kit's files are in public/ exactly as supplied, the
 * derived icons are the sizes the spec names, the manifest and robots.txt say what they should,
 * theme-color follows the `page` tokens, and the title, description and link-preview address
 * rules hold. The same addresses are fetched from a running console by e2e/brand.e2e.ts (the
 * production build) and the sweep (the dev server).
 */

const bytes = async (name: string) =>
  new Uint8Array(await Bun.file(resolve(PUBLIC_DIR, name)).arrayBuffer());

async function sha256(name: string): Promise<string> {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(await bytes(name));
  return hash.digest("hex");
}

/** A PNG's size, colour type and whether it has a transparency chunk. */
function png(data: Uint8Array): {
  width: number;
  height: number;
  colorType: number;
  tRNS: boolean;
} {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  expect([...data.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  let tRNS = false;
  for (let at = 8; at + 8 <= data.length; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...data.slice(at + 4, at + 8));
    if (type === "tRNS") tRNS = true;
    at += 12 + length;
  }
  return { width: view.getUint32(16), height: view.getUint32(20), colorType: data[25] ?? -1, tRNS };
}

// The brand files in apps/console/public: favicon.svg, icon.svg and logo.svg are the same
// mark, and og.png is the link-preview image. A different file here means a substitute mark.
const KIT = {
  mark: "42accd662b38f7b9d83b9e7ccba1a7c6d2143baa5e1a337fd65a9c6d0ebffcc6",
  og: "38b88f14a526ebaac42485e38ffb1459a158a419aecbb8d873869798aa7f4a9f",
};

describe("brand files (spec 21.9b)", () => {
  test("the mark and the link-preview image are the owner's files, unchanged", async () => {
    for (const name of ["favicon.svg", "icon.svg", "logo.svg"]) {
      expect(await sha256(name)).toBe(KIT.mark);
    }
    expect(await sha256("og.png")).toBe(KIT.og);
    expect(png(await bytes("og.png"))).toMatchObject({ width: 1200, height: 630 });
  });

  test("every brand address has its file in public/", async () => {
    for (const url of BRAND_URLS) {
      expect(await Bun.file(resolve(PUBLIC_DIR, url.path.slice(1))).exists()).toBe(true);
    }
  });

  test("favicon.ico holds the mark at 16 and 32 px", async () => {
    const data = await bytes("favicon.ico");
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    expect(view.getUint16(0, true)).toBe(0);
    expect(view.getUint16(2, true)).toBe(1);
    const count = view.getUint16(4, true);
    const sizes: number[] = [];
    for (let index = 0; index < count; index++) {
      const entry = 6 + 16 * index;
      const size = data[entry] ?? 0;
      const length = view.getUint32(entry + 8, true);
      const offset = view.getUint32(entry + 12, true);
      const image = png(data.slice(offset, offset + length));
      expect(image.width).toBe(size);
      expect(image.height).toBe(size);
      sizes.push(size);
    }
    expect(sizes.sort((a, b) => a - b)).toEqual([16, 32]);
    expect(data.length).toBeLessThan(4096);
  });

  test("the touch icon is 180 px and opaque; the manifest icons are 192 and 512 px", async () => {
    const touch = png(await bytes("apple-touch-icon.png"));
    expect(touch).toMatchObject({ width: 180, height: 180, tRNS: false });
    // Greyscale, RGB or a palette without transparency: no alpha channel.
    expect([0, 2, 3]).toContain(touch.colorType);
    expect(png(await bytes("icon-192.png"))).toMatchObject({ width: 192, height: 192 });
    expect(png(await bytes("icon-512.png"))).toMatchObject({ width: 512, height: 512 });
    for (const name of ["apple-touch-icon.png", "icon-192.png", "icon-512.png"]) {
      expect((await bytes(name)).length).toBeLessThan(24 * 1024);
    }
  });

  test("the manifest names Nearzero, lists the 192 and 512 px icons, and uses Light's colors", async () => {
    const manifest = await Bun.file(resolve(PUBLIC_DIR, "manifest.webmanifest")).json();
    expect(manifest.name).toBe("Nearzero");
    expect(manifest.start_url).toBe("/");
    expect(manifest.icons).toEqual([
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ]);
    const light = (await tokenValues()).light;
    expect(manifest.theme_color).toBe(light);
    expect(manifest.background_color).toBe(light);
  });

  test("robots.txt keeps every crawler out", async () => {
    expect(await Bun.file(resolve(PUBLIC_DIR, "robots.txt")).text()).toBe(
      "User-agent: *\nDisallow: /\n",
    );
  });
});

/** Each theme's `--nz-page` in styles/tokens.css. */
async function tokenValues(): Promise<Record<string, string>> {
  const css = await Bun.file(resolve(import.meta.dir, "../src/styles/tokens.css")).text();
  const block = (selector: string) => {
    const start = css.indexOf(`${selector} {`);
    const body = css.slice(start, css.indexOf("\n}", start));
    return body.match(/--nz-page:\s*(#[0-9a-f]{6})/i)?.[1];
  };
  return {
    light: block(":root") ?? "",
    dark: block(':root[data-tone="dark"]') ?? "",
    dusk: block(':root[data-theme="dusk"]') ?? "",
  };
}

describe("theme-color (spec 21.9b)", () => {
  test("is each theme's page token, as styles/tokens.css defines it", async () => {
    const tokens = await tokenValues();
    for (const theme of THEME_NAMES) expect(PAGE_COLORS[theme]).toBe(tokens[theme] ?? "");
    expect(PAGE_COLORS).toEqual({ light: "#f3f4f6", dark: "#050506", dusk: "#050507" });
  });
});

describe("titles and descriptions (spec 21.9b)", () => {
  test('every title is "<Page> · Nearzero", and the home is "Nearzero" alone', () => {
    expect(documentTitle("Projects")).toBe("Projects · Nearzero");
    expect(documentTitle("Sign in")).toBe("Sign in · Nearzero");
    expect(documentTitle(HOME_TITLE)).toBe("Nearzero");
  });

  test("every description is one sentence", () => {
    for (const sentence of [DEFAULT_DESCRIPTION, ...Object.values(SECTION_DESCRIPTIONS)]) {
      expect(sentence).toMatch(/^[A-Z].*\.$/s);
      expect(sentence).not.toMatch(/[.!?]\s+\S/);
      expect(sentence.length).toBeLessThanOrEqual(160);
    }
  });
});

describe("the link preview's address (spec 21.9b)", () => {
  const fallback = new URL("http://localhost:4321/sign-in");
  const request = (url: string, headers: Record<string, string>) => new Request(url, { headers });

  test("is the address the console was reached at, on an IP and port", () => {
    const origin = consoleOrigin(
      request("http://localhost:4321/sign-in", { host: "203.0.113.10:4321" }),
      "198.51.100.7",
      fallback,
    );
    expect(origin).toBe("http://203.0.113.10:4321");
    expect(absoluteUrl(origin, "/og.png")).toBe("http://203.0.113.10:4321/og.png");
  });

  test("behind the router it is the domain over HTTPS", () => {
    const origin = consoleOrigin(
      request("http://localhost:4321/sign-in", {
        host: "nearzero.example.com",
        "x-forwarded-proto": "https",
        "x-forwarded-for": "198.51.100.7",
      }),
      "127.0.0.1",
      fallback,
    );
    expect(absoluteUrl(origin, "/og.png")).toBe("https://nearzero.example.com/og.png");
  });

  test("a trusted proxy's X-Forwarded-Host wins over a rewritten Host", () => {
    const origin = consoleOrigin(
      request("http://localhost:4321/sign-in", {
        host: "nearzero-control:4321",
        "x-forwarded-host": "nearzero.example.com",
        "x-forwarded-proto": "https",
      }),
      "::ffff:127.0.0.1",
      fallback,
    );
    expect(origin).toBe("https://nearzero.example.com");
  });

  test("forwarded headers from a browser are ignored, and a malformed host falls back", () => {
    const spoofed = consoleOrigin(
      request("http://localhost:4321/sign-in", {
        host: "203.0.113.10:4321",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "https",
      }),
      "198.51.100.7",
      fallback,
    );
    expect(spoofed).toBe("http://203.0.113.10:4321");
    const malformed = consoleOrigin(
      request("http://localhost:4321/sign-in", { host: 'a"b<c' }),
      "198.51.100.7",
      fallback,
    );
    expect(malformed).toBe("http://localhost:4321");
  });
});
