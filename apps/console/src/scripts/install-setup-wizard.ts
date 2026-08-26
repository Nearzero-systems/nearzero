import { authErrorMessage } from "@/lib/auth-form-classes";
import {
	extractSetupToken,
	extractSetupTokenFromHash,
	INSTALL_SETUP_DRAFT_KEY,
	INSTALL_SETUP_TOKEN_KEY,
	type InstallSetupWizardStep,
	inferInstallBaseDomain,
	isPublicInstallSetupReadiness,
	isPublicInstallSetupStatus,
	isPublicIpv4Input,
	normalizeBaseDomainInput,
	type PublicInstallSetupReadiness,
	type PublicInstallSetupStatus,
	parseInstallSetupStep,
	setupUrlWithoutToken,
	type SetupCheckState,
	suggestInstallDomains,
	wizardStepsForStatus,
} from "@/lib/install-setup";
import { showToast } from "@/scripts/ui";

type DnsMode = "managed" | "external";
type SetupAccessState =
	| "checking"
	| "authorized"
	| "missing"
	| "invalid"
	| "unavailable";

class SetupSessionError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "SetupSessionError";
	}
}

type Draft = {
	baseDomain?: string;
	managementHostname?: string;
	adminEmail?: string;
	publicIp?: string;
	managedDnsZone?: string;
	managedDnsSoaEmail?: string;
	dnsMode?: DnsMode;
	skipManagedDns?: boolean;
};

type DnsRecord = {
	id: string;
	type: "A" | "NS";
	name: string;
	value: string;
};

const STEP_NAMES = [
	"welcome",
	"management",
	"zone",
	"review",
	"verify",
	"done",
] as const;

const STEP_COPY: Record<
	InstallSetupWizardStep,
	{ title: string; subtitle: string; action: string }
> = {
	welcome: {
		title: "Set up your Nearzero server",
		subtitle:
			"Connect a domain, turn on HTTPS, and choose how deployed apps receive URLs.",
		action: "Start setup",
	},
	management: {
		title: "Choose your Nearzero URL",
		subtitle:
			"Enter one domain you control. Nearzero suggests safe subdomains without moving your website or email.",
		action: "Continue",
	},
	zone: {
		title: "Choose how app URLs work",
		subtitle:
			"Nearzero can assign a domain to every application and preview automatically.",
		action: "Review setup",
	},
	review: {
		title: "Review your domain setup",
		subtitle:
			"Nearzero applies these names once. Changing them later requires a domain migration.",
		action: "Apply this configuration",
	},
	verify: {
		title: "Connect DNS and verify HTTPS",
		subtitle:
			"Add the records at your DNS provider. Nearzero checks the public result automatically.",
		action: "Continue",
	},
	done: {
		title: "Nearzero is ready",
		subtitle:
			"Your public console is secured. Create the first owner account to finish setup.",
		action: "Continue",
	},
};

