import { trpcMutate, trpcQuery } from "@/lib/client-api";
import {
	disconnectDockerLogs,
	mountDockerLogs,
} from "@/scripts/docker-logs-ws";
import { bindDockerTerminalUi } from "@/scripts/bind-docker-terminal-ui";
import { closeDialog, openDialog, showToast } from "@/scripts/ui";

type ComposeBootstrap = {
	composeId: string;
	appName: string;
	serverId: string;
	composeType: string;
	sourceType: string;
	hasGitProviderAccess: boolean;
	canUpdateService: boolean;
	deploymentsTabHref: string;
};

function parseBootstrap(root: HTMLElement): ComposeBootstrap {
	return {
		composeId: root.dataset.composeId ?? "",
		appName: root.dataset.composeAppName ?? "",
		serverId: root.dataset.composeServerId ?? "",
		composeType: root.dataset.composeType ?? "docker-compose",
		sourceType: root.dataset.sourceType ?? "github",
		hasGitProviderAccess: root.dataset.hasGitProviderAccess === "1",
		canUpdateService: root.dataset.canUpdateService === "1",
		deploymentsTabHref: root.dataset.composeDeployHref ?? "",
	};
}

function val(id: string) {
	return (document.getElementById(id) as HTMLInputElement | null)?.value ?? "";
}

function checked(id: string) {
	return (document.getElementById(id) as HTMLInputElement | null)?.checked ?? false;
}

function setBusy(id: string, v: boolean) {
	const el = document.getElementById(id);
	if (el instanceof HTMLButtonElement) {
		el.disabled = v;
		el.setAttribute("aria-busy", v ? "true" : "false");
	}
}

async function loadGithubRepos(githubId: string, repoSel: HTMLSelectElement) {
	repoSel.innerHTML = `<option value="">Loading...</option>`;
	const repos = await trpcQuery<any[]>("github.getGithubRepositories", { githubId });
	repoSel.innerHTML = `<option value="">Select repository</option>`;
	for (const repo of repos ?? []) {
		const opt = document.createElement("option");
		opt.value = JSON.stringify({ owner: repo.owner.login, repo: repo.name });
		opt.textContent = `${repo.name} (${repo.owner.login})`;
		repoSel.appendChild(opt);
	}
}

async function loadGithubBranches(
	githubId: string,
	owner: string,
	repo: string,
	branchSel: HTMLSelectElement,
) {
	branchSel.innerHTML = `<option value="">Loading...</option>`;
	const branches = await trpcQuery<any[]>("github.getGithubBranches", {
		githubId,
		owner,
		repo,
	});
	branchSel.innerHTML = `<option value="">Select branch</option>`;
	for (const b of branches ?? []) {
		const opt = document.createElement("option");
		opt.value = b.name;
		opt.textContent = b.name;
		branchSel.appendChild(opt);
	}
}

function stateBadgeClass(state: string) {
	if (state === "running") return "bg-primary text-primary-foreground";
	if (state === "exited") return "bg-secondary text-secondary-foreground";
	return "bg-destructive text-destructive-foreground";
}

