import {
	isOnboardingRegisterStep,
	loadOnboardingDraft,
	parseInviteEmails,
	parseRegisterStep,
	registerStepPath,
	saveOnboardingDraft,
	stepSubtitle,
	stepTitle,
	type OnboardingDraft,
	type RegisterStep,
} from "@/lib/register-onboarding";
import { invitationPath } from "@/lib/invitation-routes";
import {
	isOnboardingPanelLocked,
	lockOnboardingPanel,
	unlockOnboardingPanel,
} from "@/lib/onboarding-button-state";
import { trpcMutate, trpcQuery } from "@/lib/client-api";
import { orgDashboardPath } from "@/lib/org-routes";
import { showToast } from "@/scripts/ui";

type OnboardingStatus = {
	complete: boolean;
	profileComplete: boolean;
	firstName: string;
	organizationName: string;
	organizationSlug?: string | null;
	needsWorkspaceSetup?: boolean;
	needsInviteMemberSetup?: boolean;
	inviteMemberProfileComplete?: boolean;
};

const ACCEPTED_INVITE_ORG_ID_KEY = "nz-accepted-invitation-organization-id";

function isMissingProcedureError(err: unknown, procedure: string) {
	return (
		err instanceof Error &&
		err.message.includes("No procedure found") &&
		err.message.includes(procedure)
	);
}

function isPlaceholderPersonalOrgName(name: string | null | undefined) {
	const trimmed = name?.trim() ?? "";
	return !trimmed || trimmed === "My Organization";
}

async function activateAcceptedInvitationOrg() {
	const organizationId = sessionStorage
		.getItem(ACCEPTED_INVITE_ORG_ID_KEY)
		?.trim();
	if (!organizationId) return;
	await fetch("/api/auth/organization/set-active", {
		method: "POST",
		credentials: "include",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ organizationId }),
	}).catch(() => undefined);
}

function bindSelectField(
	root: HTMLElement,
	selector: string,
	getValue: () => string,
	setValue: (value: string) => void,
) {
	const select = root.querySelector<HTMLSelectElement>(selector);
	if (!select) return;
	select.value = getValue();
	select.addEventListener("change", () => {
		setValue(select.value);
	});
}

function syncProfileFromInputs(root: HTMLElement, draft: OnboardingDraft) {
	const nameInput = root.querySelector<HTMLInputElement>("[data-profile-name]");
	const workspaceInput = root.querySelector<HTMLInputElement>("[data-profile-workspace]");
	const nameFromDom = nameInput?.value.trim() ?? "";
	const workspaceFromDom = workspaceInput?.value.trim() ?? "";
	if (nameFromDom) draft.firstName = nameFromDom;
	if (workspaceFromDom) draft.workspaceName = workspaceFromDom;
	draft.workspaceMode = "solo";
}

function syncRoleFromSelect(root: HTMLElement, draft: OnboardingDraft) {
	const select = root.querySelector<HTMLSelectElement>("[data-role-select]");
	const value = select?.value.trim() ?? "";
	if (value) draft.role = value;
	const onPremSelect = root.querySelector<HTMLSelectElement>("[data-onprem-select]");
	const onPremValue = onPremSelect?.value.trim() ?? "";
	if (onPremValue) draft.needsOnPrem = onPremValue;
	const volumeSelect = root.querySelector<HTMLSelectElement>("[data-call-volume-select]");
	const volumeValue = volumeSelect?.value.trim() ?? "";
	if (volumeValue) draft.monthlyCallVolume = volumeValue;
	const migrationSelect = root.querySelector<HTMLSelectElement>("[data-migration-select]");
	const migrationValue = migrationSelect?.value.trim() ?? "";
	if (migrationValue) draft.migratingFromProvider = migrationValue;
}

function syncHeardAboutFromSelect(root: HTMLElement, draft: OnboardingDraft) {
	const select = root.querySelector<HTMLSelectElement>("[data-heard-about-select]");
	const value = select?.value.trim() ?? "";
	if (value) draft.heardAbout = value;
}

