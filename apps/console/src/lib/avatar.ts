/**
 * The avatar image rule (spec 4.6): PNG, JPEG, GIF or WebP, under 2 MB. Checked in the browser
 * before uploading; the API checks it again.
 */

const TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function avatarProblem(
  file: { size: number; type: string },
  maxBytes: number,
): string | null {
  if (!TYPES.has(file.type)) return "Use a PNG, JPEG, GIF or WebP image.";
  if (file.size >= maxBytes) return "Use an image under 2 MB.";
  return null;
}

/**
 * The initials' text on a picked #rrggbb background: white on dark colors, near-black on light
 * ones, by WCAG relative luminance (the same rule the server-rendered avatar uses).
 */
export function initialsTextColor(background: string): "#ffffff" | "#111827" {
  if (!/^#[0-9a-f]{6}$/i.test(background)) return "#ffffff";
  const channel = (offset: number) => {
    const value = Number.parseInt(background.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const light = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  // Contrast against white vs. against #111827 (luminance about 0.0116).
  return 1.05 / (light + 0.05) >= (light + 0.05) / 0.0616 ? "#ffffff" : "#111827";
}