function bindDeployActions(root: HTMLElement, bootstrap: ComposeBootstrap) {
	const dlg = document.getElementById("nz-compose-act-dialog");
	if (!(dlg instanceof HTMLDialogElement) || root.dataset.nzComposeActionsBound === "1") return;
	root.dataset.nzComposeActionsBound = "1";

	const titleEl = document.getElementById("nz-compose-act-title");
	const descEl = document.getElementById("nz-compose-act-desc");
	const errEl = document.getElementById("nz-compose-act-error");
	const runBtn = document.getElementById("nz-compose-act-run");
	if (!titleEl || !descEl || !errEl || !(runBtn instanceof HTMLButtonElement)) return;

	let pending: string | null = null;
	let lastOpener: HTMLButtonElement | null = null;
	const presets: Record<string, [string, string]> = {
		deploy: ["Deploy Compose", "Are you sure you want to deploy this compose?"],
		redeploy: ["Reload Compose", "Are you sure you want to reload this compose?"],
		start: ["Start Compose", "Are you sure you want to start this compose?"],
		stop: ["Stop Compose", "Are you sure you want to stop this compose?"],
	};

	const close = () => {
		lastOpener = null;
		pending = null;
		dlg.close();
	};

	root.addEventListener("click", (event) => {
		const tgt = event.target instanceof Element ? event.target : null;
		if (!tgt) return;
		const btn = tgt.closest<HTMLButtonElement>("button.nz-compose-act-btn[data-act]:not(:disabled)");
		if (btn && btn.closest("[data-compose-action-root='1']") === root && !dlg.contains(btn)) {
			event.preventDefault();
			const act = btn.dataset.act;
			if (!act || !presets[act]) return;
			lastOpener = btn;
			pending = act;
			titleEl.textContent = presets[act][0];
			descEl.textContent = presets[act][1];
			errEl.textContent = "";
			errEl.classList.add("hidden");
			runBtn.disabled = false;
			dlg.showModal();
			return;
		}
		if (tgt.closest("[data-close-compose-act]") && dlg.contains(tgt)) {
			event.preventDefault();
			close();
		}
		if (tgt.closest("#nz-compose-act-cancel") && dlg.contains(tgt.closest("#nz-compose-act-cancel") as Node)) {
			event.preventDefault();
			close();
		}
	});

	runBtn.addEventListener("click", async () => {
		const act = pending;
		if (!act || !bootstrap.composeId) return;
		runBtn.disabled = true;
		errEl.classList.add("hidden");
		if (lastOpener?.hasAttribute("data-compose-busy")) setBusy("nz-compose-redeploy-btn", true);
		if (lastOpener?.hasAttribute("data-compose-ss")) {
			setBusy("nz-compose-start-btn", true);
			setBusy("nz-compose-stop-btn", true);
		}
		try {
			if (act === "deploy") {
				await trpcMutate("compose.deploy", { composeId: bootstrap.composeId });
				showToast("Compose deployed successfully", "success");
				window.location.href = bootstrap.deploymentsTabHref || window.location.href;
				return;
			}
			if (act === "redeploy") {
				await trpcMutate("compose.redeploy", { composeId: bootstrap.composeId });
				showToast("Compose reloaded successfully", "success");
				window.location.reload();
				return;
			}
			if (act === "start") {
				await trpcMutate("compose.start", { composeId: bootstrap.composeId });
				showToast("Compose started successfully", "success");
				window.location.reload();
				return;
			}
			if (act === "stop") {
				await trpcMutate("compose.stop", { composeId: bootstrap.composeId });
				showToast("Compose stopped successfully", "success");
				window.location.reload();
				return;
			}
		} catch (err) {
			errEl.textContent = err instanceof Error ? err.message : "Request failed";
			errEl.classList.remove("hidden");
			showToast("Request failed", "error");
		} finally {
			runBtn.disabled = false;
			setBusy("nz-compose-redeploy-btn", false);
			setBusy("nz-compose-start-btn", false);
			setBusy("nz-compose-stop-btn", false);
		}
	});
	dlg.addEventListener("cancel", (e) => {
		e.preventDefault();
		close();
	});
}

function bindAuxControls(bootstrap: ComposeBootstrap) {
	const autoEl = document.getElementById("nz-compose-autodeploy");
	autoEl?.addEventListener("change", async () => {
		if (!(autoEl instanceof HTMLInputElement) || !bootstrap.canUpdateService) return;
		try {
			await trpcMutate("compose.update", {
				composeId: bootstrap.composeId,
				autoDeploy: autoEl.checked,
			});
			showToast("Auto Deploy Updated", "success");
		} catch {
			autoEl.checked = !autoEl.checked;
			showToast("Error updating Auto Deploy", "error");
		}
	});

	const appType = bootstrap.composeType === "stack" ? "stack" : "docker-compose";
	const serviceName =
		document.getElementById("nz-compose-terminal-dialog-crumb-name")?.textContent?.trim() ||
		bootstrap.appName;
	bindDockerTerminalUi({
		openBtnId: "nz-compose-terminal-open",
		dialogId: "nz-compose-terminal-dialog",
		hostId: "nz-compose-terminal-host",
		containerSelectId: "nz-compose-terminal-container",
		shellSelectId: "nz-compose-terminal-way",
		closeRequestId: "nz-compose-terminal-close-request",
		appName: bootstrap.appName,
		serverId: bootstrap.serverId || undefined,
		appType,
		sectionLabel: "compose",
		nameLabel: serviceName,
		confirmCloseDialogId: "nz-compose-terminal-close-dialog",
		confirmCloseBtnId: "nz-compose-terminal-close-confirm",
		confirmCloseCancelId: "nz-compose-terminal-close-cancel",
		defaultShell: "bash",
	});

	document.getElementById("nz-compose-disconnect-git")?.addEventListener("click", async () => {
		try {
			await trpcMutate("compose.disconnectGitProvider", { composeId: bootstrap.composeId });
			showToast("Repository disconnected successfully", "success");
			window.location.reload();
		} catch (err) {
			showToast(
				`Failed to disconnect repository: ${err instanceof Error ? err.message : "Unknown error"}`,
				"error",
			);
		}
	});
}

