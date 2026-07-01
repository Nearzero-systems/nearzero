import {
	rememberDefaultLabel,
	setButtonLoadingVisuals,
} from "@/lib/auth-button-state";

const ONBOARDING_BUTTON_SELECTOR =
	"button[data-onboarding-continue], button[data-onboarding-skip], button[data-invite-submit], button[data-invite-skip]";

const ONBOARDING_FIELD_SELECTOR =
	"[data-profile-name], [data-profile-workspace], [data-role-select], [data-heard-about-select], [data-invite-emails]";

export function queryOnboardingActionButtons(root: ParentNode): HTMLButtonElement[] {
	return Array.from(
		root.querySelectorAll<HTMLButtonElement>(ONBOARDING_BUTTON_SELECTOR),
	);
}

export function setOnboardingFieldsDisabled(root: ParentNode, disabled: boolean) {
	for (const field of root.querySelectorAll<HTMLElement>(
		ONBOARDING_FIELD_SELECTOR,
	)) {
		if (
			field instanceof HTMLInputElement ||
			field instanceof HTMLSelectElement ||
			field instanceof HTMLTextAreaElement
		) {
			field.disabled = disabled;
		}
	}
}

export function isOnboardingPanelLocked(root: ParentNode) {
	return root instanceof HTMLElement && root.dataset.onboardingLocked === "1";
}

export function lockOnboardingPanel(
	root: ParentNode,
	activeButton: HTMLButtonElement,
) {
	if (!(root instanceof HTMLElement)) return false;
	if (isOnboardingPanelLocked(root)) return false;

	root.dataset.onboardingLocked = "1";
	setOnboardingFieldsDisabled(root, true);

	for (const button of queryOnboardingActionButtons(root)) {
		button.disabled = true;
		const isActive = button === activeButton;
		button.setAttribute("aria-busy", isActive ? "true" : "false");
		if (isActive) {
			rememberDefaultLabel(button);
			setButtonLoadingVisuals(button, true);
		}
	}
	return true;
}

export function unlockOnboardingPanel(root: ParentNode) {
	if (!(root instanceof HTMLElement)) return;
	delete root.dataset.onboardingLocked;
	setOnboardingFieldsDisabled(root, false);

	for (const button of queryOnboardingActionButtons(root)) {
		button.disabled = false;
		button.removeAttribute("aria-busy");
		setButtonLoadingVisuals(button, false);
	}
}
