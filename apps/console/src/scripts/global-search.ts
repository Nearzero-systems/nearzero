import {
	filterGlobalSearchItems,
	type GlobalSearchItem,
} from "@/lib/global-search-index";
import { closeDialog, openDialog } from "@/scripts/ui";

type Bootstrap = {
	items: GlobalSearchItem[];
};

const SEARCH_DIALOG_ID = "dashboard-global-search-dialog";
const SEARCH_INPUT_ID = "dashboard-global-search-input";
const SEARCH_RESULTS_ID = "dashboard-global-search-results";
const SEARCH_TOGGLE_ID = "dashboard-search-toggle";
const SEARCH_SHORTCUT_ID = "dashboard-search-shortcut";
const SEARCH_BOOTSTRAP_ID = "dashboard-global-search-bootstrap";

let shortcutKeyHandler: ((event: KeyboardEvent) => void) | null = null;

function readBootstrap(): Bootstrap {
	const el = document.getElementById(SEARCH_BOOTSTRAP_ID);
	if (!el?.textContent?.trim()) return { items: [] };
	try {
		const parsed = JSON.parse(el.textContent) as Bootstrap;
		return {
			items: Array.isArray(parsed?.items) ? parsed.items : [],
		};
	} catch {
		return { items: [] };
	}
}

function getSearchElements() {
	const dialog = document.getElementById(SEARCH_DIALOG_ID);
	const input = document.getElementById(SEARCH_INPUT_ID);
	const results = document.getElementById(SEARCH_RESULTS_ID);
	if (!(dialog instanceof HTMLDialogElement)) return null;
	if (!(input instanceof HTMLInputElement)) return null;
	if (!(results instanceof HTMLElement)) return null;
	return { dialog, input, results };
}

function isMacPlatform() {
	return /Mac|iPhone|iPad|iPod/.test(navigator.platform);
}

export function formatGlobalSearchShortcutLabel() {
	return isMacPlatform() ? "⌘K" : "Ctrl K";
}

export function mountGlobalSearch() {
	const els = getSearchElements();
	if (!els) return;

	const { dialog, input, results } = els;
	const bootstrap = readBootstrap();

	const shortcut = document.getElementById(SEARCH_SHORTCUT_ID);
	if (shortcut) shortcut.textContent = formatGlobalSearchShortcutLabel();

	const dialogAlreadyBound = dialog.dataset.bound === "1";
	if (!dialogAlreadyBound) dialog.dataset.bound = "1";

	let activeIndex = 0;
	let visibleItems: GlobalSearchItem[] = [];

	const renderResults = (query: string) => {
		visibleItems = filterGlobalSearchItems(bootstrap.items, query, 14);
		activeIndex = 0;
		results.innerHTML = "";

		if (visibleItems.length === 0) {
			const empty = document.createElement("p");
			empty.className = "nz-global-search__empty";
			empty.textContent = query.trim()
				? "No matches found."
				: "Start typing to search pages and projects.";
			results.appendChild(empty);
			return;
		}

		for (const [index, item] of visibleItems.entries()) {
			const btn = document.createElement("button");
			btn.type = "button";
			btn.className = `nz-global-search__item${index === activeIndex ? " is-active" : ""}`;
			btn.dataset.index = String(index);
			btn.setAttribute("role", "option");
			btn.setAttribute("aria-selected", index === activeIndex ? "true" : "false");

			const label = document.createElement("span");
			label.className = "nz-global-search__item-label";
			label.textContent = item.label;

			const hint = document.createElement("span");
			hint.className = "nz-global-search__item-hint";
			hint.textContent = item.hint ?? "";

			btn.append(label, hint);
			btn.addEventListener("click", () => {
				navigateTo(item);
			});
			results.appendChild(btn);
		}
	};

	const updateActiveRow = () => {
		for (const row of results.querySelectorAll<HTMLButtonElement>(
			".nz-global-search__item",
		)) {
			const index = Number(row.dataset.index ?? "-1");
			const active = index === activeIndex;
			row.classList.toggle("is-active", active);
			row.setAttribute("aria-selected", active ? "true" : "false");
			if (active) row.scrollIntoView({ block: "nearest" });
		}
	};

	const navigateTo = (item: GlobalSearchItem) => {
		closePalette();
		if (item.external) {
			window.open(item.href, "_blank", "noopener,noreferrer");
			return;
		}
		const query = input.value.trim();
		let href = item.href;
		if (item.id === "search-deployments" && query) {
			const url = new URL(href, window.location.origin);
			url.searchParams.set("q", query);
			href = `${url.pathname}${url.search}`;
		}
		window.location.href = href;
	};

	const openPalette = () => {
		const live = getSearchElements();
		if (!live) return;
		live.input.value = "";
		renderResults("");
		openDialog(SEARCH_DIALOG_ID);
		window.requestAnimationFrame(() => live.input.focus());
	};

	const closePalette = () => {
		closeDialog(SEARCH_DIALOG_ID);
		input.blur();
	};

	if (!dialogAlreadyBound) {
		input.addEventListener("input", () => {
			renderResults(input.value);
		});

		input.addEventListener("keydown", (event) => {
			if (event.key === "ArrowDown") {
				event.preventDefault();
				if (visibleItems.length === 0) return;
				activeIndex = (activeIndex + 1) % visibleItems.length;
				updateActiveRow();
				return;
			}
			if (event.key === "ArrowUp") {
				event.preventDefault();
				if (visibleItems.length === 0) return;
				activeIndex =
					(activeIndex - 1 + visibleItems.length) % visibleItems.length;
				updateActiveRow();
				return;
			}
			if (event.key === "Enter") {
				event.preventDefault();
				const item = visibleItems[activeIndex];
				if (item) navigateTo(item);
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				closePalette();
			}
		});

		dialog.addEventListener("close", () => {
			input.value = "";
		});

		dialog.addEventListener("click", (event) => {
			if (event.target === dialog) closePalette();
		});
	}

	const toggle = document.getElementById(SEARCH_TOGGLE_ID);
	if (toggle instanceof HTMLButtonElement && toggle.dataset.searchBound !== "1") {
		toggle.dataset.searchBound = "1";
		toggle.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			openPalette();
		});
	}

	if (shortcutKeyHandler) {
		document.removeEventListener("keydown", shortcutKeyHandler);
	}

	shortcutKeyHandler = (event: KeyboardEvent) => {
		const key = event.key.toLowerCase();
		if (!(event.metaKey || event.ctrlKey) || key !== "k") return;
		const target = event.target;
		if (
			target instanceof HTMLInputElement ||
			target instanceof HTMLTextAreaElement ||
			(target instanceof HTMLElement && target.isContentEditable)
		) {
			return;
		}
		event.preventDefault();
		const liveDialog = document.getElementById(SEARCH_DIALOG_ID);
		if (liveDialog instanceof HTMLDialogElement && liveDialog.open) {
			closePalette();
		} else {
			openPalette();
		}
	};
	document.addEventListener("keydown", shortcutKeyHandler);
}