async function loadLogContainers(bootstrap: ComposeBootstrap, runType: "native" | "swarm") {
	const select = document.getElementById("nz-compose-logs-container") as HTMLSelectElement | null;
	if (!select) return;
	select.innerHTML = `<option value="">Loading...</option>`;
	if (runType === "swarm") {
		const services = await trpcQuery<any[]>("docker.getStackContainersByAppName", {
			appName: bootstrap.appName,
			serverId: bootstrap.serverId || undefined,
		});
		select.innerHTML = `<option value="">Select a container</option>`;
		for (const c of services ?? []) {
			const opt = document.createElement("option");
			opt.value = c.containerId;
			opt.textContent = `${c.name} (${c.containerId}@${c.node}) — ${c.state}`;
			select.appendChild(opt);
		}
		if (services?.[0]) select.value = services[0].containerId;
		return;
	}
	const containers = await trpcQuery<any[]>("docker.getContainersByAppNameMatch", {
		appName: bootstrap.appName,
		appType: bootstrap.composeType === "stack" ? "stack" : "docker-compose",
		serverId: bootstrap.serverId || undefined,
	});
	select.innerHTML = `<option value="">Select a container</option>`;
	for (const c of containers ?? []) {
		const opt = document.createElement("option");
		opt.value = c.containerId;
		opt.textContent = `${c.name} (${c.containerId}) — ${c.state}`;
		select.appendChild(opt);
	}
	if (containers?.[0]) select.value = containers[0].containerId;
}

function bindLogsSection(bootstrap: ComposeBootstrap) {
	const logsBody = document.getElementById("nz-compose-logs-body");
	const runTypeEl = document.getElementById("nz-compose-logs-runtype");
	const select = document.getElementById("nz-compose-logs-container") as HTMLSelectElement | null;
	if (!(logsBody instanceof HTMLElement)) return;

	const mountLogs = () => {
		if (!select?.value) {
			logsBody.textContent = "Select a container to view logs.";
			disconnectDockerLogs();
			return;
		}
		const runType =
			bootstrap.composeType === "stack" && runTypeEl instanceof HTMLInputElement && !runTypeEl.checked
				? "swarm"
				: "native";
		mountDockerLogs(logsBody, {
			containerId: select.value,
			serverId: bootstrap.serverId || undefined,
			runType,
		});
	};

	const refresh = async () => {
		const runType =
			bootstrap.composeType === "stack" && runTypeEl instanceof HTMLInputElement && !runTypeEl.checked
				? "swarm"
				: "native";
		await loadLogContainers(bootstrap, runType);
		mountLogs();
	};

	runTypeEl?.addEventListener("change", () => void refresh());
	select?.addEventListener("change", mountLogs);
	void refresh();
}

