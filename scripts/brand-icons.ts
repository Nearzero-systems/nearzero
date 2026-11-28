import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

/**
 * Makes the console's raster icons from the owner's mark (spec 21.9b), all from
 * apps/console/public/favicon.svg, the brand kit's file as supplied:
 * - favicon.ico: 16 and 32 px (PNG images in an ICO file, which every current browser reads);
 * - apple-touch-icon.png: 180 px on an opaque background (the mark's own square colour, so the
 *   rounded corners phones cut find the same colour);
 * - icon-192.png and icon-512.png for the web manifest.
 * Run it again only when the mark changes, and commit what it writes:
 *
 *   bun scripts/brand-icons.ts
 *
 * It uses sharp, which the console's build tooling (Astro) installs; the running console and
 * the production image never load it.
 */

const ROOT = resolve(import.meta.dir, "..");
const PUBLIC = resolve(ROOT, "apps/console/public");

/** The little of sharp this script uses. */
interface Image {
  resize(width: number, height: number): Image;
  flatten(options: { background: string }): Image;
  png(options: {
    palette?: boolean;
    quality?: number;
    compressionLevel?: number;
    effort?: number;
  }): Image;
  toBuffer(): Promise<Buffer>;
}
type Sharp = (input: Buffer, options?: { density?: number }) => Image;

/** Sharp is Astro's (optional) dependency, so it is found from where Astro is installed. */
function loadSharp(): Sharp {
  const fromConsole = createRequire(resolve(ROOT, "apps/console/package.json"));
  const astro = fromConsole.resolve("astro/package.json");
  try {
    return createRequire(astro)("sharp") as Sharp;
  } catch {
    throw new Error("sharp isn't installed. Run `bun install` first (Astro brings it in).");
  }
}

/** The mark's viewBox width and the fill of its square, read from the file itself. */
function readMark(svg: string): { viewBox: number; background: string } {
  const viewBox = Number(svg.match(/viewBox="0 0 ([\d.]+) [\d.]+"/)?.[1]);
  const background = svg.match(/<rect\b[^>]*\bfill="(#[0-9a-f]{3,8})"/i)?.[1];
  if (!Number.isFinite(viewBox) || viewBox <= 0 || !background) {
    throw new Error(
      "favicon.svg isn't the brand kit's mark (no square viewBox or no <rect> fill).",
    );
  }
  return { viewBox, background };
}

/** One PNG of the mark, rendered at its size (not scaled from another raster). */
async function render(
  sharp: Sharp,
  svg: Buffer,
  viewBox: number,
  size: number,
  background?: string,
): Promise<Buffer> {
  let image = sharp(svg, { density: (72 * size) / viewBox }).resize(size, size);
  if (background) image = image.flatten({ background });
  return image.png({ palette: true, quality: 100, compressionLevel: 9, effort: 10 }).toBuffer();
}

/** An ICO file holding PNG images (ICONDIR, one ICONDIRENTRY per image, then the images). */
export function icoFrom(images: { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((image, index) => {
    const entry = 6 + 16 * index;
    header.writeUInt8(image.size >= 256 ? 0 : image.size, entry);
    header.writeUInt8(image.size >= 256 ? 0 : image.size, entry + 1);
    header.writeUInt8(0, entry + 2);
    header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(image.png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += image.png.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.png)]);
}

async function main(): Promise<void> {
  const sharp = loadSharp();
  const svg = await readFile(resolve(PUBLIC, "favicon.svg"));
  const { viewBox, background } = readMark(svg.toString("utf8"));

  const ico = icoFrom([
    { size: 16, png: await render(sharp, svg, viewBox, 16) },
    { size: 32, png: await render(sharp, svg, viewBox, 32) },
  ]);
  const outputs: [string, Buffer][] = [
    ["favicon.ico", ico],
    ["apple-touch-icon.png", await render(sharp, svg, viewBox, 180, background)],
    ["icon-192.png", await render(sharp, svg, viewBox, 192)],
    ["icon-512.png", await render(sharp, svg, viewBox, 512)],
  ];
  for (const [name, bytes] of outputs) {
    await writeFile(resolve(PUBLIC, name), bytes);
    console.log(`${name.padEnd(22)} ${bytes.length.toLocaleString("en")} bytes`);
  }
}

if (import.meta.main) await main();
