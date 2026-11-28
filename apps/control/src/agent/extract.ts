import { inflateRawSync } from "node:zlib";

/**
 * Text out of attachments (spec 19.10): UTF-8 text files, Word documents (.docx, read from the
 * ZIP container's word/document.xml per the PKWARE APPNOTE and Office Open XML), and PDFs page by
 * page through pdf.js (via unpdf). Nothing here runs code from the file.
 */

export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes).replaceAll("\u0000", "");
}

/** Reads one named entry of a ZIP archive (stored or deflated), or null. */
export function zipEntry(
  bytes: Uint8Array,
  wanted: string,
  maxBytes = 50 * 1024 * 1024,
): Uint8Array | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end of central directory record is in the last 64 KB + 22 bytes.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  for (let n = 0; n < count && offset + 46 <= bytes.length; n++) {
    if (view.getUint32(offset, true) !== 0x02014b50) return null;
    const method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
    if (name !== wanted) continue;
    if (size > maxBytes || local + 30 > bytes.length) return null;
    if (view.getUint32(local, true) !== 0x04034b50) return null;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + compressed);
    if (method === 0) return data;
    if (method === 8) return new Uint8Array(inflateRawSync(data, { maxOutputLength: maxBytes }));
    return null;
  }
  return null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function unescapeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code.startsWith("#x")) return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
    if (code.startsWith("#")) return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
    return ENTITIES[code] ?? whole;
  });
}

/**
 * The words of a .docx, paragraph by paragraph; null when it can't be read: a damaged archive,
 * text that won't inflate or inflates past the cap, or entities that name no character (B1-58).
 */
export function docxText(bytes: Uint8Array): string | null {
  try {
    return readDocx(bytes);
  } catch {
    return null;
  }
}

function readDocx(bytes: Uint8Array): string | null {
  const xml = zipEntry(bytes, "word/document.xml");
  if (!xml) return null;
  const text = decodeText(xml);
  const paragraphs: string[] = [];
  for (const paragraph of text.split(/<\/w:p>/)) {
    let line = "";
    for (const match of paragraph.matchAll(
      /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:(tab|br|cr)\b[^>]*\/>/g,
    )) {
      if (match[2] === "tab") line += "\t";
      else if (match[2]) line += "\n";
      else line += unescapeXml(match[1] ?? "");
    }
    paragraphs.push(line);
  }
  return paragraphs
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A PDF's text, one string per page; null when it can't be read. */
export async function pdfPages(bytes: Uint8Array): Promise<string[] | null> {
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const document = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(document, { mergePages: false });
    return (Array.isArray(text) ? text : [text]).map((page) => page.trim());
  } catch {
    return null;
  }
}
