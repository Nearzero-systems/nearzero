import { navigate } from "astro:transitions/client";

/**
 * List filters that live in the address (Servers, Domains → Hostnames; spec 9.1, 10.4): a form
 * with `data-filter-form` applies a select at once and a search after a short pause, leaving out
 * values equal to their field's `data-default`. The search keeps its focus across the swap.
 */

let timer: number | undefined;
let refocus: string | null = null;

function apply(form: HTMLFormElement): void {
  const params = new URLSearchParams();
  for (const element of Array.from(form.elements)) {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement)) continue;
    if (!element.name || element.disabled) continue;
    const value = element.value.trim();
    if (!value || value === (element.dataset.default ?? "")) continue;
    params.set(element.name, value);
  }
  const active = document.activeElement;
  refocus = active instanceof HTMLInputElement && form.contains(active) ? active.name : null;
  const query = params.toString();
  void navigate(`${form.getAttribute("action") ?? location.pathname}${query ? `?${query}` : ""}`, {
    history: "replace",
  });
}

export function initFilterForms(): void {
  // Servers: the search starts as a magnifier button that opens the field.
  document.addEventListener("click", (event) => {
    const toggle = (event.target as Element | null)?.closest?.<HTMLElement>("[data-search-toggle]");
    const form = toggle?.closest<HTMLFormElement>("[data-filter-form]");
    if (!toggle || !form) return;
    const input = form.querySelector<HTMLInputElement>('input[type="search"]');
    const open = form.dataset.searchOpen !== "true" || Boolean(input?.value);
    form.dataset.searchOpen = open ? "true" : "false";
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) input?.focus();
  });
  document.addEventListener("input", (event) => {
    const input = event.target as HTMLInputElement | null;
    if (!input?.matches?.('[data-filter-form] input[type="search"]')) return;
    const form = input.closest<HTMLFormElement>("form");
    window.clearTimeout(timer);
    if (form) timer = window.setTimeout(() => apply(form), 400);
  });
  document.addEventListener("change", (event) => {
    const field = event.target as HTMLElement | null;
    if (!field?.matches?.("[data-filter-form] select")) return;
    const form = field.closest<HTMLFormElement>("form");
    if (form) apply(form);
  });
  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.matches("[data-filter-form]")) return;
    event.preventDefault();
    apply(form);
  });
  document.addEventListener("astro:page-load", () => {
    if (!refocus) return;
    const input = document.querySelector<HTMLInputElement>(
      `[data-filter-form] input[name="${CSS.escape(refocus)}"]`,
    );
    refocus = null;
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  });
}