function syncDraftFromStorage(draft: OnboardingDraft) {
	const saved = loadOnboardingDraft();
	if (!draft.firstName.trim()) draft.firstName = saved.firstName.trim();
	if (!draft.workspaceName.trim()) draft.workspaceName = saved.workspaceName.trim();
	if (!draft.role.trim()) draft.role = saved.role.trim();
	if (!draft.heardAbout.trim()) draft.heardAbout = saved.heardAbout.trim();
	if (!draft.needsOnPrem.trim()) draft.needsOnPrem = saved.needsOnPrem.trim();
	if (!draft.monthlyCallVolume.trim()) draft.monthlyCallVolume = saved.monthlyCallVolume.trim();
	if (!draft.migratingFromProvider.trim()) {
		draft.migratingFromProvider = saved.migratingFromProvider.trim();
	}
}

function hasProfileDetails(draft: OnboardingDraft) {
	return Boolean(draft.firstName.trim() && draft.workspaceName.trim());
}

function missingQuestionnaireMessage(draft: OnboardingDraft) {
	if (!draft.role) return "Select what best describes you.";
	if (!draft.needsOnPrem) return "Select your on-prem deployment preference.";
	if (!draft.monthlyCallVolume) return "Select expected monthly call volume.";
	if (!draft.migratingFromProvider) return "Select whether you are migrating.";
	return "";
}

function setContinueButtonLabel(continueBtn: HTMLButtonElement, text: string) {
	const label = continueBtn.querySelector<HTMLElement>("[data-auth-btn-label]");
	if (label) label.textContent = text;
	continueBtn.dataset.defaultLabel = text;
}

function updateSkipVisibility(root: HTMLElement, draft?: OnboardingDraft) {
	const skipBtn = root.querySelector<HTMLButtonElement>("[data-onboarding-skip]");
	if (!skipBtn) return;
	const resolvedDraft = draft ?? loadOnboardingDraft();
	const step = parseRegisterStep(
		new URL(window.location.href).searchParams.get("step"),
	);
	const showSkip = step !== "profile" && hasProfileDetails(resolvedDraft);
	skipBtn.classList.toggle("hidden", !showSkip);
}

function setVisibleStage(root: HTMLElement, step: RegisterStep) {
	const inviteMemberSetupMode = root.dataset.inviteMemberSetup === "1";
	for (const panel of root.querySelectorAll<HTMLElement>("[data-register-stage]")) {
		panel.classList.toggle("hidden", panel.dataset.registerStage !== step);
	}
	const titleEl = root.querySelector<HTMLElement>("[data-register-title]");
	const subtitleEl = root.querySelector<HTMLElement>("[data-register-subtitle]");
	const loginLinkWrap = root.querySelector<HTMLElement>("[data-register-login-link]");
	const legalFooter = root.querySelector<HTMLElement>("[data-register-legal]");
	const oauthPanel = root.querySelector<HTMLElement>("[data-register-oauth]");
	const actionsPanel = root.querySelector<HTMLElement>("[data-onboarding-actions]");
	const inviteActionsPanel = root.querySelector<HTMLElement>("[data-onboarding-invite-actions]");
	const continueBtn = root.querySelector<HTMLButtonElement>("[data-onboarding-continue]");
	const isOnboarding = isOnboardingRegisterStep(step);

	if (titleEl) {
		titleEl.textContent =
			inviteMemberSetupMode && step === "profile"
				? "Welcome to the team"
				: stepTitle(step);
	}
	if (subtitleEl) {
		const text =
			inviteMemberSetupMode && step === "profile"
				? "Enter your name to finish joining the workspace."
				: stepSubtitle(step);
		subtitleEl.textContent = text;
		subtitleEl.classList.toggle("hidden", !text);
	}
	loginLinkWrap?.classList.toggle("hidden", step !== "signup");
	legalFooter?.classList.toggle("hidden", isOnboarding);
	oauthPanel?.classList.toggle("hidden", step !== "signup");
	if (actionsPanel) {
		const showActions = isOnboarding && step !== "invite";
		actionsPanel.classList.toggle("hidden", !showActions);
		actionsPanel.classList.toggle("flex", showActions);
	}
	if (inviteActionsPanel) {
		const showInviteActions = step === "invite";
		inviteActionsPanel.classList.toggle("hidden", !showInviteActions);
		inviteActionsPanel.classList.toggle("flex", showInviteActions);
	}
	if (continueBtn) {
		setContinueButtonLabel(
			continueBtn,
			inviteMemberSetupMode && step === "workspace" ? "Finish" : "Continue",
		);
	}
	const verifyFooter = root.querySelector<HTMLElement>("[data-otp-verify-footer]");
	if (verifyFooter) {
		const showVerifyFooter = step === "verify";
		verifyFooter.classList.toggle("hidden", !showVerifyFooter);
		verifyFooter.classList.toggle("flex", showVerifyFooter);
	}
	root.querySelector<HTMLElement>("[data-register-progress]")?.classList.add("hidden");
}

