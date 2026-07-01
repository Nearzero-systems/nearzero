import { applyTheme, getStoredTheme, setTheme, toggleTheme, type ThemeMode } from "@/lib/theme";

function updateToggleUi(btn: HTMLButtonElement, mode: ThemeMode) {
	const isDark = mode === "dark";
	btn.setAttribute("aria-pressed", isDark ? "true" : "false");
	btn.setAttribute("aria-label", isDark ? "Switch to light theme" : "Switch to dark theme");
	btn.title = isDark ? "Light mode" : "Dark mode";
	btn.dataset.theme = mode;
}

export function bindThemeToggle(button?: HTMLElement | null) {
	const buttons =
		button instanceof HTMLButtonElement ?
			[button]
		:	Array.from(document.querySelectorAll<HTMLButtonElement>(".nz-theme-toggle"));

	for (const btn of buttons) {
		if (!(btn instanceof HTMLButtonElement)) continue;
		updateToggleUi(btn, getStoredTheme());
		if (btn.dataset.bound === "1") continue;
		btn.dataset.bound = "1";

		btn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			const next = toggleTheme();
			for (const toggle of document.querySelectorAll<HTMLButtonElement>(
				".nz-theme-toggle",
			)) {
				updateToggleUi(toggle, next);
			}
		});
	}
}

export function initTheme() {
	applyTheme(getStoredTheme());
	bindThemeToggle();
}