async function renderContainersTable(bootstrap: ComposeBootstrap) {
	const tbody = document.getElementById("nz-compose-containers-tbody");
	if (!(tbody instanceof HTMLElement)) return;
	tbody.innerHTML = `<tr><td colspan="5" class="p-4 text-center text-sm text-muted-foreground">Loading...</td></tr>`;
	const appType = bootstrap.composeType === "stack" ? "stack" : "docker-compose";
	const data = await trpcQuery<any[]>("docker.getContainersByAppNameMatch", {
		appName: bootstrap.appName,
		appType,
		serverId: bootstrap.serverId || undefined,
	});
	if (!data?.length) {
		tbody.innerHTML = `<tr><td colspan="5" class="p-4 text-center text-sm text-muted-foreground">No containers found. Deploy the compose to see containers here.</td></tr>`;
		return;
	}
	tbody.innerHTML = data
		.map(
			(c) => `
			<tr data-container-id="${c.containerId}">
				<td class="p-4 font-medium">${c.name}</td>
				<td class="p-4"><span class="inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${stateBadgeClass(c.state)}">${c.state}</span></td>
				<td class="p-4">${c.status ?? ""}</td>
				<td class="p-4 font-mono text-sm text-muted-foreground">${c.containerId}</td>
				<td class="p-4 text-right">
					<div class="relative inline-block">
						<button type="button" class="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-accent" data-compose-container-menu aria-label="Actions">⋯</button>
						<div class="hidden absolute right-0 z-10 mt-1 min-w-[10rem] rounded-md border bg-popover p-1 shadow-md" data-compose-container-dropdown>
							<button type="button" class="block w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent" data-container-action="logs">View Logs</button>
							<button type="button" class="block w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent" data-container-action="restart">Restart</button>
							<button type="button" class="block w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent" data-container-action="start">Start</button>
							<button type="button" class="block w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent" data-container-action="stop">Stop</button>
							<button type="button" class="block w-full rounded-sm px-2 py-1.5 text-left text-sm text-red-500 hover:bg-accent" data-container-action="kill">Kill</button>
						</div>
					</div>
				</td>
			</tr>`,
		)
		.join("");
}

function bindContainersSection(bootstrap: ComposeBootstrap) {
	const root = document.getElementById("nz-compose-containers-root");
	root?.addEventListener("click", async (e) => {
		const tgt = e.target instanceof Element ? e.target : null;
		if (!tgt) return;
		const menuBtn = tgt.closest("[data-compose-container-menu]");
		if (menuBtn) {
			e.stopPropagation();
			const dropdown = menuBtn.parentElement?.querySelector("[data-compose-container-dropdown]");
			document.querySelectorAll("[data-compose-container-dropdown]").forEach((d) => {
				if (d !== dropdown) d.classList.add("hidden");
			});
			dropdown?.classList.toggle("hidden");
			return;
		}
		const actionBtn = tgt.closest("[data-container-action]");
		const row = tgt.closest("tr[data-container-id]");
		if (!(actionBtn instanceof HTMLElement) || !(row instanceof HTMLElement)) return;
		const containerId = row.dataset.containerId ?? "";
		const action = actionBtn.dataset.containerAction;
		row.querySelector("[data-compose-container-dropdown]")?.classList.add("hidden");

		if (action === "logs") {
			const select = document.getElementById("nz-compose-logs-container") as HTMLSelectElement | null;
			if (select) {
				select.value = containerId;
				select.dispatchEvent(new Event("change"));
			}
			document.getElementById("nz-compose-logs-section")?.scrollIntoView({ behavior: "smooth" });
			return;
		}
		const mutationMap: Record<string, string> = {
			restart: "docker.restartContainer",
			start: "docker.startContainer",
			stop: "docker.stopContainer",
			kill: "docker.killContainer",
		};
		const proc = mutationMap[action ?? ""];
		if (!proc) return;
		try {
			await trpcMutate(proc, {
				containerId,
				serverId: bootstrap.serverId || undefined,
			});
			showToast(`Container ${action} successfully`, "success");
			await renderContainersTable(bootstrap);
		} catch (err) {
			showToast(
				`Failed to ${action} container: ${err instanceof Error ? err.message : "Unknown error"}`,
				"error",
			);
		}
	});
	document.addEventListener("click", () => {
		document.querySelectorAll("[data-compose-container-dropdown]").forEach((d) => d.classList.add("hidden"));
	});
	document.getElementById("nz-compose-containers-refresh")?.addEventListener("click", () => {
		void renderContainersTable(bootstrap);
	});
	void renderContainersTable(bootstrap);
}

function bindProviderTabs(root: HTMLElement, bootstrap: ComposeBootstrap) {
	const tabs = root.querySelectorAll<HTMLButtonElement>("[data-compose-provider-tab]");
	const panels = root.querySelectorAll<HTMLElement>("[data-compose-provider-panel]");
	const showTab = (tab: string) => {
		tabs.forEach((t) => {
			const active = t.dataset.composeProviderTab === tab;
			t.classList.toggle("border-b-border", active);
			t.classList.toggle("text-foreground", active);
			t.classList.toggle("text-muted-foreground", !active);
		});
		panels.forEach((p) => {
			p.classList.toggle("hidden", p.dataset.composeProviderPanel !== tab);
		});
	};
	tabs.forEach((t) => t.addEventListener("click", () => showTab(t.dataset.composeProviderTab ?? "github")));
	showTab(bootstrap.sourceType === "raw" ? "raw" : bootstrap.sourceType || "github");
}