function navigateToStep(
	root: HTMLElement,
	step: RegisterStep,
	draft?: OnboardingDraft,
) {
	setVisibleStage(root, step);
	patchRegisterUrlStep(step);
	updateSkipVisibility(root, draft);
}

async function ensureOnboardingAccess(
	root: HTMLElement,
	step: RegisterStep,
	draft: OnboardingDraft,
) {
	if (step === "signup" || step === "verify") return true;
	const inviteMemberSetupMode = root.dataset.inviteMemberSetup === "1";
	try {
		const status = await trpcQuery<OnboardingStatus>("user.onboardingStatus");
		if (status?.complete) {
			window.location.href = "/dashboard/agent";
			return false;
		}
		if (inviteMemberSetupMode) {
			if (!draft.firstName.trim() && status?.firstName?.trim()) {
				draft.firstName = status.firstName.trim();
				saveOnboardingDraft(draft);
			}
			return true;
		}
		if (status && !status.profileComplete && step !== "profile") {
			if (!hasProfileDetails(draft)) {
				showToast("Enter your name and organization name first.", "error");
			}
			navigateToStep(root, "profile");
			return false;
		}
		return true;
	} catch {
		showToast("Sign in to continue registration.", "error");
		window.location.href = registerStepPath("signup");
		return false;
	}
}

async function persistOnboardingProfile(draft: OnboardingDraft) {
	if (!hasProfileDetails(draft)) {
		throw new Error("Enter your name and organization name first.");
	}
	await trpcMutate("user.saveOnboardingProfile", {
		firstName: draft.firstName.trim(),
		workspaceName: draft.workspaceName.trim(),
	});
}

function withOptionalOnboardingDefaults(draft: OnboardingDraft): OnboardingDraft {
	return {
		...draft,
		heardAbout: draft.heardAbout || "Other",
		role: draft.role || "Other",
		workspaceMode: "solo",
	};
}

async function finishOnboarding(
	root: HTMLElement,
	draft: OnboardingDraft,
	inviteEmails: string[] = [],
) {
	syncDraftFromStorage(draft);
	if (!hasProfileDetails(draft)) {
		showToast("Enter your name and organization name first.", "error");
		navigateToStep(root, "profile");
		return;
	}

	await persistOnboardingProfile(draft);
	const payload = withOptionalOnboardingDefaults(draft);
	const result = await trpcMutate<{ success: boolean; organizationSlug?: string }>(
		"user.completeOnboarding",
		{
			heardAbout: payload.heardAbout,
			role: payload.role,
			needsOnPrem: payload.needsOnPrem || undefined,
			monthlyCallVolume: payload.monthlyCallVolume || undefined,
			migratingFromProvider: payload.migratingFromProvider || undefined,
			workspaceMode: payload.workspaceMode,
			firstName: payload.firstName.trim(),
			workspaceName: payload.workspaceName.trim(),
			inviteEmails,
		},
	);
	sessionStorage.removeItem("nz-register-onboarding-draft");
	window.location.href = result?.organizationSlug
		? orgDashboardPath(result.organizationSlug, "/dashboard/agent")
		: "/dashboard/agent";
}

