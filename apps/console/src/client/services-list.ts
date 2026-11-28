/**
 * Bulk selection on a Services list (spec 05 5.2, 21.10): "Select all", "N selected" and
 * "Delete N selected" (faded "Delete selected" while nothing is ticked), which opens the teardown
 * dialog for the ticked services.
 */

function sync(list: HTMLElement): void {
  const boxes = Array.from(
    list.querySelectorAll<HTMLInputElement>("[data-service-select]:not(:disabled)"),
  );
  const ticked = boxes.filter((box) => box.checked).length;
  const all = list.querySelector<HTMLInputElement>("[data-service-select-all]");
  if (all) {
    all.checked = boxes.length > 0 && ticked === boxes.length;
    all.indeterminate = ticked > 0 && ticked < boxes.length;
  }
  const count = list.querySelector<HTMLElement>("[data-selected-count]");
  if (count) count.textContent = `${ticked} selected`;
  // "Delete selected" stays in its place, faded until something is ticked (spec 21.10).
  const button = list.querySelector<HTMLButtonElement>("[data-bulk-delete]");
  if (button) {
    button.disabled = ticked === 0;
    const label = Array.from(button.childNodes).find(
      (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== "",
    );
    if (label) label.textContent = ticked === 0 ? "Delete selected" : `Delete ${ticked} selected`;
  }
}

export function initServicesList(): void {
  document.addEventListener("change", (event) => {
    const box = event.target;
    if (!(box instanceof HTMLInputElement)) return;
    const list = box.closest<HTMLElement>("[data-services-list]");
    if (!list) return;
    if (box.matches("[data-service-select-all]")) {
      for (const item of list.querySelectorAll<HTMLInputElement>(
        "[data-service-select]:not(:disabled)",
      )) {
        item.checked = box.checked;
      }
    }
    if (box.matches("[data-service-select-all], [data-service-select]")) sync(list);
  });
}
