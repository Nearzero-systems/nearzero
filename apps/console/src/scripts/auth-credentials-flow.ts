import {
	isAuthPanelLocked,
	lockAuthPanel,
	unlockAuthPanel,
} from "@/lib/auth-button-state";
import { getAuthEmailValidationError } from "@/lib/auth-email-policy";
import { authClient } from "@/lib/auth-client";
import { authErrorMessage } from "@/lib/auth-form-classes";
import {
	readPendingInvitationToken,
	resolveInvitationTokenFromPage,
} from "@/lib/invitation-routes";
import { showToast } from "@/scripts/ui";

export type AuthCredentialsIntent = "login" | "signup";

export type AuthCredentialsFlowOptions = {
	root: HTMLElement;
	callbackUrl: string;
	intent: AuthCredentialsIntent;
	invitationToken?: string;
	afterSignupUrl?: string;
};

function validatePassword(password: string) {
	if (password.length < 8) {
		return "Password must be at least 8 characters.";
	}
	return null;
}

async function waitForEstablishedSession(attempts = 4, delayMs = 150) {
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			const res = await fetch("/api/auth/get-session", {
				credentials: "include",
			});
			if (res.ok) {
				const data = (await res.json().catch(() => null)) as {
					user?: unknown;
				} | null;
				if (data?.user) return true;
			}
		} catch {
			// retry
		}
		if (attempt < attempts - 1) {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}
	return false;
}

async function createNearzeroCredentialSession(
	intent: AuthCredentialsIntent,
	email: string,
	password: string,
) {
	const res = await fetch("/api/auth/nearzero-adopt-credential", {
		method: "POST",
		credentials: "include",
		headers: {
			"content-type": "application/json",
		},
		body: JSON.stringify({ intent, email, password }),
	});
	const data = (await res.json().catch(() => null)) as unknown;
	if (!res.ok) {
		return { ok: false, code: "request_failed", message: "Auth request failed." };
	}
	if (typeof data === "object" && data && "ok" in data) {
		return data as
			| { ok: true; token: string; user: unknown }
			| { ok: false; code: string; message: string };
	}
	return { ok: false, code: "invalid_response", message: "Auth request failed." };
}

export function bindAuthCredentialsFlow(options: AuthCredentialsFlowOptions) {
	const {
		root,
		callbackUrl,
		intent,
		invitationToken = "",
		afterSignupUrl,
	} = options;

	if (root.dataset.bound === "1") return;
	root.dataset.bound = "1";

	const form = root.querySelector<HTMLFormElement>("[data-auth-credentials-form]");
	const emailInput = root.querySelector<HTMLInputElement>(
		"[data-auth-email-input]",
	);
	const passwordInput = root.querySelector<HTMLInputElement>(
		"[data-auth-password-input]",
	);
	const submitBtn = root.querySelector<HTMLButtonElement>(
		"[data-auth-credentials-submit]",
	);

	form?.addEventListener("submit", async (event) => {
		event.preventDefault();
		if (isAuthPanelLocked(root) || !submitBtn) return;

		const email = (emailInput?.value || "").trim().toLowerCase();
		const password = passwordInput?.value || "";
		const validationError = getAuthEmailValidationError(email);
		if (validationError) {
			showToast(validationError, "error");
			return;
		}
		const passwordError = validatePassword(password);
		if (passwordError) {
			showToast(passwordError, "error");
			return;
		}
		if (!lockAuthPanel(root, submitBtn)) return;

		let keepLocked = false;
		try {
			const resolvedInvitationToken =
				invitationToken ||
				resolveInvitationTokenFromPage() ||
				readPendingInvitationToken() ||
				"";
			const fetchOptions = resolvedInvitationToken
				? {
						headers: {
							"x-nearzero-token": resolvedInvitationToken,
						},
					}
				: undefined;

			if (intent === "signup") {
				let hasCredentialSession = false;
				const credentialSession = await createNearzeroCredentialSession(
					intent,
					email,
					password,
				);
				if (credentialSession.ok) {
					// Existing account without a password has now been repaired.
					hasCredentialSession = true;
				} else if (credentialSession.code === "account_exists") {
					showToast(credentialSession.message, "error");
					return;
				} else if (credentialSession.code !== "no_account") {
					showToast(credentialSession.message, "error");
					return;
				}

				if (!hasCredentialSession) {
					const result = await authClient.signUp.email({
						email,
						password,
						name: email.split("@")[0] || "User",
						fetchOptions,
					});
					if (result.error) {
						showToast(
							authErrorMessage(result.error, "Could not create your account."),
							"error",
						);
						return;
					}
				}
			} else {
				const credentialSession = await createNearzeroCredentialSession(
					intent,
					email,
					password,
				);
				if (!credentialSession.ok) {
					showToast(credentialSession.message, "error");
					return;
				}
			}

			const sessionReady = await waitForEstablishedSession();
			if (!sessionReady) {
				showToast(
					"Signed in, but your session could not be saved in this browser. Try again in a private window.",
					"error",
				);
				return;
			}

			keepLocked = true;
			window.location.href =
				intent === "signup" && afterSignupUrl ? afterSignupUrl : callbackUrl;
		} catch {
			showToast(
				intent === "signup"
					? "Could not create your account right now."
					: "Could not sign in right now.",
				"error",
			);
		} finally {
			if (!keepLocked) unlockAuthPanel(root);
		}
	});

	const initialEmail = root.dataset.initialEmail?.trim();
	if (initialEmail && emailInput) {
		emailInput.value = initialEmail;
	}
}
