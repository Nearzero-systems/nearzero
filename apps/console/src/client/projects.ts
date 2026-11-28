import { writeCookie } from "./cookies.ts";

/**
 * The projects list (spec 5.1): instant search over name and description, Ctrl/Cmd+K to focus
 * it, the query kept in the address after a short pause, and the sort remembered in this browser.
 */

const SORT_COOKIE = "nz_projects_sort";
let urlTimer = 0;

function apply(root: HTMLElement): void {
  const input = root.querySelector<HTMLInputElement>("[data-project-search]");
  const query = (input?.value ?? "").trim().toLowerCase();
  const cards = Array.from(root.querySelectorAll<HTMLElement>("[data-project-card]"));
  let shown = 0;
  for (const card of cards) {
    const haystack = card.dataset.search ?? "";
    const match = !query || haystack.includes(query);
    card.hidden = !match;
    if (match) shown++;
  }
  const total = cards.length;
  const foot = root.querySelector<HTMLElement>("[data-project-count]");
  if (foot) foot.textContent = shown === total ? `${total} total` : `${shown} of ${total} total`;
  const noMatch = root.querySelector<HTMLElement>("[data-project-no-match]");
  if (noMatch) noMatch.hidden = !(total > 0 && shown === 0);
  const grid = root.querySelector<HTMLElement>("[data-project-grid]");
  if (grid) grid.hidden = shown === 0;
}

function sortCards(root: HTMLElement, sort: string): void {
  const grid = root.querySelector<HTMLElement>("[data-project-grid]");
  if (!grid) return;
  const cards = Array.from(grid.querySelectorAll<HTMLElement>("[data-project-card]"));
  const name = (card: HTMLElement) => card.dataset.name ?? "";
  const created = (card: HTMLElement) => Number(card.dataset.created ?? "0");
  const services = (card: HTMLElement) => Number(card.dataset.services ?? "0");
  const compare: Record<string, (a: HTMLElement, b: HTMLElement) => number> = {
    "name-asc": (a, b) => name(a).localeCompare(name(b)),
    "name-desc": (a, b) => name(b).localeCompare(name(a)),
    newest: (a, b) => created(b) - created(a),
    oldest: (a, b) => created(a) - created(b),
    "most-services": (a, b) => services(b) - services(a) || name(a).localeCompare(name(b)),
    "least-services": (a, b) => services(a) - services(b) || name(a).localeCompare(name(b)),
  };
  const sorter = compare[sort];
  if (!sorter) return;
  grid.append(...cards.sort(sorter));
}

export function initProjectsList(): void {
  document.addEventListener("input", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.matches("[data-project-search]")) return;
    const root = input.closest<HTMLElement>("[data-projects]");
    if (!root) return;
    apply(root);
    window.clearTimeout(urlTimer);
    urlTimer = window.setTimeout(() => {
      const url = new URL(location.href);
      const value = input.value.trim();
      if (value) url.searchParams.set("q", value);
      else url.searchParams.delete("q");
      history.replaceState(history.state, "", url);
    }, 400);
  });

  document.addEventListener("change", (event) => {
    const select = event.target;
    if (!(select instanceof HTMLSelectElement) || !select.matches("[data-project-sort]")) return;
    const root = select.closest<HTMLElement>("[data-projects]");
    if (!root) return;
    writeCookie(SORT_COOKIE, select.value);
    sortCards(root, select.value);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey)) return;
    const input = document.querySelector<HTMLInputElement>("[data-project-search]");
    if (!input) return;
    event.preventDefault();
    input.focus();
    input.select();
  });

  document.addEventListener("astro:page-load", () => {
    const root = document.querySelector<HTMLElement>("[data-projects]");
    if (root) apply(root);
  });
}