function bindProfileStep(root: HTMLElement, draft: OnboardingDraft) {
	const nameInput = root.querySelector<HTMLInputElement>("[data-profile-name]");
	const workspaceInput = root.querySelector<HTMLInputElement>("[data-profile-workspace]");
	if (nameInput) nameInput.value = draft.firstName;
	if (workspaceInput) workspaceInput.value = draft.workspaceName;

	const onProfileInput = () => {
		syncProfileFromInputs(root, draft);
		saveOnboardingDraft(draft);
		updateSkipVisibility(root, draft);
	};

	nameInput?.addEventListener("input", onProfileInput);
	workspaceInput?.addEventListener("input", onProfileInput);
	updateSkipVisibility(root, draft);
}

function bindRoleStep(root: HTMLElement, draft: OnboardingDraft) {
	bindSelectField(
		root,
		"[data-role-select]",
		() => draft.role,
		(value) => {
			draft.role = value;
			saveOnboardingDraft(draft);
		},
	);
	bindSelectField(
		root,
		"[data-onprem-select]",
		() => draft.needsOnPrem,
		(value) => {
			draft.needsOnPrem = value;
			saveOnboardingDraft(draft);
		},
	);
	bindSelectField(
		root,
		"[data-call-volume-select]",
		() => draft.monthlyCallVolume,
		(value) => {
			draft.monthlyCallVolume = value;
			saveOnboardingDraft(draft);
		},
	);
	bindSelectField(
		root,
		"[data-migration-select]",
		() => draft.migratingFromProvider,
		(value) => {
			draft.migratingFromProvider = value;
			saveOnboardingDraft(draft);
		},
	);
}

function bindHeardAboutStep(root: HTMLElement, draft: OnboardingDraft) {
	bindSelectField(
		root,
		"[data-heard-about-select]",
		() => draft.heardAbout,
		(value) => {
			draft.heardAbout = value;
			saveOnboardingDraft(draft);
		},
	);
}

function bindInviteStep(root: HTMLElement, draft: OnboardingDraft) {
	const textarea = root.querySelector<HTMLTextAreaElement>("[data-invite-emails]");
	const skipBtn = root.querySelector<HTMLButtonElement>("[data-invite-skip]");
	const submitBtn = root.querySelector<HTMLButtonElement>("[data-invite-submit]");
	const form = root.querySelector<HTMLFormElement>("[data-onboarding-invite-form]");

	const finish = async (
		emails: string[],
		activeButton: HTMLButtonElement | null | undefined,
	) => {
		if (!activeButton || isOnboardingPanelLocked(root)) return;
		if (!lockOnboardingPanel(root, activeButton)) return;

		let keepLocked = false;
		try {
			syncProfileFromInputs(root, draft);
			syncRoleFromSelect(root, draft);
			syncHeardAboutFromSelect(root, draft);
			syncDraftFromStorage(draft);
			saveOnboardingDraft(draft);
			await finishOnboarding(root, draft, emails);
			keepLocked = true;
		} catch (err) {
			showToast(err instanceof Error ? err.message : "Could not finish setup.", "error");
		} finally {
			if (!keepLocked) unlockOnboardingPanel(root);
		}
	};

	form?.addEventListener("submit", async (event) => {
		event.preventDefault();
		const emails = parseInviteEmails(textarea?.value ?? "");
		await finish(emails, submitBtn);
	});

	skipBtn?.addEventListener("click", () => {
		void finish([], skipBtn);
	});
}

async function finishWorkspaceSetup(draft: OnboardingDraft) {
	if (!draft.firstName.trim() || !draft.workspaceName.trim()) {
		throw new Error("Enter your name and organization name first.");
	}
	const result = await trpcMutate<{ organizationSlug?: string }>(
		"user.setupPersonalWorkspace",
		{
			firstName: draft.firstName.trim(),
			workspaceName: draft.workspaceName.trim(),
		},
	);
	sessionStorage.removeItem("nz-register-onboarding-draft");
	window.location.href = result?.organizationSlug
		? orgDashboardPath(result.organizationSlug, "/dashboard/agent")
		: "/dashboard/agent";
}

