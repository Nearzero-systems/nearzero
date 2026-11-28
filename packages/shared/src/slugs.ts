/**
 * Slugs from names: the one rule workspace web addresses (spec 04 4.4), app name suggestions
 * (spec 06 6.1) and server labels (spec 10.2) share. Each caller adds its own length cap and
 * prefix rules on top.
 */

/** Combining marks that decomposition leaves behind accented letters (é → e + ´). */
const FIRST_COMBINING_MARK = 0x300;
const LAST_COMBINING_MARK = 0x36f;

function isSlugCharacter(char: string): boolean {
  return (char >= "a" && char <= "z") || (char >= "0" && char <= "9");
}

/**
 * Builds a slug in one walk over the decomposed text: accents are dropped, letters and digits
 * are kept in lowercase, and any run of other characters becomes a single dash, written only
 * once a letter or digit follows it (so none lead or trail). With `maxLength`, the slug is cut
 * there, and the cut never leaves a dash at the end.
 */
export function slugify(text: string, maxLength?: number): string {
  let slug = "";
  let separatorPending = false;
  for (const char of text.normalize("NFKD")) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= FIRST_COMBINING_MARK && code <= LAST_COMBINING_MARK) continue;
    for (const lower of char.toLowerCase()) {
      if (!isSlugCharacter(lower)) {
        separatorPending = slug !== "";
        continue;
      }
      if (separatorPending) slug += "-";
      separatorPending = false;
      slug += lower;
    }
  }
  return maxLength === undefined ? slug : capSlug(slug, maxLength);
}

/** Cuts a slug to a length without leaving a dash at the end. */
export function capSlug(slug: string, maxLength: number): string {
  let capped = slug.slice(0, maxLength);
  while (capped.endsWith("-")) capped = capped.slice(0, -1);
  return capped;
}
