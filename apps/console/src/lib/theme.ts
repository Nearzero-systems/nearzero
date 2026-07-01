/** User theme preference (light / dark). Persisted in localStorage. */
export const THEME_STORAGE_KEY = "nearzero-theme";

export type ThemeMode = "light" | "dark";

export function getStoredTheme(): ThemeMode {
	if (typeof window === "undefined") return "light";
	try {
		return window.localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
	} catch {
		return "light";
	}
}

export function applyTheme(mode: ThemeMode) {
	const root = document.documentElement;
	root.classList.toggle("dark", mode === "dark");
	root.dataset.theme = mode;
	root.style.colorScheme = mode;
}

export function setTheme(mode: ThemeMode) {
	try {
		window.localStorage.setItem(THEME_STORAGE_KEY, mode);
	} catch {
		/* ignore */
	}
	applyTheme(mode);
}

export function toggleTheme(): ThemeMode {
	const next: ThemeMode = getStoredTheme() === "dark" ? "light" : "dark";
	setTheme(next);
	return next;
}