async function finishInviteMemberOnboarding(draft: OnboardingDraft) {
	const payload = withOptionalOnboardingDefaults(draft);
	const firstName = payload.firstName.trim();
	if (!firstName) {
		throw new Error("Enter your name first.");
	}
	await trpcMutate("user.saveInviteMemberProfile", {
		firstName,
	});
	let result: { organizationSlug?: string } | null = null;
	try {
		result = await trpcMutate<{ organizationSlug?: string }>(
			"user.completeInviteMemberOnboarding",
			{
				heardAbout: payload.heardAbout,
				role: payload.role,
				needsOnPrem: payload.needsOnPrem || undefined,
				monthlyCallVolume: payload.monthlyCallVolume || undefined,
				migratingFromProvider: payload.migratingFromProvider || undefined,
			},
		);
	} catch (err) {
		if (!isMissingProcedureError(err, "user.completeInviteMemberOnboarding")) {
			throw err;
		}

		await activateAcceptedInvitationOrg();
		const status = await trpcQuery<OnboardingStatus>("user.onboardingStatus").catch(
			() => null,
		);
		const workspaceName = status?.organizationName?.trim() ?? "";
		if (!isPlaceholderPersonalOrgName(workspaceName)) {
			result = await trpcMutate<{ organizationSlug?: string }>(
				"user.completeOnboarding",
				{
					heardAbout: payload.heardAbout,
					role: payload.role,
					needsOnPrem: payload.needsOnPrem || undefined,
					monthlyCallVolume: payload.monthlyCallVolume || undefined,
					migratingFromProvider: payload.migratingFromProvider || undefined,
					workspaceMode: "solo",
					firstName: payload.firstName.trim(),
					workspaceName,
					inviteEmails: [],
				},
			);
		} else {
			result = { organizationSlug: status?.organizationSlug ?? undefined };
		}
	}
	sessionStorage.removeItem("nz-register-onboarding-draft");
	sessionStorage.removeItem(ACCEPTED_INVITE_ORG_ID_KEY);
	window.location.href = result?.organizationSlug
		? orgDashboardPath(result.organizationSlug, "/dashboard/agent")
		: "/dashboard/agent";
}

function navigateToInviteMemberStep(root: HTMLElement, step: RegisterStep) {
	setVisibleStage(root, step);
	const url = new URL(window.location.href);
	url.searchParams.set("step", step);
	url.searchParams.set("mode", "invite-member");
	window.history.replaceState({}, "", `${url.pathname}${url.search}`);
}

function bindInviteMemberActions(
	root: HTMLElement,
	draft: OnboardingDraft,
	getStep: () => RegisterStep,
	setStep: (step: RegisterStep) => void,
) {
	const continueBtn = root.querySelector<HTMLButtonElement>("[data-onboarding-continue]");

	continueBtn?.addEventListener("click", () => {
		void (async () => {
			if (!continueBtn || isOnboardingPanelLocked(root)) return;

			const step = getStep();
			syncProfileFromInputs(root, draft);
			syncRoleFromSelect(root, draft);
			syncHeardAboutFromSelect(root, draft);
			syncDraftFromStorage(draft);
			saveOnboardingDraft(draft);

			if (step === "profile") {
				if (!draft.firstName.trim()) {
					showToast("Enter your name.", "error");
					return;
				}
				if (!lockOnboardingPanel(root, continueBtn)) return;
				try {
					setStep("role");
					navigateToInviteMemberStep(root, "role");
				} finally {
					unlockOnboardingPanel(root);
				}
				return;
			}

			if (step === "role") {
				if (!draft.firstName.trim()) {
					showToast("Enter your name first.", "error");
					navigateToInviteMemberStep(root, "profile");
					setStep("profile");
					return;
				}
				const questionnaireMessage = missingQuestionnaireMessage(draft);
				if (questionnaireMessage) {
					showToast(questionnaireMessage, "error");
					return;
				}
				if (!lockOnboardingPanel(root, continueBtn)) return;
				try {
					setStep("workspace");
					navigateToInviteMemberStep(root, "workspace");
				} finally {
					unlockOnboardingPanel(root);
				}
				return;
			}

			if (step === "workspace") {
				if (!draft.firstName.trim()) {
					showToast("Enter your name first.", "error");
					navigateToInviteMemberStep(root, "profile");
					setStep("profile");
					return;
				}
				const questionnaireMessage = missingQuestionnaireMessage(draft);
				if (questionnaireMessage) {
					showToast(questionnaireMessage, "error");
					navigateToInviteMemberStep(root, "role");
					setStep("role");
					return;
				}
				if (!draft.heardAbout) {
					showToast("Select how you heard about Nearzero.", "error");
					return;
				}
				if (!lockOnboardingPanel(root, continueBtn)) return;

				let keepLocked = false;
				try {
					await finishInviteMemberOnboarding(draft);
					keepLocked = true;
				} catch (err) {
					showToast(
						err instanceof Error ? err.message : "Could not finish setup.",
						"error",
					);
				} finally {
					if (!keepLocked) unlockOnboardingPanel(root);
				}
			}
		})();
	});
}

