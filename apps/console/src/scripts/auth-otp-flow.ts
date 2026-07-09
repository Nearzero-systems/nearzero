import {
	isAuthPanelLocked,
	lockAuthPanel,
	unlockAuthPanel,
} from "@/lib/auth-button-state";
import { getAuthEmailValidationError } from "@/lib/auth-email-policy";
import { authErrorMessage } from "@/lib/auth-form-classes";
import {
	readPendingInvitationToken,
	resolveInvitationTokenFromPage,
} from "@/lib/invitation-routes";
import { showToast } from "@/scripts/ui";

export type AuthOtpIntent = "login" | "signup";

export type AuthOtpFlowOptions = {
	root: HTMLElement;
	callbackUrl: string;
	intent: AuthOtpIntent;
	loginHref?: string;
	registerHref?: string;
	invitationToken?: string;
	getSignupName?: () => string;
	/** After email OTP signup verify, navigate here instead of callbackUrl. */
	afterSignupVerifyUrl?: string;
	onEnterVerifyStage?: () => void;
	initialStage?: "email" | "verify";
	initialPendingEmail?: string;
};

const RESEND_COOLDOWN_SECONDS = 45;
const OTP_SENT_AT_KEY = "nz-auth-otp-sent-at";
const OTP_PENDING_EMAIL_KEY = "nz-register-pending-email";

function readOtpSentRemainingSeconds() {
	const sentAt = Number(sessionStorage.getItem(OTP_SENT_AT_KEY));
	if (!Number.isFinite(sentAt) || sentAt <= 0) return 0;
	const elapsed = Math.floor((Date.now() - sentAt) / 1000);
	return Math.max(0, RESEND_COOLDOWN_SECONDS - elapsed);
}

function markOtpSent() {
	sessionStorage.setItem(OTP_SENT_AT_KEY, String(Date.now()));
}