function readDraft(): Draft {
	try {
		const raw = localStorage.getItem(INSTALL_SETUP_DRAFT_KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw) as Draft;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function writeDraft(draft: Draft) {
	localStorage.setItem(INSTALL_SETUP_DRAFT_KEY, JSON.stringify(draft));
}

function clearLegacyStoredToken() {
	try {
		localStorage.removeItem(INSTALL_SETUP_TOKEN_KEY);
		sessionStorage.removeItem(INSTALL_SETUP_TOKEN_KEY);
	} catch {
		// Storage can be unavailable in hardened browsers. The wizard never writes it.
	}
}

function panel(root: HTMLElement, name: InstallSetupWizardStep) {
	return root.querySelector<HTMLElement>(`[data-setup-panel="${name}"]`);
}

function setButtonBusy(button: HTMLButtonElement | null, busy: boolean) {
	if (!button) return;
	button.disabled = busy;
	button.setAttribute("aria-busy", busy ? "true" : "false");
	const spinner = button.querySelector<HTMLElement>("[data-auth-btn-spinner]");
	if (spinner) spinner.classList.toggle("hidden", !busy);
}

function setText(root: ParentNode, selector: string, value: string) {
	const element = root.querySelector<HTMLElement>(selector);
	if (element) element.textContent = value;
}

function appendRecordPart(
	item: HTMLLIElement,
	label: string,
	value: string,
	options: { code?: boolean; copyable?: boolean } = {},
) {
	const wrap = document.createElement("span");
	wrap.className = "nz-install-setup__record-field";
	const small = document.createElement("small");
	small.textContent = label;
	const row = document.createElement("span");
	row.className = "nz-install-setup__record-value";
	const content = document.createElement(options.code ? "code" : "strong");
	content.textContent = value;
	row.append(content);
	if (options.copyable) {
		row.append(createCopyIconButton(`Copy ${label.toLowerCase()}`, value));
	}
	wrap.append(small, row);
	item.append(wrap);
}

function createCopyIconButton(ariaLabel: string, value: string) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "nz-install-setup__copy-icon";
	button.setAttribute("aria-label", ariaLabel);
	button.title = ariaLabel;
	button.innerHTML =
		'<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg>';
	button.addEventListener("click", async () => {
		try {
			await writeClipboard(value);
			showToast("Copied", "success");
		} catch (error) {
			showToast(
				error instanceof Error ? error.message : "Could not copy",
				"error",
			);
		}
	});
	return button;
}

async function writeClipboard(value: string) {
	if (navigator.clipboard?.writeText && window.isSecureContext) {
		await navigator.clipboard.writeText(value);
		return;
	}
	const textarea = document.createElement("textarea");
	textarea.value = value;
	textarea.setAttribute("readonly", "");
	textarea.style.position = "fixed";
	textarea.style.top = "0";
	textarea.style.left = "0";
	textarea.style.opacity = "0";
	document.body.appendChild(textarea);
	textarea.focus();
	textarea.select();
	textarea.setSelectionRange(0, textarea.value.length);
	const ok = document.execCommand("copy");
	textarea.remove();
	if (!ok) {
		throw new Error("Clipboard access is unavailable in this browser");
	}
}

export function bindInstallSetupWizard(root: HTMLElement) {
	clearLegacyStoredToken();
	const hashToken =
		extractSetupTokenFromHash(window.location.hash) ||
		null;
	const queryToken = extractSetupToken(
		new URL(window.location.href).searchParams.get("token") || "",
	);
	let pendingSetupToken = hashToken || queryToken;
	let setupAccessState: SetupAccessState =
		root.dataset.setupAuthorized === "true" &&
		root.dataset.setupHasStatus === "true"
			? "authorized"
			: root.dataset.setupAccessError === "unavailable"
				? "unavailable"
				: pendingSetupToken
					? "checking"
					: "missing";
	if (queryToken) {
		history.replaceState(null, "", setupUrlWithoutToken(window.location.href));
	}

	let status = JSON.parse(
		root.dataset.setupStatus || "{}",
	) as PublicInstallSetupStatus;
	let steps = wizardStepsForStatus(status);
	const configured = () =>
		status.phase === "configured" ||
		(status.managementConfigured && !status.canSubmit);
	const initialRequested = parseInstallSetupStep(
		new URL(window.location.href).searchParams.get("step"),
	);
	const initialFromData = parseInstallSetupStep(root.dataset.initialStep);
	const requestedInitial = initialFromData || initialRequested || "welcome";
	const safeInitial = configured()
		? "verify"
		: steps.includes(requestedInitial)
			? requestedInitial
			: "welcome";
	let stepIndex = Math.max(0, steps.indexOf(safeInitial));
	let readiness: PublicInstallSetupReadiness | null = null;
	let readinessTimer: number | null = null;
	let pollingStartedAt = 0;
	let checkingReadiness = false;
	let managementHostnameEdited = false;
	let managedZoneEdited = false;

	const progress = root.querySelector<HTMLElement>("[data-setup-progress]");
	const progressBar = root.querySelector<HTMLElement>(
		"[data-setup-progress-bar]",
	);
	const title = root.querySelector<HTMLElement>("[data-setup-title]");
	const subtitle = root.querySelector<HTMLElement>("[data-setup-subtitle]");
	const accessHeading = root.querySelector<HTMLElement>(
		"[data-setup-access-heading]",
	);
	const accessPanel = root.querySelector<HTMLElement>(
		"[data-setup-access-panel]",
	);
	const accessTitle = root.querySelector<HTMLElement>(
		"[data-setup-access-title]",
	);
	const accessMessage = root.querySelector<HTMLElement>(
		"[data-setup-access-message]",
	);
	const accessActions = root.querySelector<HTMLElement>(
		"[data-setup-access-actions]",
	);
	const wizard = root.querySelector<HTMLElement>("[data-setup-wizard]");
	const wizardChrome = root.querySelector<HTMLElement>(
		"[data-setup-wizard-chrome]",
	);
	const wizardActions = root.querySelector<HTMLElement>(
		"[data-setup-wizard-actions]",
	);
	const unlockBtn = root.querySelector<HTMLButtonElement>(
		"[data-setup-unlock]",
	);
	const unlockLabel = root.querySelector<HTMLElement>(
		"[data-setup-unlock-label]",
	);
	const errorEl = root.querySelector<HTMLElement>("[data-setup-error]");
	const backBtn = root.querySelector<HTMLButtonElement>("[data-setup-back]");
	const nextBtn = root.querySelector<HTMLButtonElement>("[data-setup-next]");
	const nextLabel = root.querySelector<HTMLElement>("[data-setup-next-label]");
	const checkBtn = root.querySelector<HTMLButtonElement>("[data-setup-check]");
	const registerLink = root.querySelector<HTMLAnchorElement>(
		"[data-setup-register]",
	);
	const openManagementLink = root.querySelector<HTMLAnchorElement>(
		"[data-setup-open-management]",
	);
	const canonicalUrl = root.querySelector<HTMLElement>(
		"[data-setup-canonical-url]",
	);
	const verifyStatus = root.querySelector<HTMLElement>(
		"[data-setup-verify-status]",
	);
	const lastChecked = root.querySelector<HTMLElement>(
		"[data-setup-last-checked]",
	);
	const dnsInstructions = root.querySelector<HTMLOListElement>(
		"[data-setup-dns-instructions]",
	);
	const copyAllButton = root.querySelector<HTMLButtonElement>(
		"[data-setup-copy-dns]",
	);
	const verifyTabs = root.querySelectorAll<HTMLButtonElement>(
		"[data-setup-verify-tab]",
	);

	function setVerifyView(view: "records" | "readiness") {
		for (const tab of verifyTabs) {
			tab.setAttribute(
				"aria-selected",
				tab.dataset.setupVerifyTab === view ? "true" : "false",
			);
		}
		for (const pane of root.querySelectorAll<HTMLElement>(
			"[data-setup-verify-view]",
		)) {
			pane.classList.toggle("hidden", pane.dataset.setupVerifyView !== view);
		}
	}

	const baseDomain = root.querySelector<HTMLInputElement>(
		"[data-setup-base-domain]",
	);
	const managementHostname = root.querySelector<HTMLInputElement>(
		"[data-setup-management-hostname]",
	);
	const adminEmail = root.querySelector<HTMLInputElement>(
		"[data-setup-admin-email]",
	);
	const publicIp = root.querySelector<HTMLInputElement>(
		"[data-setup-public-ip]",
	);
	const managedZone = root.querySelector<HTMLInputElement>(
		"[data-setup-managed-zone]",
	);
	const soaEmail = root.querySelector<HTMLInputElement>(
		"[data-setup-soa-email]",
	);
	const skipZone = root.querySelector<HTMLInputElement>(
		"[data-setup-skip-zone]",
	);
	const managedDnsMode = root.querySelector<HTMLInputElement>(
		'[data-setup-dns-mode="managed"]',
	);
	const externalDnsMode = root.querySelector<HTMLInputElement>(
		'[data-setup-dns-mode="external"]',
	);
	const zoneFields = root.querySelector<HTMLElement>(
		"[data-setup-zone-fields]",
	);
	const setupTokenInput = root.querySelector<HTMLInputElement>(
		"[data-setup-token]",
	);

	const draft = readDraft();
	managementHostnameEdited = Boolean(draft.managementHostname);
	managedZoneEdited = Boolean(draft.managedDnsZone);
	const inferredBase = inferInstallBaseDomain(status);
	if (baseDomain) baseDomain.value = draft.baseDomain || inferredBase;
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
	const initialDnsMode: DnsMode =
		draft.dnsMode ||
		(draft.skipManagedDns ||
		status.managedDnsSkipped ||
		!status.managedDnsEnabled
			? "external"
			: "managed");
	if (managedDnsMode) managedDnsMode.checked = initialDnsMode === "managed";
	if (externalDnsMode) externalDnsMode.checked = initialDnsMode === "external";
	if (skipZone) skipZone.checked = initialDnsMode === "external";

	function currentDnsMode(): DnsMode {
		return managedDnsMode?.checked && status.managedDnsEnabled
			? "managed"
			: "external";
	}

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

	function syncDomainSuggestions() {
		const plan = suggestInstallDomains(baseDomain?.value || "");
		if (plan) {
			if (
				managementHostname &&
				!managementHostnameEdited &&
				!status.managementHostname
			) {
				managementHostname.value = plan.managementHostname;
			}
			if (managedZone && !managedZoneEdited && !status.managedDnsZone) {
				managedZone.value = plan.managedDnsZone;
			}
		}
		setText(
			root,
			"[data-setup-derived-management]",
			managementHostname?.value.trim() || "nearzero.example.com",
		);
		setText(
			root,
			"[data-setup-derived-zone]",
			managedZone?.value.trim() || "apps.example.com",
		);
	}

	function syncDnsChoice() {
		const managed = currentDnsMode() === "managed";
		if (skipZone) skipZone.checked = !managed;
		zoneFields?.classList.toggle("hidden", !managed);
	}

	function captureDraft() {
		writeDraft({
			baseDomain: baseDomain?.value.trim(),
			managementHostname: managementHostname?.value.trim(),
			adminEmail: adminEmail?.value.trim(),
			publicIp: publicIp?.value.trim(),
			managedDnsZone: managedZone?.value.trim(),
			managedDnsSoaEmail: soaEmail?.value.trim(),
			dnsMode: currentDnsMode(),
			skipManagedDns: currentDnsMode() === "external",
		});
	}

	function managementUrl() {
		const host =
			managementHostname?.value.trim() || status.managementHostname || "";
		return host ? `https://${host}` : "";
	}

	function updateCanonicalLinks() {
		const url = managementUrl();
		if (canonicalUrl)
			canonicalUrl.textContent = url || "Waiting for your domain";
		if (openManagementLink) {
			openManagementLink.href = url || "#";
		}
		if (registerLink) {
			registerLink.href = url ? `${url}/register` : "/register";
		}
	}

	function updateReview() {
		const managed = currentDnsMode() === "managed";
		setText(
			root,
			"[data-setup-review-management]",
			managementUrl() || "Not configured",
		);
		setText(
			root,
			"[data-setup-review-dns-mode]",
			managed ? "Nearzero DNS" : "External DNS",
		);
		setText(
			root,
			"[data-setup-review-zone]",
			managed ? managedZone?.value.trim() || "Not configured" : "Not required",
		);
		setText(
			root,
			"[data-setup-review-ip]",
			publicIp?.value.trim() || "Not configured",
		);
		setText(
			root,
			"[data-setup-review-email]",
			adminEmail?.value.trim() || "Not configured",
		);
		setText(
			root,
			"[data-setup-review-ports]",
			managed ? "TCP 80, 443 · UDP/TCP 53" : "TCP 80, 443",
		);
	}

	function recordsForConfiguration(): DnsRecord[] {
		const host =
			managementHostname?.value.trim() || status.managementHostname || "";
		const ip = publicIp?.value.trim() || status.publicIp || "";
		const records: DnsRecord[] = [];
		if (currentDnsMode() !== "managed") {
			records.push({ id: "management-a", type: "A", name: host, value: ip });
			return records;
		}
		const zone = managedZone?.value.trim() || status.managedDnsZone || "";
		const managementIsInsideZone =
			Boolean(zone) && (host === zone || host.endsWith(`.${zone}`));
		if (!managementIsInsideZone) {
			records.push({ id: "management-a", type: "A", name: host, value: ip });
		}
		if (!zone) return records;
		for (const nameserver of ["ns1", "ns2"] as const) {
			records.push({
				id: `${nameserver}-a`,
				type: "A",
				name: `${nameserver}.${zone}`,
				value: ip,
			});
		}
		for (const nameserver of ["ns1", "ns2"] as const) {
			records.push({
				id: `${nameserver}-ns`,
				type: "NS",
				name: zone,
				value: `${nameserver}.${zone}`,
			});
		}
		return records;
	}

	function renderDnsInstructions() {
		if (!dnsInstructions) return;
		dnsInstructions.replaceChildren();
		for (const record of recordsForConfiguration()) {
			const item = document.createElement("li");
			item.dataset.setupDnsRecord = record.id;
			appendRecordPart(item, "Type", record.type);
			appendRecordPart(item, "Name", record.name, {
				code: true,
				copyable: true,
			});
			appendRecordPart(item, "Value", record.value, {
				code: true,
				copyable: true,
			});
			dnsInstructions.append(item);
		}
	}

	async function exchangeSetupSession(token: string) {
		const response = await fetch("/api/install/setup/session", {
			method: "POST",
			credentials: "same-origin",
			headers: {
				accept: "application/json",
				"content-type": "application/json",
			},
			body: JSON.stringify({ token }),
		});
		const body = await response.json().catch(() => null);
		if (!response.ok) {
			throw new SetupSessionError(
				authErrorMessage(body, "Invalid or expired setup link"),
				response.status,
			);
		}
	}

	async function validateSetupSession() {
		const response = await fetch("/api/install/setup/session", {
			method: "GET",
			credentials: "same-origin",
			headers: { accept: "application/json" },
			cache: "no-store",
		});
		if (response.ok) return;
		const body = await response.json().catch(() => null);
		throw new SetupSessionError(
			authErrorMessage(body, "Setup authorization is no longer valid"),
			response.status,
		);
	}

	function lockInput(
		input: HTMLInputElement | null,
		locked: boolean,
		value: string | null,
	) {
		if (!input || !value) return;
		if (locked || !input.value.trim()) input.value = value;
		if (!locked) return;
		input.readOnly = true;
		input.dataset.setupLocked = "true";
		input.setAttribute(
			"aria-description",
			"This value was fixed by the installer",
		);
	}

	function applyAuthorizedConfiguration(value: PublicInstallSetupReadiness) {
		const { configuration } = value;
		const { lockedFields } = configuration;
		lockInput(
			managementHostname,
			lockedFields.managementHostname,
			configuration.managementHostname,
		);
		if (lockedFields.managementHostname && configuration.managementHostname) {
			managementHostnameEdited = true;
		}
		lockInput(adminEmail, lockedFields.adminEmail, configuration.adminEmail);
		lockInput(publicIp, lockedFields.publicIp, configuration.publicIp);
		lockInput(
			managedZone,
			lockedFields.managedDnsZone,
			configuration.managedDnsZone,
		);
		if (lockedFields.managedDnsZone && configuration.managedDnsZone) {
			managedZoneEdited = true;
			if (managedDnsMode) managedDnsMode.checked = true;
			if (externalDnsMode) {
				externalDnsMode.checked = false;
				externalDnsMode.disabled = true;
			}
		}
		lockInput(
			soaEmail,
			lockedFields.managedDnsSoaEmail,
			configuration.managedDnsSoaEmail,
		);
		syncDomainSuggestions();
		syncDnsChoice();
		captureDraft();
	}

	function clearCredentialFromAddressBar() {
		history.replaceState(null, "", setupUrlWithoutToken(window.location.href));
	}

	function renderSetupAccess() {
		const authorized = setupAccessState === "authorized";
		accessPanel?.classList.toggle("hidden", authorized);
		accessActions?.classList.toggle("hidden", authorized);
		wizard?.classList.toggle("hidden", !authorized);
		wizardChrome?.classList.toggle("hidden", !authorized);
		wizardChrome?.classList.toggle("flex", authorized);
		wizardActions?.classList.toggle("hidden", !authorized);
		wizardActions?.classList.toggle("flex", authorized);
		title?.classList.toggle("hidden", !authorized);
		accessHeading?.classList.toggle("hidden", authorized);
		if (accessPanel) accessPanel.dataset.accessState = setupAccessState;

		const copy =
			setupAccessState === "checking"
				? {
						title: "Verifying the installer link",
						message:
							"Nearzero is exchanging the one-time token for a protected browser session.",
						button: "Verifying…",
					}
				: setupAccessState === "invalid"
					? {
							title: "This setup link is not valid",
							message:
								"The token is expired or belongs to another installation. Generate a new link on this server and try again.",
							button: "Verify setup link",
						}
					: setupAccessState === "unavailable"
						? {
								title: "Nearzero could not verify the setup link",
								message: pendingSetupToken
									? "The server may still be starting. Your token remains in this tab; retry when Nearzero is ready."
									: "The setup service is unavailable. Confirm Nearzero is running, then paste a newly generated setup link.",
								button: pendingSetupToken ? "Retry verification" : "Verify setup link",
							}
						: {
								title: "Use the one-time installer link",
								message:
									"This page is locked. Open the complete one-time URL generated by this Nearzero installation, or paste it below.",
								button: "Verify setup link",
							};
		if (accessTitle) accessTitle.textContent = copy.title;
		if (accessMessage) accessMessage.textContent = copy.message;
		if (unlockLabel) unlockLabel.textContent = copy.button;
		setButtonBusy(unlockBtn, setupAccessState === "checking");

		if (!authorized) {
			const url = new URL(window.location.href);
			url.searchParams.delete("step");
			history.replaceState(
				null,
				"",
				`${url.pathname}${url.search}${url.hash}`,
			);
		}
	}

	async function authorizeSetup(token: string) {
		pendingSetupToken = token;
		setupAccessState = "checking";
		showError(null);
		renderSetupAccess();
		try {
			await exchangeSetupSession(token);
			pendingSetupToken = null;
			clearCredentialFromAddressBar();
			if (setupTokenInput) setupTokenInput.value = "";
			window.location.reload();
		} catch (error) {
			if (error instanceof SetupSessionError && error.status === 403) {
				pendingSetupToken = null;
				clearCredentialFromAddressBar();
				window.location.reload();
				return;
			}
			if (error instanceof SetupSessionError && error.status === 401) {
				pendingSetupToken = null;
				clearCredentialFromAddressBar();
				if (setupTokenInput) setupTokenInput.value = "";
				setupAccessState = "invalid";
			} else {
				setupAccessState = "unavailable";
			}
			renderSetupAccess();
		}
	}

	async function requireAuthorizedSession() {
		if (setupAccessState !== "authorized") {
			renderSetupAccess();
			return false;
		}
		try {
			await validateSetupSession();
			return true;
		} catch (error) {
			setupAccessState =
				error instanceof SetupSessionError &&
				(error.status === 401 || error.status === 403)
					? "invalid"
					: "unavailable";
			renderSetupAccess();
			return false;
		}
	}

	if (setupAccessState === "authorized" && pendingSetupToken) {
		pendingSetupToken = null;
		clearCredentialFromAddressBar();
	}

	const authorizedConfigurationPromise =
		setupAccessState === "authorized"
			? (async () => {
					if (configured() || !(await requireAuthorizedSession())) return;
					const response = await fetch("/api/install/setup/readiness", {
						method: "POST",
						credentials: "same-origin",
						headers: { accept: "application/json" },
					});
					if (!response.ok) return;
					const body = (await response.json().catch(() => null)) as unknown;
					if (isPublicInstallSetupReadiness(body)) {
						applyAuthorizedConfiguration(body);
					}
				})().catch(() => {
					// This prefill is optional; every action revalidates the signed session.
				})
			: Promise.resolve();

	if (setupAccessState !== "authorized" && pendingSetupToken) {
		void authorizeSetup(pendingSetupToken);
	}

	async function submitSetup() {
		if (!(await requireAuthorizedSession())) return false;
		captureDraft();
		const payload = {
			managementHostname: managementHostname?.value.trim() || "",
			adminEmail: adminEmail?.value.trim() || "",
			publicIp: publicIp?.value.trim() || undefined,
			managedDnsZone:
				currentDnsMode() === "external"
					? null
					: managedZone?.value.trim() || null,
			managedDnsSoaEmail:
				currentDnsMode() === "external" ? null : soaEmail?.value.trim() || null,
			skipManagedDns: currentDnsMode() === "external",
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
			const message = authErrorMessage(body, "Failed to apply install setup");
			if (response.status === 401 || response.status === 403) {
				setupAccessState = "invalid";
				renderSetupAccess();
				return false;
			}
			throw new Error(message);
		}
		if (isPublicInstallSetupStatus(body)) {
			status = body;
			steps = wizardStepsForStatus(status);
		}
		localStorage.removeItem(INSTALL_SETUP_DRAFT_KEY);
		updateCanonicalLinks();
		showToast("Domain configuration applied", "success");
		return true;
	}

	function readinessLabel(state: SetupCheckState) {
		switch (state) {
			case "ready":
				return "Ready";
			case "pending":
				return "Waiting";
			case "failed":
				return "Needs attention";
			case "warning":
				return "Check";
			case "not_applicable":
				return "Not required";
		}
	}

	function renderReadinessRow(
		id: string,
		state: SetupCheckState,
		message: string,
	) {
		const row = root.querySelector<HTMLElement>(
			`[data-setup-readiness-row="${id}"]`,
		);
		if (!row) return;
		row.dataset.readinessState =
			state === "ready"
				? "ready"
				: state === "failed"
					? "error"
					: state === "pending"
						? "checking"
						: "idle";
		setText(row, "[data-setup-readiness-status]", readinessLabel(state));
		setText(row, "[data-setup-readiness-message]", message);
	}

	function renderCheckingState() {
		for (const id of [
			"management-dns",
			"https-certificate",
			"zone-delegated",
			"authoritative-soa",
		]) {
			renderReadinessRow(id, "pending", "Checking public readiness…");
		}
	}

	function canFinish() {
		return readiness?.ready === true;
	}

	function renderReadiness(value: PublicInstallSetupReadiness) {
		readiness = value;
		const managementDnsState: SetupCheckState =
			value.management.aRecord.status === "ready"
				? "ready"
				: value.management.aRecord.status === "not_configured"
					? "failed"
					: "pending";
		const managementHttpsState: SetupCheckState =
			value.management.https.status === "ready"
				? "ready"
				: value.management.https.status === "failed"
					? "failed"
					: "pending";
		renderReadinessRow(
			"management-dns",
			managementDnsState,
			value.management.aRecord.diagnostic,
		);
		renderReadinessRow(
			"https-certificate",
			managementHttpsState,
			value.management.https.diagnostic,
		);
		const application = value.managedDns;
		const applicationState: SetupCheckState = application.skipped
			? "not_applicable"
			: application.status === "ready"
				? "ready"
				: application.status === "not_configured"
					? "failed"
					: "pending";
		renderReadinessRow(
			"zone-delegated",
			application.zoneName
				? application.delegated
					? "ready"
					: applicationState
				: "not_applicable",
			application.zoneName
				? application.delegated
					? "Public NS records point to Nearzero."
					: application.diagnostics[0] || "Add the NS records shown above."
				: "External DNS was selected.",
		);
		renderReadinessRow(
			"authoritative-soa",
			application.zoneName
				? application.authoritativeSoa
					? "ready"
					: applicationState
				: "not_applicable",
			application.zoneName
				? application.authoritativeSoa
					? "CoreDNS answers authoritatively on port 53."
					: application.diagnostics.at(-1) ||
						"Allow inbound UDP and TCP 53 to this server."
				: "External DNS was selected.",
		);
		if (lastChecked) {
			const checked = new Date(value.checkedAt);
			lastChecked.textContent = Number.isNaN(checked.getTime())
				? "Checked now"
				: `Checked ${checked.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
		}
		if (verifyStatus) {
			verifyStatus.textContent = canFinish()
				? "The HTTPS console and selected application DNS mode are ready. Continue to create the first owner."
				: managementDnsState !== "ready"
					? value.management.aRecord.diagnostic
					: managementHttpsState !== "ready"
						? value.management.https.diagnostic
						: application.diagnostics[0] ||
							"Finish the application-zone delegation and check again.";
		}
		render();
	}

	async function checkReadiness(options: { quiet?: boolean } = {}) {
		if (checkingReadiness) return;
		if (!(await requireAuthorizedSession())) return;
		checkingReadiness = true;
		setButtonBusy(checkBtn, true);
		if (checkBtn) checkBtn.textContent = "Checking…";
		if (!options.quiet) setVerifyView("readiness");
		renderCheckingState();
		try {
			const response = await fetch("/api/install/setup/readiness", {
				method: "POST",
				credentials: "same-origin",
				headers: { accept: "application/json" },
			});
			const body = await response.json().catch(() => null);
			if (!response.ok) {
				throw new Error(
					authErrorMessage(body, "Could not check DNS readiness"),
				);
			}
			if (!isPublicInstallSetupReadiness(body)) {
				throw new Error("Nearzero returned an invalid readiness response");
			}
			renderReadiness(body);
			if (!options.quiet) {
				showToast(
					canFinish() ? "Public console is ready" : "Readiness refreshed",
					"success",
				);
			}
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Could not check readiness";
			showError(message);
			if (!options.quiet) showToast(message, "error");
		} finally {
			checkingReadiness = false;
			setButtonBusy(checkBtn, false);
			if (checkBtn) checkBtn.textContent = "Check again";
			scheduleReadinessCheck();
		}
	}

	function clearReadinessTimer() {
		if (readinessTimer !== null) window.clearTimeout(readinessTimer);
		readinessTimer = null;
	}

	function scheduleReadinessCheck() {
		clearReadinessTimer();
		const step = steps[stepIndex];
		if (
			step !== "verify" ||
			document.hidden ||
			!navigator.onLine ||
			canFinish()
		) {
			return;
		}
		if (!pollingStartedAt) pollingStartedAt = Date.now();
		const elapsed = Date.now() - pollingStartedAt;
		const delay = elapsed < 120_000 ? 10_000 : 30_000;
		readinessTimer = window.setTimeout(() => {
			void checkReadiness({ quiet: true });
		}, delay);
	}

	function renderStepRail(step: InstallSetupWizardStep) {
		for (const item of root.querySelectorAll<HTMLElement>(
			"[data-setup-step-item]",
		)) {
			const name = parseInstallSetupStep(item.dataset.setupStepItem);
			if (!name || !steps.includes(name)) {
				item.classList.add("hidden");
				continue;
			}
			item.classList.remove("hidden");
			const index = steps.indexOf(name);
			const number = item.querySelector<HTMLElement>(
				".nz-install-setup__step-number",
			);
			if (number) number.textContent = String(index + 1);
			item.dataset.stepState =
				index < stepIndex ? "complete" : name === step ? "current" : "upcoming";
			item.setAttribute("aria-current", name === step ? "step" : "false");
		}
	}

	function render() {
		renderSetupAccess();
		if (setupAccessState !== "authorized") {
			clearReadinessTimer();
			return;
		}
		const step = steps[stepIndex] ?? "welcome";
		for (const name of STEP_NAMES) {
			const element = panel(root, name);
			if (!element) continue;
			const active = name === step;
			element.classList.toggle("hidden", !active);
			element.classList.toggle("flex", active);
		}
		const copy = STEP_COPY[step];
		if (progress)
			progress.textContent = `Step ${stepIndex + 1} of ${steps.length}`;
		if (progressBar) {
			progressBar.style.width = `${((stepIndex + 1) / steps.length) * 100}%`;
		}
		if (title) title.textContent = copy.title;
		if (subtitle) subtitle.textContent = copy.subtitle;
		renderStepRail(step);

		if (backBtn) {
			backBtn.classList.toggle("hidden", stepIndex === 0);
		}
		if (nextBtn) {
			const showNext = step !== "done" && (step !== "verify" || canFinish());
			nextBtn.classList.toggle("hidden", !showNext);
			if (nextLabel) nextLabel.textContent = copy.action;
		}
		if (checkBtn) checkBtn.classList.toggle("hidden", step !== "verify");
		if (registerLink) registerLink.classList.toggle("hidden", step !== "done");

		if (step === "management") syncDomainSuggestions();
		if (step === "zone") syncDnsChoice();
		if (step === "review") updateReview();
		if (step === "verify") {
			renderDnsInstructions();
			updateCanonicalLinks();
			if (!readiness && !checkingReadiness) {
				window.setTimeout(() => void checkReadiness({ quiet: true }), 0);
			}
		} else {
			clearReadinessTimer();
		}
		if (step === "done") updateCanonicalLinks();

		const url = new URL(window.location.href);
		url.searchParams.set("step", step);
		history.replaceState(
			null,
			"",
			`${url.pathname}${url.search}${url.hash}`,
		);
	}

	function validateManagement() {
		const normalized = normalizeBaseDomainInput(baseDomain?.value || "");
		baseDomain?.setCustomValidity(
			normalized
				? ""
				: "Enter a domain only, for example example.com. Do not include https:// or a path.",
		);
		if (!baseDomain?.reportValidity()) return false;
		if (!managementHostname?.reportValidity()) return false;
		if (!adminEmail?.reportValidity()) return false;
		publicIp?.setCustomValidity(
			isPublicIpv4Input(publicIp?.value || "")
				? ""
				: "Enter this server's publicly routable IPv4 address. Private, loopback, and documentation addresses cannot receive public DNS traffic.",
		);
		if (!publicIp?.reportValidity()) return false;
		return true;
	}

	function validateZone() {
		if (currentDnsMode() === "external") return true;
		if (!managedZone?.value.trim()) {
			managedZone?.setCustomValidity(
				"Enter the application zone Nearzero should manage.",
			);
			managedZone?.reportValidity();
			return false;
		}
		managedZone.setCustomValidity("");
		if (!managedZone.reportValidity()) return false;
		const normalizedBase = normalizeBaseDomainInput(baseDomain?.value || "");
		if (
			normalizedBase &&
			managedZone.value.trim().toLowerCase() === normalizedBase
		) {
			showError(
				`Delegating ${normalizedBase} would move all DNS for the root domain. Use apps.${normalizedBase} unless you intend a full migration.`,
			);
			return false;
		}
		return true;
	}

	async function goNext() {
		showError(null);
		const step = steps[stepIndex] ?? "welcome";
		try {
			if (!(await requireAuthorizedSession())) return;
			if (step === "management") await authorizedConfigurationPromise;
			if (step === "management" && !validateManagement()) return;
			if (step === "zone" && !validateZone()) return;
			captureDraft();
			if (step === "review") {
				setButtonBusy(nextBtn, true);
				if (nextLabel) nextLabel.textContent = "Configuring Nearzero…";
				if (!(await submitSetup())) {
					setButtonBusy(nextBtn, false);
					return;
				}
				setButtonBusy(nextBtn, false);
				stepIndex = steps.indexOf("verify");
				readiness = null;
				pollingStartedAt = Date.now();
				render();
				return;
			}
			if (step === "verify") {
				if (!canFinish()) return;
				stepIndex = steps.indexOf("done");
				render();
				return;
			}
			if (stepIndex < steps.length - 1) {
				stepIndex += 1;
				render();
			}
		} catch (error) {
			setButtonBusy(nextBtn, false);
			if (nextLabel) nextLabel.textContent = STEP_COPY[step].action;
			const message =
				error instanceof Error ? error.message : "Setup failed unexpectedly";
			showError(message);
			showToast(message, "error");
		}
	}

	backBtn?.addEventListener("click", async () => {
		if (!(await requireAuthorizedSession())) return;
		showError(null);
		if (stepIndex > 0) {
			stepIndex -= 1;
			render();
		}
	});
	nextBtn?.addEventListener("click", () => void goNext());
	checkBtn?.addEventListener("click", () => void checkReadiness());
	async function unlockSetup() {
		const token =
			pendingSetupToken || extractSetupToken(setupTokenInput?.value || "");
		if (!token) {
			setupAccessState = "missing";
			renderSetupAccess();
			setupTokenInput?.focus();
			return;
		}
		await authorizeSetup(token);
	}
	unlockBtn?.addEventListener("click", () => void unlockSetup());
	for (const tab of verifyTabs) {
		tab.addEventListener("click", () => {
			const view = tab.dataset.setupVerifyTab;
			if (view === "records" || view === "readiness") setVerifyView(view);
		});
	}
	copyAllButton?.addEventListener("click", async () => {
		try {
			const value = recordsForConfiguration()
				.map((record) => `${record.type}\t${record.name}\t${record.value}`)
				.join("\n");
			await writeClipboard(value);
			showToast("DNS records copied", "success");
		} catch (error) {
			showToast(
				error instanceof Error ? error.message : "Could not copy DNS records",
				"error",
			);
		}
	});

	baseDomain?.addEventListener("input", () => {
		syncDomainSuggestions();
		captureDraft();
	});
	managementHostname?.addEventListener("input", () => {
		managementHostnameEdited = true;
		syncDomainSuggestions();
		captureDraft();
	});
	managedZone?.addEventListener("input", () => {
		managedZoneEdited = true;
		syncDomainSuggestions();
		captureDraft();
	});
	for (const input of [adminEmail, publicIp, soaEmail]) {
		input?.addEventListener("input", captureDraft);
		input?.addEventListener("change", captureDraft);
	}
	setupTokenInput?.addEventListener("input", () => {
		const token = extractSetupToken(setupTokenInput.value);
		pendingSetupToken = token;
		setupAccessState = token ? "missing" : "missing";
		showError(null);
		renderSetupAccess();
	});
	setupTokenInput?.addEventListener("keydown", (event) => {
		if (event.key !== "Enter") return;
		event.preventDefault();
		void unlockSetup();
	});
	for (const choice of [managedDnsMode, externalDnsMode]) {
		choice?.addEventListener("change", () => {
			syncDnsChoice();
			captureDraft();
		});
	}

	document.addEventListener("visibilitychange", () => {
		if (document.hidden) clearReadinessTimer();
		else scheduleReadinessCheck();
	});
	window.addEventListener("online", scheduleReadinessCheck);
	window.addEventListener("offline", clearReadinessTimer);

	if (!baseDomain?.value) {
		if (baseDomain) baseDomain.value = inferInstallBaseDomain(status);
	}
	syncDomainSuggestions();
	syncDnsChoice();
	updateReview();
	updateCanonicalLinks();
	render();
}
