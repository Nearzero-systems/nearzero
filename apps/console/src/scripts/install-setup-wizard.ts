import { authErrorMessage } from "@/lib/auth-form-classes";
import {
	extractSetupTokenFromHash,
	INSTALL_SETUP_DRAFT_KEY,
	INSTALL_SETUP_TOKEN_KEY,
	isPublicInstallSetupStatus,
	parseInstallSetupStep,
	type InstallSetupWizardStep,
	type PublicInstallSetupStatus,
	wizardStepsForStatus,
} from "@/lib/install-setup";
import { showToast } from "@/scripts/ui";

type Draft = {
	managementHostname?: string;
	adminEmail?: string;
	publicIp?: string;
	managedDnsZone?: string;
	managedDnsSoaEmail?: string;
	skipManagedDns?: boolean;
};

function readDraft(): Draft {
	try {
		const raw = sessionStorage.getItem(INSTALL_SETUP_DRAFT_KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw) as Draft;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function writeDraft(draft: Draft) {
	sessionStorage.setItem(INSTALL_SETUP_DRAFT_KEY, JSON.stringify(draft));
}

function persistToken(token: string | null) {
	if (!token) return;
	sessionStorage.setItem(INSTALL_SETUP_TOKEN_KEY, token);
}

function readToken() {
	return sessionStorage.getItem(INSTALL_SETUP_TOKEN_KEY)?.trim() || "";
}

function panel(root: HTMLElement, name: InstallSetupWizardStep) {
	return root.querySelector<HTMLElement>(`[data-setup-panel="${name}"]`);
}

function setBusy(button: HTMLButtonElement | null, busy: boolean) {
	if (!button) return;
	button.disabled = busy;
	button.setAttribute("aria-busy", busy ? "true" : "false");
	const spinner = button.querySelector<HTMLElement>("[data-auth-btn-spinner]");
	const label = button.querySelector<HTMLElement>("[data-setup-next-label]");
	if (spinner) spinner.classList.toggle("hidden", !busy);
	if (label && busy) label.textContent = "Working…";
}

export function bindInstallSetupWizard(root: HTMLElement) {
	const fromHash = extractSetupTokenFromHash(window.location.hash);
	if (fromHash) {
		persistToken(fromHash);
		history.replaceState(
			null,
			"",
			`${window.location.pathname}${window.location.search}`,
		);
	}

	let status = JSON.parse(
		root.dataset.setupStatus || "{}",
	) as PublicInstallSetupStatus;
	let steps = wizardStepsForStatus(status);
	const initial =
		parseInstallSetupStep(root.dataset.initialStep) ||
		parseInstallSetupStep(new URL(window.location.href).searchParams.get("step")) ||
		(status.resumeStep as InstallSetupWizardStep) ||
		"welcome";
	let stepIndex = Math.max(0, steps.indexOf(initial));

	const progress = root.querySelector<HTMLElement>("[data-setup-progress]");
	const title = root.querySelector<HTMLElement>("[data-setup-title]");
	const subtitle = root.querySelector<HTMLElement>("[data-setup-subtitle]");
	const errorEl = root.querySelector<HTMLElement>("[data-setup-error]");
	const backBtn = root.querySelector<HTMLButtonElement>("[data-setup-back]");
	const nextBtn = root.querySelector<HTMLButtonElement>("[data-setup-next]");
	const nextLabel = root.querySelector<HTMLElement>("[data-setup-next-label]");
	const checkBtn = root.querySelector<HTMLButtonElement>("[data-setup-check]");
	const registerLink = root.querySelector<HTMLAnchorElement>("[data-setup-register]");
	const verifyStatus = root.querySelector<HTMLElement>("[data-setup-verify-status]");
	const dnsInstructions = root.querySelector<HTMLElement>(
		"[data-setup-dns-instructions]",
	);

	const managementHostname = root.querySelector<HTMLInputElement>(
		"[data-setup-management-hostname]",
	);
	const adminEmail = root.querySelector<HTMLInputElement>("[data-setup-admin-email]");
	const publicIp = root.querySelector<HTMLInputElement>("[data-setup-public-ip]");
	const managedZone = root.querySelector<HTMLInputElement>("[data-setup-managed-zone]");
	const soaEmail = root.querySelector<HTMLInputElement>("[data-setup-soa-email]");
	const skipZone = root.querySelector<HTMLInputElement>("[data-setup-skip-zone]");

	const draft = readDraft();
	if (managementHostname && draft.managementHostname) {
		managementHostname.value = draft.managementHostname;
	}
	if (adminEmail && draft.adminEmail) adminEmail.value = draft.adminEmail;
	if (publicIp && draft.publicIp) publicIp.value = draft.publicIp;
	if (managedZone && draft.managedDnsZone) {
		managedZone.value = draft.managedDnsZone;
	}
	if (soaEmail && draft.managedDnsSoaEmail) {
		soaEmail.value = draft.managedDnsSoaEmail;
	}
	if (skipZone) skipZone.checked = Boolean(draft.skipManagedDns);

	const titles: Record<InstallSetupWizardStep, string> = {
		welcome: "Connect this Nearzero host",
		management: "Management domain",
		zone: "Application domain",
		verify: "Verify DNS",
		done: "Ready for the first owner",
	};
	const subtitles: Record<InstallSetupWizardStep, string> = {
		welcome:
			"One-time setup assigns the public management hostname before the first owner account is created.",
		management:
			"This hostname becomes the console URL. It is not the application zone used by deployed services.",
		zone: "Optional. Skip if you will use an external DNS provider for application hostnames.",
		verify:
			"Finish the A record (and NS delegation when using managed DNS), then continue.",
		done: "Create the first owner account with the configured administrator email.",
	};

	function showError(message: string | null) {
		if (!errorEl) return;
		if (!message) {
			errorEl.classList.add("hidden");
			errorEl.textContent = "";
			return;
		}
		errorEl.textContent = message;
		errorEl.classList.remove("hidden");
	}

	function captureDraft() {
		writeDraft({
			managementHostname: managementHostname?.value.trim(),
			adminEmail: adminEmail?.value.trim(),
			publicIp: publicIp?.value.trim(),
			managedDnsZone: managedZone?.value.trim(),
			managedDnsSoaEmail: soaEmail?.value.trim(),
			skipManagedDns: Boolean(skipZone?.checked),
		});
	}

	function renderDnsInstructions() {
		if (!dnsInstructions) return;
		const host =
			managementHostname?.value.trim() || status.managementHostname || "nearzero.example.com";
		const ip = publicIp?.value.trim() || status.publicIp || "<public-ip>";
		const zone =
			managedZone?.value.trim() || status.managedDnsZone || null;
		const items = [
			`A record: <code class="rounded bg-[#f7f7f8] px-1">${host}</code> → <code class="rounded bg-[#f7f7f8] px-1">${ip}</code>`,
			"Allow inbound TCP 80 and 443 to this server for Let's Encrypt and the console.",
		];
		if (zone && !skipZone?.checked) {
			items.push(
				`NS records for <code class="rounded bg-[#f7f7f8] px-1">${zone}</code> → <code class="rounded bg-[#f7f7f8] px-1">ns1.${zone}</code> and <code class="rounded bg-[#f7f7f8] px-1">ns2.${zone}</code>`,
				`Glue A records: <code class="rounded bg-[#f7f7f8] px-1">ns1.${zone}</code> and <code class="rounded bg-[#f7f7f8] px-1">ns2.${zone}</code> → <code class="rounded bg-[#f7f7f8] px-1">${ip}</code>`,
			);
		}
		dnsInstructions.innerHTML = items.map((item) => `<li>${item}</li>`).join("");
	}

	async function refreshStatus() {
		const response = await fetch("/api/install/setup-status", {
			method: "GET",
			credentials: "same-origin",
			headers: { accept: "application/json" },
			cache: "no-store",
		});
		if (!response.ok) return status;
		const value = (await response.json().catch(() => null)) as unknown;
		if (isPublicInstallSetupStatus(value)) {
			status = value;
			steps = wizardStepsForStatus(status);
			root.dataset.setupStatus = JSON.stringify(status);
		}
		return status;
	}

	function updateVerifyCopy() {
		if (!verifyStatus) return;
		if (status.managementConfigured) {
			verifyStatus.textContent =
				"Management hostname saved. Open the public hostname over HTTPS after DNS propagates; certificate issuance can take a few minutes.";
		} else {
			verifyStatus.textContent =
				"Submit the management domain first so Nearzero can configure Traefik and Let's Encrypt.";
		}
	}

	function render() {
		const step = steps[stepIndex] ?? "welcome";
		for (const name of ["welcome", "management", "zone", "verify", "done"] as const) {
			const el = panel(root, name);
			if (!el) continue;
			const active = name === step;
			el.classList.toggle("hidden", !active);
			el.classList.toggle("flex", active);
		}
		if (progress) {
			progress.textContent = `Step ${stepIndex + 1} of ${steps.length}`;
		}
		if (title) title.textContent = titles[step];
		if (subtitle) subtitle.textContent = subtitles[step];
		if (backBtn) backBtn.classList.toggle("hidden", stepIndex === 0);
		if (nextBtn) {
			const hideNext = step === "done";
			nextBtn.classList.toggle("hidden", hideNext);
			if (nextLabel) {
				nextLabel.textContent =
					step === "verify"
						? "Continue"
						: step === "management" || step === "zone"
							? "Save and continue"
							: "Continue";
			}
		}
		if (checkBtn) checkBtn.classList.toggle("hidden", step !== "verify");
		if (registerLink) registerLink.classList.toggle("hidden", step !== "done");
		if (step === "verify") {
			renderDnsInstructions();
			updateVerifyCopy();
		}
		const url = new URL(window.location.href);
		url.searchParams.set("step", step);
		history.replaceState(null, "", `${url.pathname}${url.search}`);
	}

	async function submitSetup() {
		const token = readToken();
		if (!token) {
			throw new Error(
				"Missing setup token. Open the setup URL printed by the installer again.",
			);
		}
		captureDraft();
		const payload = {
			token,
			managementHostname: managementHostname?.value.trim() || "",
			adminEmail: adminEmail?.value.trim() || "",
			publicIp: publicIp?.value.trim() || undefined,
			managedDnsZone:
				skipZone?.checked || !status.managedDnsEnabled
					? null
					: managedZone?.value.trim() || null,
			managedDnsSoaEmail:
				skipZone?.checked || !status.managedDnsEnabled
					? null
					: soaEmail?.value.trim() || null,
			skipManagedDns: Boolean(skipZone?.checked) || !status.managedDnsEnabled,
		};
		const response = await fetch("/api/install/setup", {
			method: "POST",
			credentials: "same-origin",
			headers: {
				accept: "application/json",
				"content-type": "application/json",
			},
			body: JSON.stringify(payload),
		});
		const body = await response.json().catch(() => null);
		if (!response.ok) {
			throw new Error(authErrorMessage(body, "Failed to apply install setup"));
		}
		if (isPublicInstallSetupStatus(body)) {
			status = body;
			steps = wizardStepsForStatus(status);
		}
		showToast("Management domain saved", "success");
	}

	async function goNext() {
		showError(null);
		const step = steps[stepIndex] ?? "welcome";
		try {
			if (step === "management") {
				if (!managementHostname?.reportValidity() || !adminEmail?.reportValidity()) {
					return;
				}
				if (!publicIp?.reportValidity()) return;
				// If zone step follows, wait to submit until after zone choices.
				if (steps.includes("zone")) {
					captureDraft();
					stepIndex += 1;
					render();
					return;
				}
				setBusy(nextBtn, true);
				await submitSetup();
				setBusy(nextBtn, false);
				stepIndex = steps.indexOf("verify");
				render();
				return;
			}
			if (step === "zone") {
				if (!skipZone?.checked && managedZone?.value.trim()) {
					if (!managedZone.reportValidity()) return;
				}
				setBusy(nextBtn, true);
				await submitSetup();
				setBusy(nextBtn, false);
				stepIndex = steps.indexOf("verify");
				render();
				return;
			}
			if (step === "verify") {
				await refreshStatus();
				stepIndex = steps.indexOf("done");
				render();
				return;
			}
			if (stepIndex < steps.length - 1) {
				stepIndex += 1;
				render();
			}
		} catch (error) {
			setBusy(nextBtn, false);
			const message =
				error instanceof Error ? error.message : "Setup failed unexpectedly";
			showError(message);
			showToast(message, "error");
		}
	}

	backBtn?.addEventListener("click", () => {
		showError(null);
		if (stepIndex > 0) {
			stepIndex -= 1;
			render();
		}
	});
	nextBtn?.addEventListener("click", () => {
		void goNext();
	});
	checkBtn?.addEventListener("click", async () => {
		await refreshStatus();
		updateVerifyCopy();
		showToast("Readiness refreshed", "success");
	});
	for (const input of [
		managementHostname,
		adminEmail,
		publicIp,
		managedZone,
		soaEmail,
	]) {
		input?.addEventListener("change", captureDraft);
		input?.addEventListener("input", captureDraft);
	}
	skipZone?.addEventListener("change", captureDraft);

	render();
}