function bindWorkspaceSetupActions(root: HTMLElement, draft: OnboardingDraft) {
	const continueBtn = root.querySelector<HTMLButtonElement>("[data-onboarding-continue]");
	continueBtn?.addEventListener("click", () => {
		void (async () => {
			if (!continueBtn || isOnboardingPanelLocked(root)) return;

			syncProfileFromInputs(root, draft);
			if (!draft.firstName.trim()) {
				showToast("Enter your name.", "error");
				return;
			}
			if (!draft.workspaceName.trim()) {
				showToast("Enter an organization name.", "error");
				return;
			}
			if (!lockOnboardingPanel(root, continueBtn)) return;

			let keepLocked = false;
			try {
				await finishWorkspaceSetup(draft);
				keepLocked = true;
			} catch (err) {
				showToast(
					err instanceof Error ? err.message : "Could not create workspace.",
					"error",
				);
			} finally {
				if (!keepLocked) unlockOnboardingPanel(root);
			}
		})();
	});
}

function bindOnboardingActions(
	root: HTMLElement,
	draft: OnboardingDraft,
	getStep: () => RegisterStep,
	setStep: (step: RegisterStep) => void,
) {
	const continueBtn = root.querySelector<HTMLButtonElement>("[data-onboarding-continue]");
	const skipBtn = root.querySelector<HTMLButtonElement>("[data-onboarding-skip]");

	continueBtn?.addEventListener("click", () => {
		void (async () => {
			if (!continueBtn || isOnboardingPanelLocked(root)) return;

			const step = getStep();
			syncProfileFromInputs(root, draft);
			syncRoleFromSelect(root, draft);
			syncHeardAboutFromSelect(root, draft);
			syncDraftFromStorage(draft);
			saveOnboardingDraft(draft);

			if (step === "profile") {
				if (!draft.firstName.trim()) {
					showToast("Enter your name.", "error");
					return;
				}
				if (!draft.workspaceName.trim()) {
					showToast("Enter an organization name.", "error");
					return;
				}
				if (!lockOnboardingPanel(root, continueBtn)) return;
				try {
					await persistOnboardingProfile(draft);
					setStep("role");
					navigateToStep(root, "role", draft);
				} catch (err) {
					showToast(
						err instanceof Error ? err.message : "Could not save profile.",
						"error",
					);
				} finally {
					unlockOnboardingPanel(root);
				}
				return;
			}

			if (step === "role") {
				if (!hasProfileDetails(draft)) {
					showToast("Enter your name and organization name first.", "error");
					navigateToStep(root, "profile", draft);
					setStep("profile");
					return;
				}
				const questionnaireMessage = missingQuestionnaireMessage(draft);
				if (questionnaireMessage) {
					showToast(questionnaireMessage, "error");
					return;
				}
				if (!lockOnboardingPanel(root, continueBtn)) return;
				try {
					setStep("workspace");
					navigateToStep(root, "workspace", draft);
				} finally {
					unlockOnboardingPanel(root);
				}
				return;
			}

			if (step === "workspace") {
				if (!hasProfileDetails(draft)) {
					showToast("Enter your name and organization name first.", "error");
					navigateToStep(root, "profile", draft);
					setStep("profile");
					return;
				}
				if (!draft.heardAbout) {
					showToast("Select how you heard about Nearzero.", "error");
					return;
				}
				if (!lockOnboardingPanel(root, continueBtn)) return;
				try {
					setStep("invite");
					navigateToStep(root, "invite", draft);
				} finally {
					unlockOnboardingPanel(root);
				}
			}
		})();
	});

	skipBtn?.addEventListener("click", () => {
		void (async () => {
			if (!skipBtn || isOnboardingPanelLocked(root)) return;

			syncProfileFromInputs(root, draft);
			syncRoleFromSelect(root, draft);
			syncHeardAboutFromSelect(root, draft);
			syncDraftFromStorage(draft);
			if (!hasProfileDetails(draft)) {
				showToast("Enter your name and organization name first.", "error");
				navigateToStep(root, "profile", draft);
				setStep("profile");
				return;
			}
			if (!lockOnboardingPanel(root, skipBtn)) return;

			let keepLocked = false;
			try {
				saveOnboardingDraft(draft);
				await finishOnboarding(root, draft);
				keepLocked = true;
			} catch (err) {
				showToast(err instanceof Error ? err.message : "Could not finish setup.", "error");
			} finally {
				if (!keepLocked) unlockOnboardingPanel(root);
			}
		})();
	});
}

