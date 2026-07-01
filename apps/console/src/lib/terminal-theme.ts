import { getStoredTheme } from "@/lib/theme";

export function isTerminalDarkMode(): boolean {
	if (typeof document !== "undefined") {
		return document.documentElement.classList.contains("dark");
	}
	return getStoredTheme() === "dark";
}

export function getXtermTheme() {
	if (isTerminalDarkMode()) {
		return {
			background: "#0c0c0c",
			foreground: "#cccccc",
			cursor: "#aeafad",
			selectionBackground: "#264f78",
		};
	}
	return {
		background: "#ffffff",
		foreground: "#1e1e1e",
		cursor: "#1e1e1e",
		selectionBackground: "#add6ff",
	};
}
