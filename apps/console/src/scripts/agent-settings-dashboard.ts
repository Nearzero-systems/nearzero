import { trpcMutate } from "@/lib/client-api";

const CONFIRM_PHRASE = "ALLOW PRODUCTION AGENT ACTIONS";

function updateOpenRouterBadge(
	root: HTMLElement,
	configured: boolean,
	source: "env" | "org" | "none",
) {
	const badge = document.getElementById("nz-agent-openrouter-badge");
	if (!badge) return;
	badge.className = [
		"nz-agent-settings__badge",
		configured ? "nz-agent-settings__badge--ok" : "",
	]
		.filter(Boolean)
		.join(" ");
	badge.textContent = configured
		? source === "env"
			? "Configured (platform ENV)"
			: "Configured (organization)"
		: "Not configured";
	root.setAttribute("data-openrouter-configured", configured ? "1" : "0");
	root.setAttribute("data-openrouter-source", source);
}

export function initAgentSettingsDashboard() {
	const root = document.getElementById("nz-agent-settings-root");
	if (!root) return;

	const checkbox = document.getElementById(
		"nz-agent-allow-production",
	) as HTMLInputElement | null;
	const policyToggles = Array.from(
		document.querySelectorAll<HTMLInputElement>("[data-agent-policy-toggle]"),
	);
	const confirmWrap = document.getElementById("nz-agent-confirm-wrap");
	const confirmInput = document.getElementById(
		"nz-agent-confirm-input",
	) as HTMLInputElement | null;
	const saveBtn = document.getElementById("nz-agent-save");
	const policyGatesSaveBtn = document.getElementById(
		"nz-agent-save-policy-gates",
	);
	const status = document.getElementById("nz-agent-save-status");
	const openRouterKeyInput = document.getElementById(
		"nz-agent-openrouter-key",
	) as HTMLInputElement | null;
	const openRouterSaveBtn = document.getElementById("nz-agent-openrouter-save");
	const openRouterClearBtn = document.getElementById(
		"nz-agent-openrouter-clear",
	);
	const openRouterStatus = document.getElementById(
		"nz-agent-openrouter-status",
	);
	let savedProduction = root.getAttribute("data-allow-production") === "1";

	if (
		!checkbox ||
		policyToggles.length === 0 ||
		!confirmWrap ||
		!confirmInput ||
		!saveBtn ||
		!status
	)
		return;

	checkbox.addEventListener("change", () => {
		const enabling = checkbox.checked && !savedProduction;
		confirmWrap.classList.toggle("hidden", !enabling);
		if (!enabling) confirmInput.value = "";
	});

	const saveAgentSettings = async () => {
		const next = checkbox.checked;
		if (
			next &&
			!savedProduction &&
			confirmInput.value.trim() !== CONFIRM_PHRASE
		) {
			status.textContent =
				"Confirmation phrase required to enable production actions.";
			return;
		}
		status.textContent = "Saving…";
		try {
			const payload = Object.fromEntries(
				policyToggles.flatMap((toggle) => {
					const key = toggle.dataset.agentPolicyToggle;
					return key ? [[key, toggle.checked]] : [];
				}),
			) as Record<string, boolean>;
			await trpcMutate("organizationSettings.updateAgentSettings", payload);
			root.setAttribute("data-allow-production", next ? "1" : "0");
			savedProduction = next;
			status.textContent = "Saved.";
			confirmWrap.classList.add("hidden");
			confirmInput.value = "";
		} catch (error) {
			status.textContent =
				error instanceof Error
					? error.message
					: "Failed to save Agent settings.";
		}
	};

	saveBtn.addEventListener("click", () => void saveAgentSettings());
	policyGatesSaveBtn?.addEventListener("click", () => void saveAgentSettings());

	if (openRouterKeyInput && openRouterSaveBtn && openRouterStatus) {
		openRouterSaveBtn.addEventListener("click", async () => {
			const apiKey = openRouterKeyInput.value.trim();
			if (apiKey.length < 8) {
				openRouterStatus.textContent = "Enter a valid OpenRouter API key.";
				return;
			}
			openRouterStatus.textContent = "Saving…";
			try {
				await trpcMutate("organizationSettings.setOrgOpenRouterKey", {
					apiKey,
				});
				openRouterKeyInput.value = "";
				root.setAttribute("data-has-stored-org-key", "1");
				openRouterClearBtn?.classList.remove("hidden");
				const source =
					root.getAttribute("data-openrouter-source") === "env" ? "env" : "org";
				updateOpenRouterBadge(root, true, source);
				openRouterStatus.textContent = "OpenRouter key saved.";
			} catch (error) {
				openRouterStatus.textContent =
					error instanceof Error
						? error.message
						: "Failed to save OpenRouter key.";
			}
		});
	}

	if (openRouterClearBtn && openRouterStatus) {
		openRouterClearBtn.addEventListener("click", async () => {
			openRouterStatus.textContent = "Clearing…";
			try {
				await trpcMutate(
					"organizationSettings.clearOrgOpenRouterKey",
					undefined,
				);
				root.setAttribute("data-has-stored-org-key", "0");
				openRouterClearBtn.classList.add("hidden");
				const source = root.getAttribute("data-openrouter-source") as
					| "env"
					| "org"
					| "none";
				const configured =
					root.getAttribute("data-openrouter-configured") === "1" &&
					source === "env";
				updateOpenRouterBadge(root, configured, configured ? "env" : "none");
				openRouterStatus.textContent = "Organization OpenRouter key cleared.";
			} catch (error) {
				openRouterStatus.textContent =
					error instanceof Error
						? error.message
						: "Failed to clear OpenRouter key.";
			}
		});
	}
}