export async function bindRegisterOnboarding(root: HTMLElement) {
	if (root.dataset.onboardingBound === "1") return;
	root.dataset.onboardingBound = "1";

	const workspaceSetupMode = root.dataset.workspaceSetup === "1";
	const inviteMemberSetupMode = root.dataset.inviteMemberSetup === "1";
	const inviteToken =
		root.dataset.invitationToken?.trim() ||
		new URL(window.location.href).searchParams.get("token")?.trim() ||
		"";
	if (inviteToken && !workspaceSetupMode && !inviteMemberSetupMode) {
		window.location.href = invitationPath(inviteToken);
		return;
	}

	const step = parseRegisterStep(new URL(window.location.href).searchParams.get("step"));
	if (!isOnboardingRegisterStep(step)) return;

	if (step === "profile" && window.location.search.includes("step=source")) {
		window.history.replaceState({}, "", registerStepPath("profile"));
	}

	setVisibleStage(root, step);

	const draft = loadOnboardingDraft();
	let currentStep = step;

	if (!(await ensureOnboardingAccess(root, currentStep, draft))) return;

	bindProfileStep(root, draft);

	if (workspaceSetupMode) {
		bindWorkspaceSetupActions(root, draft);
		return;
	}

	if (inviteMemberSetupMode) {
		bindRoleStep(root, draft);
		bindHeardAboutStep(root, draft);
		if (currentStep !== "invite") {
			bindInviteMemberActions(
				root,
				draft,
				() => currentStep,
				(nextStep) => {
					currentStep = nextStep;
				},
			);
		}
		return;
	}

	bindRoleStep(root, draft);
	bindHeardAboutStep(root, draft);
	bindInviteStep(root, draft);

	if (currentStep !== "invite") {
		bindOnboardingActions(
			root,
			draft,
			() => currentStep,
			(nextStep) => {
				currentStep = nextStep;
			},
		);
	}

	updateSkipVisibility(root, draft);
}

export function patchRegisterUrlStep(step: RegisterStep) {
	const url = new URL(window.location.href);
	if (step === "signup") url.searchParams.delete("step");
	else url.searchParams.set("step", step);
	window.history.replaceState({}, "", `${url.pathname}${url.search}`);
}