function bindProviderForms(bootstrap: ComposeBootstrap) {
	document.getElementById("nz-compose-raw-form")?.addEventListener("submit", async (e) => {
		e.preventDefault();
		setBusy("nz-compose-raw-save", true);
		try {
			await trpcMutate("compose.update", {
				composeId: bootstrap.composeId,
				composeFile: val("nz-compose-raw-file"),
				composePath: "./docker-compose.yml",
				sourceType: "raw",
				composeStatus: "idle",
			});
			showToast("Compose file saved", "success");
			window.location.reload();
		} catch {
			showToast("Error saving compose file", "error");
		} finally {
			setBusy("nz-compose-raw-save", false);
		}
	});

	const ghAccount = document.getElementById("nz-compose-github-account") as HTMLSelectElement | null;
	const ghRepo = document.getElementById("nz-compose-github-repo") as HTMLSelectElement | null;
	const ghBranch = document.getElementById("nz-compose-github-branch") as HTMLSelectElement | null;
	ghAccount?.addEventListener("change", async () => {
		if (!ghRepo || !ghAccount.value) return;
		await loadGithubRepos(ghAccount.value, ghRepo);
	});
	ghRepo?.addEventListener("change", async () => {
		if (!ghRepo?.value || !ghAccount?.value || !ghBranch) return;
		const { owner, repo } = JSON.parse(ghRepo.value) as { owner: string; repo: string };
		await loadGithubBranches(ghAccount.value, owner, repo, ghBranch);
	});
	if (ghAccount?.value && ghRepo) {
		void loadGithubRepos(ghAccount.value, ghRepo);
	}

	document.getElementById("nz-compose-github-form")?.addEventListener("submit", async (e) => {
		e.preventDefault();
		if (!ghAccount?.value || !ghRepo?.value || !ghBranch?.value) {
			showToast("Please complete all required fields", "error");
			return;
		}
		const { owner, repo } = JSON.parse(ghRepo.value) as { owner: string; repo: string };
		setBusy("nz-compose-github-save", true);
		try {
			await trpcMutate("compose.update", {
				composeId: bootstrap.composeId,
				githubId: ghAccount.value,
				owner,
				repository: repo,
				branch: ghBranch.value,
				composePath: val("nz-compose-github-compose-path") || "./docker-compose.yml",
				sourceType: "github",
				composeStatus: "idle",
				enableSubmodules: checked("nz-compose-github-submodules"),
				triggerType: val("nz-compose-github-trigger") || "push",
			});
			showToast("Service Provider Saved", "success");
			window.location.reload();
		} catch {
			showToast("Error saving the Github provider", "error");
		} finally {
			setBusy("nz-compose-github-save", false);
		}
	});

	document.querySelector("[data-close-compose-preview]")?.addEventListener("click", () => {
		closeDialog("nz-compose-preview-dialog");
	});

	document.getElementById("nz-compose-preview-open")?.addEventListener("click", async () => {
		const body = document.getElementById("nz-compose-preview-body");
		if (!(body instanceof HTMLElement)) return;
		openDialog("nz-compose-preview-dialog");
		body.textContent = "Loading...";
		try {
			await trpcMutate("compose.fetchSourceType", { composeId: bootstrap.composeId });
			const data = await trpcQuery<string>("compose.getConvertedCompose", { composeId: bootstrap.composeId });
			body.textContent = typeof data === "string" ? data : JSON.stringify(data, null, 2);
		} catch (err) {
			body.textContent = err instanceof Error ? err.message : "Failed to load preview";
		}
	});
}

export function mountComposeDashboard() {
	const root = document.querySelector<HTMLElement>("[data-compose-action-root='1']");
	if (!root || root.dataset.composeDashboardBound === "1") return;
	root.dataset.composeDashboardBound = "1";
	const bootstrap = parseBootstrap(root);
	bindDeployActions(root, bootstrap);
	bindAuxControls(bootstrap);
	bindLogsSection(bootstrap);
	bindContainersSection(bootstrap);
	if (bootstrap.hasGitProviderAccess) {
		bindProviderTabs(root, bootstrap);
		bindProviderForms(bootstrap);
	}
}

export function bootComposeDashboard() {
	mountComposeDashboard();
}
