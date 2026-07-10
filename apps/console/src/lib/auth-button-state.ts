const AUTH_SPINNER_SELECTOR = "[data-auth-btn-spinner]";
const AUTH_LABEL_SELECTOR = "[data-auth-btn-label], [data-otp-btn-label]";
const AUTH_ICON_SELECTOR = "[data-auth-btn-icon]";

export function queryAuthActionButtons(root: ParentNode): HTMLButtonElement[] {
	return Array.from(
		root.querySelectorAll<HTMLButtonElement>(
			"button[data-auth-credentials-submit], button[data-onboarding-continue], button[data-invite-submit], button[data-onboarding-skip], button[data-invite-skip]",
		),
	);
}

export function rememberDefaultLabel(button: HTMLButtonElement) {
	if (button.dataset.defaultLabel) return;
	const label = button.querySelector<HTMLElement>(AUTH_LABEL_SELECTOR);
	if (label?.textContent) button.dataset.defaultLabel = label.textContent;
}

export function setButtonLoadingVisuals(button: HTMLButtonElement, loading: boolean) {
	const spinner = button.querySelector<HTMLElement>(AUTH_SPINNER_SELECTOR);
	const label = button.querySelector<HTMLElement>(AUTH_LABEL_SELECTOR);
	const icons = button.querySelectorAll<HTMLElement>(AUTH_ICON_SELECTOR);

	if (loading) {
		if (!button.style.minWidth) {
			button.style.minWidth = `${button.offsetWidth}px`;
		}
	} else {
		button.style.minWidth = "";
	}

	if (spinner) spinner.classList.toggle("hidden", !loading);
	if (label) label.classList.toggle("hidden", loading);
	for (const icon of icons) icon.classList.toggle("hidden", loading);
}

export function isAuthPanelLocked(root: ParentNode) {
	return root instanceof HTMLElement && root.dataset.authLocked === "1";
}

export function lockAuthPanel(root: ParentNode, activeButton?: HTMLButtonElement) {
	if (!(root instanceof HTMLElement)) return false;
	if (isAuthPanelLocked(root)) return false;

	root.dataset.authLocked = "1";
	for (const button of queryAuthActionButtons(root)) {
		button.disabled = true;
		const isActive = activeButton ? button === activeButton : false;
		button.setAttribute("aria-busy", isActive ? "true" : "false");
		if (isActive) {
			rememberDefaultLabel(button);
			setButtonLoadingVisuals(button, true);
		}
	}
	return true;
}

export function unlockAuthPanel(root: ParentNode) {
	if (!(root instanceof HTMLElement)) return;
	delete root.dataset.authLocked;

	for (const button of queryAuthActionButtons(root)) {
		button.disabled = false;
		button.removeAttribute("aria-busy");
		setButtonLoadingVisuals(button, false);
	}
}
