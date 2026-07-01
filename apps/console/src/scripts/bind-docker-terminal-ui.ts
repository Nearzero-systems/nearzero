import { trpcQuery } from "@/lib/client-api";
import {
	disconnectDockerTerminal,
	mountDockerTerminal,
} from "@/scripts/docker-terminal";
import { closeDialog, openDialog } from "@/scripts/ui";

function formatContainerTabLabel(containerId: string) {
	if (!containerId) return "terminal";
	if (containerId.length <= 18) return containerId;
	return `${containerId.slice(0, 8)}…${containerId.slice(-4)}`;
}

export function updateDockerTerminalChrome(
	dialogId: string,
	opts: { sectionLabel?: string; nameLabel?: string; tabLabel?: string },
) {
	if (opts.sectionLabel) {
		const section = document.getElementById(`${dialogId}-crumb-section`);
		if (section) section.textContent = opts.sectionLabel;
	}
	if (opts.nameLabel) {
		const name = document.getElementById(`${dialogId}-crumb-name`);
		if (name) name.textContent = opts.nameLabel;
	}
	if (opts.tabLabel) {
		const tab = document.getElementById(`${dialogId}-crumb-tab`);
		if (tab) tab.textContent = opts.tabLabel;
	}
}

export function bindDockerTerminalUi(opts: {
	openBtnId: string;
	dialogId: string;
	hostId: string;
	containerSelectId: string;
	shellSelectId: string;
	closeRequestId: string;
	appName: string;
	serverId?: string;
	appType?: "stack" | "docker-compose";
	sectionLabel?: string;
	nameLabel?: string;
	confirmCloseDialogId?: string;
	confirmCloseBtnId?: string;
	confirmCloseCancelId?: string;
	defaultShell?: "bash" | "sh";
}) {
	const termBtn = document.getElementById(opts.openBtnId);
	const termDlg = document.getElementById(opts.dialogId);
	const termHost = document.getElementById(opts.hostId);
	const termSelect = document.getElementById(
		opts.containerSelectId,
	) as HTMLSelectElement | null;
	const termWay = document.getElementById(
		opts.shellSelectId,
	) as HTMLSelectElement | null;

	if (
		!(termBtn instanceof HTMLButtonElement) ||
		termBtn.dataset.nzTerminalBound === "1" ||
		!(termDlg instanceof HTMLDialogElement) ||
		!termHost
	) {
		return;
	}
	termBtn.dataset.nzTerminalBound = "1";

	const optionsBtn = document.getElementById(`${opts.dialogId}-options-btn`);
	const optionsPanel = document.getElementById(`${opts.dialogId}-options-panel`);

	const closeOptionsPanel = () => {
		optionsPanel?.classList.add("hidden");
		optionsBtn?.setAttribute("aria-expanded", "false");
	};

	const toggleOptionsPanel = () => {
		if (!optionsPanel) return;
		const willOpen = optionsPanel.classList.contains("hidden");
		optionsPanel.classList.toggle("hidden", !willOpen);
		optionsBtn?.setAttribute("aria-expanded", willOpen ? "true" : "false");
	};

	optionsBtn?.addEventListener("click", (event) => {
		event.stopPropagation();
		toggleOptionsPanel();
	});

	termDlg.addEventListener("click", (event) => {
		if (!(event.target instanceof Node)) return;
		if (optionsBtn?.contains(event.target)) return;
		if (optionsPanel?.contains(event.target)) return;
		closeOptionsPanel();
	});

	let termCleanup: (() => void) | null = null;

	const updateTabChrome = () => {
		updateDockerTerminalChrome(opts.dialogId, {
			tabLabel: formatContainerTabLabel(termSelect?.value ?? ""),
		});
	};

	const loadContainers = async () => {
		if (!termSelect) return;
		termSelect.innerHTML = `<option value="">Loading...</option>`;
		const data = await trpcQuery<
			Array<{ containerId: string; name: string; state: string }>
		>("docker.getContainersByAppNameMatch", {
			appName: opts.appName,
			serverId: opts.serverId || undefined,
			appType: opts.appType,
		});
		termSelect.innerHTML = `<option value="">Select a container</option>`;
		for (const c of data ?? []) {
			const opt = document.createElement("option");
			opt.value = c.containerId;
			opt.textContent = `${c.name} (${c.containerId}) — ${c.state}`;
			termSelect.appendChild(opt);
		}
		if (data?.[0]) termSelect.value = data[0].containerId;
		updateTabChrome();
	};

	const mountTerm = () => {
		if (!(termHost instanceof HTMLElement) || !termSelect) return;
		termCleanup?.();
		termCleanup = mountDockerTerminal(termHost, {
			containerId: termSelect.value,
			serverId: opts.serverId || undefined,
			activeWay:
				(termWay?.value as "bash" | "sh") ?? opts.defaultShell ?? "sh",
		});
		updateTabChrome();
	};

	const openTerminal = async () => {
		updateDockerTerminalChrome(opts.dialogId, {
			sectionLabel: opts.sectionLabel,
			nameLabel: opts.nameLabel,
			tabLabel: "terminal",
		});
		await loadContainers();
		openDialog(opts.dialogId);
		window.requestAnimationFrame(() => {
			window.requestAnimationFrame(() => {
				mountTerm();
			});
		});
	};

	termBtn.addEventListener("click", () => {
		void openTerminal();
	});

	termSelect?.addEventListener("change", () => {
		mountTerm();
		closeOptionsPanel();
	});
	termWay?.addEventListener("change", () => {
		mountTerm();
		closeOptionsPanel();
	});

	const closeTerminal = () => {
		termCleanup?.();
		termCleanup = null;
		disconnectDockerTerminal();
		closeDialog(opts.dialogId);
	};

	document.getElementById(opts.closeRequestId)?.addEventListener("click", () => {
		if (opts.confirmCloseDialogId) {
			openDialog(opts.confirmCloseDialogId);
			return;
		}
		closeTerminal();
	});

	if (opts.confirmCloseDialogId && opts.confirmCloseBtnId) {
		document
			.getElementById(opts.confirmCloseBtnId)
			?.addEventListener("click", () => {
				closeDialog(opts.confirmCloseDialogId!);
				closeTerminal();
			});
	}

	if (opts.confirmCloseDialogId && opts.confirmCloseCancelId) {
		document
			.getElementById(opts.confirmCloseCancelId)
			?.addEventListener("click", () => {
				closeDialog(opts.confirmCloseDialogId!);
			});
	}

	termDlg.addEventListener("close", () => {
		closeOptionsPanel();
		termCleanup?.();
		termCleanup = null;
		disconnectDockerTerminal();
	});
}
