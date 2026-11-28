import { stripInternalIds } from "@nearzero/shared";

/**
 * Streams answer words with internal ids removed (spec 19.4, 19.11). An id can arrive split over
 * several deltas, so the tail that could still become one ("(id: 3f2a…", a half-written id) is
 * held back until it is complete or clearly isn't an id.
 */
export class IdSafeText {
  #pending = "";
  #shown = "";

  /** Takes a delta; returns the part that is safe to show now. */
  push(delta: string): string {
    this.#pending += delta;
    const cut = this.#safeCut();
    if (cut <= 0) return "";
    const ready = this.#pending.slice(0, cut);
    this.#pending = this.#pending.slice(cut);
    return this.#emit(ready);
  }

  /** Everything still held back. */
  flush(): string {
    const rest = this.#pending;
    this.#pending = "";
    return rest ? this.#emit(rest) : "";
  }

  get shown(): string {
    return this.#shown;
  }

  #emit(text: string): string {
    const clean = stripInternalIds(text);
    this.#shown += clean;
    return clean;
  }

  #safeCut(): number {
    const text = this.#pending;
    // Hold back from an unclosed bracket near the end: "(id: …" may still close.
    const open = Math.max(text.lastIndexOf("("), text.lastIndexOf("["));
    const close = Math.max(text.lastIndexOf(")"), text.lastIndexOf("]"));
    let limit = text.length;
    if (open > close && text.length - open < 64) {
      limit = open;
      // The space before it goes with it, so removing "(id: …)" leaves one space, not two.
      while (limit > 0 && /\s/.test(text[limit - 1] ?? "")) limit--;
    }
    // Hold back the last word if it could be part of an id or an "id:" label.
    const tail = text.slice(0, limit);
    const space = Math.max(tail.lastIndexOf(" "), tail.lastIndexOf("\n"), tail.lastIndexOf("\t"));
    const lastWord = tail.slice(space + 1);
    if (/^[`0-9a-f-]*$/i.test(lastWord) || /^(id|ref|reference)\s*[:=]?$/i.test(lastWord)) {
      limit = space + 1;
      // "id: " right before the held word goes with it.
      const before = text.slice(0, limit);
      const label = /(?:[,;]?\s*\b(?:id|ID|ref|reference)\s*[:=]\s*)$/.exec(before);
      if (label) limit -= label[0].length;
      while (limit > 0 && /\s/.test(text[limit - 1] ?? "")) limit--;
    }
    return Math.max(0, limit);
  }
}
