import { authClient } from "@/lib/auth-client";
import { toConsoleCallbackUrl } from "@/lib/auth-callback-url";
import {
	isAuthPanelLocked,
	lockAuthPanel,
	unlockAuthPanel,
} from "@/lib/auth-button-state";
import { showToast } from "@/scripts/ui";

export type SocialAuthProviderId = "github" | "google";

export type BindSocialAuthOptions = {
	githubButton: HTMLButtonElement | null;
	googleButton: HTMLButtonElement | null;
	enabledProviders: readonly SocialAuthProviderId[];
	providersKnown?: boolean;
	resolveCallbackUrl: () => string;
	actionLabel: "login" | "signup";
};

function providerLabel(provider: SocialAuthProviderId) {
	return provider === "github" ? "GitHub" : "Google";
}

export function applySocialAuthProviderVisibility(
	root: ParentNode,
	enabledProviders: readonly SocialAuthProviderId[],
	providersKnown = false,
) {
	const github = root.querySelector<HTMLElement>("[data-social-auth='github']");
	const google = root.querySelector<HTMLElement>("[data-social-auth='google']");
	const panel = root.querySelector<HTMLElement>("[data-otp-oauth-panel]");

	if (github) {
		github.classList.toggle(
			"hidden",
			providersKnown && !enabledProviders.includes("github"),
		);
	}
	if (google) {
		google.classList.toggle(
			"hidden",
			providersKnown && !enabledProviders.includes("google"),
		);
	}
	if (panel) {
		const anyVisible =
			!providersKnown ||
			enabledProviders.includes("github") ||
			enabledProviders.includes("google");
		panel.classList.toggle("hidden", !anyVisible);
	}
}

export function bindSocialAuthFlow(options: BindSocialAuthOptions) {
	const {
		githubButton,
		googleButton,
		enabledProviders,
		providersKnown = false,
		resolveCallbackUrl,
		actionLabel,
	} = options;

	const start = async (
		provider: SocialAuthProviderId,
		button: HTMLButtonElement | null,
	) => {
		if (!button || isAuthPanelLocked(button.closest("[id$='-root']") as HTMLElement)) {
			return;
		}
		if (providersKnown && !enabledProviders.includes(provider)) {
			showToast(
				`${providerLabel(provider)} sign-in is not available right now.`,
				"error",
			);
			return;
		}

		const root = button.closest<HTMLElement>("[id$='-root']");
		if (!root || !lockAuthPanel(root, button)) return;

		let keepLocked = false;
		try {
			const callbackURL = toConsoleCallbackUrl(
				resolveCallbackUrl(),
				window.location.origin,
			);
			const { error } = await authClient.signIn.social({
				provider,
				callbackURL,
			});
			if (error) {
				const message = error.message || "";
				const friendly =
					message.toLowerCase().includes("provider not found")
						? `${providerLabel(provider)} sign-in is not configured on the server yet.`
						: message ||
							`Could not ${actionLabel === "login" ? "sign in" : "sign up"} with ${providerLabel(provider)}`;
				showToast(friendly, "error");
			} else {
				keepLocked = true;
			}
		} catch {
			showToast(
				`Could not ${actionLabel === "login" ? "sign in" : "sign up"} with ${providerLabel(provider)}`,
				"error",
			);
		} finally {
			if (!keepLocked) unlockAuthPanel(root);
		}
	};

	githubButton?.addEventListener("click", () => start("github", githubButton));
	googleButton?.addEventListener("click", () => start("google", googleButton));
}
