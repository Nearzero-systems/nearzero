/**
 * Pickers in the chat (spec 19.8): up to 8 options show as buttons; more than 8, and every
 * repository or branch list, show as an in-chat dropdown, with a search box from 7 options,
 * arrow keys and Enter. The card that gives Nearzero access to a repository is actions, so it is
 * always buttons (C3-02).
 */

export interface PickerOption {
  value: string;
  label: string;
  description?: string;
  icon?: string;
  /** A console path to open instead of answering (Connect buttons of the Git import). */
  href?: string;
}

/** Only console paths become links ("/acme/dashboard/settings/git-providers?…"). */
export function optionHref(option: PickerOption): string | null {
  const href = option.href?.trim() ?? "";
  return /^\/(?!\/)/.test(href) ? href : null;
}

export const BUTTONS_MAX = 8;
export const SEARCH_FROM = 7;

export function pickerStyle(
  purpose: string,
  options: readonly PickerOption[],
  searchable: boolean,
): "buttons" | "dropdown" {
  if (purpose === "access") return "buttons";
  if (searchable || purpose === "repository" || purpose === "branch") return "dropdown";
  return options.length > BUTTONS_MAX ? "dropdown" : "buttons";
}

export function showsSearch(options: readonly PickerOption[]): boolean {
  return options.length >= SEARCH_FROM;
}

/** Options matching every word of the query, in label or description; labels first. */
export function filterOptions(options: readonly PickerOption[], query: string): PickerOption[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return options.slice();
  const scored = options
    .map((option, index) => {
      const label = option.label.toLowerCase();
      const all = `${label} ${(option.description ?? "").toLowerCase()} ${option.value.toLowerCase()}`;
      if (!words.every((word) => all.includes(word))) return null;
      const score = label.startsWith(words[0] as string)
        ? 0
        : label.includes(words[0] as string)
          ? 1
          : 2;
      return { option, index, score };
    })
    .filter(
      (item): item is { option: PickerOption; index: number; score: number } => item !== null,
    );
  scored.sort((a, b) => a.score - b.score || a.index - b.index);
  return scored.map((item) => item.option);
}

/** Arrow keys move the highlight, wrapping; Home and End jump. */
export function moveHighlight(current: number, count: number, key: string): number {
  if (count === 0) return -1;
  switch (key) {
    case "ArrowDown":
      return current < 0 ? 0 : (current + 1) % count;
    case "ArrowUp":
      return current <= 0 ? count - 1 : current - 1;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return current;
  }
}
