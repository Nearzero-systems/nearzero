/** Small behaviors shared by many pages. */

/** Rows of links scroll so the current one is in view, centred (settings links, tab rows). */
export function scrollCurrentIntoView(): void {
  for (const row of document.querySelectorAll<HTMLElement>("[data-scroll-current]")) {
    const current = row.querySelector<HTMLElement>('[aria-current="page"]');
    if (!current || row.scrollWidth <= row.clientWidth) continue;
    row.scrollLeft = current.offsetLeft - (row.clientWidth - current.offsetWidth) / 2;
  }
}

/** Arrow keys, Home and End move between in-place tabs; selecting shows the matching panel. */
export function initTabs(): void {
  const select = (tab: HTMLElement) => {
    const list = tab.closest('[role="tablist"]');
    if (!list) return;
    for (const other of list.querySelectorAll<HTMLElement>('[role="tab"]')) {
      const selected = other === tab;
      other.setAttribute("aria-selected", selected ? "true" : "false");
      other.tabIndex = selected ? 0 : -1;
      const panel = document.getElementById(other.getAttribute("aria-controls") ?? "");
      if (panel) panel.hidden = !selected;
    }
  };
  document.addEventListener("click", (event) => {
    const tab = (event.target as Element | null)?.closest<HTMLElement>('[role="tab"]');
    if (tab) select(tab);
  });
  document.addEventListener("keydown", (event) => {
    const tab = (event.target as Element | null)?.closest<HTMLElement>('[role="tab"]');
    if (!tab) return;
    const tabs = Array.from(
      tab.closest('[role="tablist"]')?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [],
    );
    const index = tabs.indexOf(tab);
    let next: HTMLElement | undefined;
    if (event.key === "ArrowRight") next = tabs[(index + 1) % tabs.length];
    else if (event.key === "ArrowLeft") next = tabs[(index - 1 + tabs.length) % tabs.length];
    else if (event.key === "Home") next = tabs[0];
    else if (event.key === "End") next = tabs[tabs.length - 1];
    if (next) {
      event.preventDefault();
      next.focus();
      select(next);
    }
  });
}