function isValidOtpCode(code: string) {
	return /^\d{6}$/.test(code);
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

function formatCountdown(totalSeconds: number) {
	const safeSeconds = Math.max(0, Math.ceil(Number(totalSeconds) || 0));
	const minutes = Math.floor(safeSeconds / 60);
	const seconds = safeSeconds % 60;
	return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function bindAuthOtpFlow(options: AuthOtpFlowOptions) {
	const {
		root,
		callbackUrl,
		intent,
		loginHref = "/login",
		registerHref = "/register",
		invitationToken = "",
		getSignupName,
		afterSignupVerifyUrl,
		onEnterVerifyStage,
		initialStage = "email",
		initialPendingEmail = "",
	} = options;

	if (root.dataset.bound === "1") return;
	root.dataset.bound = "1";

	const emailStage = root.querySelector<HTMLElement>(
		"[data-otp-stage='email']",
	);
	const verifyStage = root.querySelector<HTMLElement>(
		"[data-otp-stage='verify']",
	);
	const subtitleEmail = root.querySelector<HTMLElement>(
		"[data-otp-subtitle-email]",
	);
	const subtitleVerify = root.querySelector<HTMLElement>(
		"[data-otp-subtitle-verify]",
	);
	const verifyEmailLabel = root.querySelector<HTMLElement>(
		"[data-otp-verify-email]",
	);
	const oauthPanel = root.querySelector<HTMLElement>("[data-otp-oauth-panel]");
	const verifyFooter = root.querySelector<HTMLElement>(
		"[data-otp-verify-footer]",
	);
	const legalFooter = root.querySelector<HTMLElement>(
		"[data-otp-legal-footer]",
	);
	const registerLoginLink = root.querySelector<HTMLElement>(
		"[data-register-login-link]",
	);

	const emailForm = root.querySelector<HTMLFormElement>(
		"[data-otp-email-form]",
	);
	const verifyForm = root.querySelector<HTMLFormElement>(
		"[data-otp-verify-form]",
	);
	const emailInput = root.querySelector<HTMLInputElement>(
		"[data-otp-email-input]",
	);
	const codeInput = root.querySelector<HTMLInputElement>(
		"[data-otp-code-input]",
	);
	const emailSubmit = root.querySelector<HTMLButtonElement>(
		"[data-otp-email-submit]",
	);
	const verifySubmit = root.querySelector<HTMLButtonElement>(
		"[data-otp-verify-submit]",
	);
	const resendBtn = root.querySelector<HTMLButtonElement>(
		"[data-otp-resend-btn]",
	);
	const useDifferentEmail = root.querySelector<HTMLElement>(
		"[data-otp-use-different-email]",
	);

	let pendingEmail = "";
	let resendRemaining = 0;
	let resendTimer: ReturnType<typeof setInterval> | null = null;

	function setStage(stage: "email" | "verify") {
		emailStage?.classList.toggle("hidden", stage !== "email");
		verifyStage?.classList.toggle("hidden", stage !== "verify");
		subtitleEmail?.classList.toggle("hidden", stage !== "email");
		subtitleVerify?.classList.toggle("hidden", stage !== "verify");
		oauthPanel?.classList.toggle("hidden", stage !== "email");
		verifyFooter?.classList.toggle("hidden", stage !== "verify");
		verifyFooter?.classList.toggle("flex", stage === "verify");
		legalFooter?.classList.toggle("hidden", stage === "verify");
		registerLoginLink?.classList.toggle("hidden", stage !== "email");
	}

	function updateResendLabel() {
		if (!resendBtn) return;
		const label = resendBtn.querySelector<HTMLElement>("[data-auth-btn-label]");
		if (resendRemaining > 0) {
			if (label) label.textContent = `Resend in ${formatCountdown(resendRemaining)}`;
			resendBtn.disabled = true;
		} else {
			if (label) {
				label.textContent = resendBtn.dataset.defaultLabel || "Resend code";
			}
			if (!isAuthPanelLocked(root)) resendBtn.disabled = false;
		}
	}

	function startResendCooldown(seconds = RESEND_COOLDOWN_SECONDS) {
		resendRemaining = seconds;
		updateResendLabel();
		if (resendTimer) clearInterval(resendTimer);
		resendTimer = setInterval(() => {
			resendRemaining = Math.max(0, resendRemaining - 1);
			updateResendLabel();
			if (resendRemaining <= 0 && resendTimer) {
				clearInterval(resendTimer);
				resendTimer = null;
			}
		}, 1000);
	}

	async function sendOtp(
		normalizedEmail: string,
		options?: { silent?: boolean; isResend?: boolean },
	) {
		const validationError = getAuthEmailValidationError(normalizedEmail);
		if (validationError) {
			showToast(validationError, "error");
			return false;
		}

		const res = await fetch("/api/auth/email-otp/send-verification-otp", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-nearzero-auth-intent": intent,
			},
			credentials: "include",
			body: JSON.stringify({ email: normalizedEmail, type: "sign-in" }),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) {
			if (res.status === 429) {
				const retryAfter = Number(res.headers.get("retry-after"));
				const wait =
					Number.isFinite(retryAfter) && retryAfter > 0
						? ` Try again in ${formatCountdown(retryAfter)}.`
						: " Please wait a moment and try again.";
				showToast(`Too many code requests.${wait}`, "error");
				if (Number.isFinite(retryAfter) && retryAfter > 0) {
					startResendCooldown(retryAfter);
				}
				return false;
			}
			const fallback = options?.isResend
				? "Could not resend your verification code yet."
				: "Failed to send your verification code.";
			const message = authErrorMessage(data, fallback);
			const friendly =
				res.status === 403 && message.toLowerCase().includes("origin")
					? "Sign-in session conflict. Try logging out or use a private window, then try again."
					: message;
			showToast(friendly, "error");
			return false;
		}

		pendingEmail = normalizedEmail;
		if (intent === "signup") {
			sessionStorage.setItem(OTP_PENDING_EMAIL_KEY, normalizedEmail);
		}
		markOtpSent();
		if (verifyEmailLabel) verifyEmailLabel.textContent = normalizedEmail;
		if (codeInput) codeInput.value = "";
		if (!options?.isResend) {
			setStage("verify");
			onEnterVerifyStage?.();
		}
		startResendCooldown();
		if (options?.isResend) {
			showToast("We sent a new verification code to your email.", "success");
		} else if (!options?.silent) {
			showToast("We sent a verification code to your email.", "success");
		}
		return true;
	}

	emailForm?.addEventListener("submit", async (event) => {
		event.preventDefault();
		if (isAuthPanelLocked(root) || !emailSubmit) return;

		const normalizedEmail = (emailInput?.value || "").trim().toLowerCase();
		const validationError = getAuthEmailValidationError(normalizedEmail);
		if (validationError) {
			showToast(validationError, "error");
			return;
		}
		if (intent === "signup" && getSignupName) {
			const name = getSignupName().trim();
			if (!name) {
				showToast("Enter your name.", "error");
				return;
			}
		}
		if (!lockAuthPanel(root, emailSubmit)) return;

		try {
			await sendOtp(normalizedEmail, { silent: true });
		} finally {
			unlockAuthPanel(root);
		}
	});

	verifyForm?.addEventListener("submit", async (event) => {
		event.preventDefault();
		if (isAuthPanelLocked(root) || !verifySubmit) return;

		const code = (codeInput?.value || "").trim();
		if (!pendingEmail) {
			pendingEmail =
				sessionStorage.getItem(OTP_PENDING_EMAIL_KEY)?.trim().toLowerCase() ??
				"";
		}
		if (!pendingEmail) {
			showToast(
				"Enter your email again to receive a verification code.",
				"error",
			);
			setStage("email");
			return;
		}
		if (!code) {
			showToast(
				"Enter the 6-digit verification code from your email.",
				"error",
			);
			return;
		}
		if (!isValidOtpCode(code)) {
			showToast("Enter the 6-digit code from your email.", "error");
			return;
		}
		if (!lockAuthPanel(root, verifySubmit)) return;

		let keepLocked = false;
		try {
			const headers: Record<string, string> = {
				"content-type": "application/json",
				"x-nearzero-auth-intent": intent,
			};
			const resolvedInvitationToken =
				invitationToken ||
				resolveInvitationTokenFromPage() ||
				readPendingInvitationToken() ||
				"";
			if (resolvedInvitationToken) {
				headers["x-nearzero-token"] = resolvedInvitationToken;
			}
			const body: Record<string, string> = {
				email: pendingEmail,
				otp: code,
			};
			if (intent === "signup" && getSignupName) {
				const name = getSignupName().trim();
				if (name) body.name = name;
			}
			const res = await fetch("/api/auth/sign-in/email-otp", {
				method: "POST",
				headers,
				credentials: "include",
				body: JSON.stringify(body),
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) {
				const message = authErrorMessage(data, "Verification failed.");
				const friendly =
					message === "Invalid OTP"
						? "That code is incorrect or expired. Check your email or resend a new code."
						: message;
				showToast(friendly, "error");
				return;
			}
			if (intent === "signup") {
				sessionStorage.removeItem(OTP_PENDING_EMAIL_KEY);
			}
			sessionStorage.removeItem(OTP_SENT_AT_KEY);

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
				intent === "signup" && afterSignupVerifyUrl
					? afterSignupVerifyUrl
					: callbackUrl;
		} catch {
			showToast("Could not verify the code right now.", "error");
		} finally {
			if (!keepLocked) unlockAuthPanel(root);
		}
	});

	resendBtn?.addEventListener("click", async (event) => {
		event.preventDefault();
		if (isAuthPanelLocked(root)) return;

		if (!pendingEmail) {
			pendingEmail =
				sessionStorage.getItem(OTP_PENDING_EMAIL_KEY)?.trim().toLowerCase() ??
				"";
		}
		if (!pendingEmail) {
			showToast(
				"Enter your email again to receive a verification code.",
				"error",
			);
			setStage("email");
			return;
		}
		if (resendRemaining > 0) {
			showToast(
				`You can resend in ${formatCountdown(resendRemaining)}.`,
				"error",
			);
			return;
		}
		if (!lockAuthPanel(root, resendBtn)) return;

		try {
			await sendOtp(pendingEmail, { isResend: true });
		} finally {
			unlockAuthPanel(root);
			updateResendLabel();
		}
	});

	useDifferentEmail?.addEventListener("click", () => {
		setStage("email");
		if (codeInput) codeInput.value = "";
		resendRemaining = 0;
		updateResendLabel();
	});

	const initialEmail = root.dataset.initialEmail?.trim();
	if (initialEmail && emailInput) {
		emailInput.value = initialEmail;
	}

	if (initialStage === "verify" && initialPendingEmail) {
		pendingEmail = initialPendingEmail;
		if (verifyEmailLabel) verifyEmailLabel.textContent = pendingEmail;
		setStage("verify");
		const remaining = readOtpSentRemainingSeconds();
		if (remaining > 0) {
			startResendCooldown(remaining);
		} else {
			startResendCooldown(RESEND_COOLDOWN_SECONDS);
		}
	}
}
