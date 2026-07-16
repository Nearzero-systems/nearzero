import { setButtonLoadingVisuals } from "@/lib/auth-button-state";
import { trpcFormMutate, trpcMutate, trpcQuery } from "@/lib/client-api";
import { renderDeploymentLogOutput } from "@/lib/deployment-logs";
import {
	loadBitbucketBranches,
	loadBitbucketRepos,
	loadGithubBranches,
	loadGithubRepos,
	loadGitlabBranches,
	loadGitlabRepos,
} from "@/lib/git-application-source";
import { bindDockerTerminalUi } from "@/scripts/bind-docker-terminal-ui";
import {
	bindDeleteServiceModal,
	openDeleteServiceDialog,
} from "@/scripts/environment-dashboard";
import { closeDialog, openDialog, showToast } from "@/scripts/ui";

type AppBootstrap = {
	applicationId: string;
	environmentId: string;
	sourceType: string;
	hasGitProviderAccess: boolean;
	canUpdateService: boolean;
	canCreateDomain: boolean;
	canDeploy: boolean;
	appName: string;
	serviceName: string;
	serverId: string;
	applicationStatus: string;
	buildExecutionTarget: "deploy_server" | "nearzero_host";
	deploymentsTabHref: string;
	domainPort: number;
	defaultDomainHost: string;
};

function parseBootstrap(root: HTMLElement): AppBootstrap {
	const domainPort = Number.parseInt(root.dataset.domainPort ?? "3000", 10);
	return {
		applicationId: root.dataset.applicationId ?? "",
		environmentId: root.dataset.environmentId ?? "",
		sourceType: root.dataset.sourceType ?? "github",
		hasGitProviderAccess: root.dataset.hasGitProviderAccess === "1",
		canUpdateService: root.dataset.canUpdateService === "1",
		canCreateDomain: root.dataset.canCreateDomain === "1",
		canDeploy: root.dataset.canDeploy === "1",
		appName: root.dataset.applicationAppname ?? "",
		serviceName: root.dataset.serviceName ?? "",
		serverId: root.dataset.serverId ?? "",
		applicationStatus: root.dataset.applicationStatus ?? "idle",
		buildExecutionTarget:
			root.dataset.buildExecutionTarget === "nearzero_host"
				? "nearzero_host"
				: "deploy_server",
		deploymentsTabHref: root.dataset.deploymentsHref ?? "",
		domainPort:
			Number.isFinite(domainPort) && domainPort >= 1 && domainPort <= 65535
				? domainPort
				: 3000,
		defaultDomainHost: root.dataset.defaultDomainHost ?? "",
	};
}

type AppDeploymentRow = {
	deploymentId?: string | null;
	status?: string | null;
};

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

function getWatchPaths(containerId: string): string[] {
	try {
		return JSON.parse(
			(document.getElementById(containerId) as HTMLElement | null)?.dataset
				.paths ?? "[]",
		) as string[];
	} catch {
		return [];
	}
}

function setWatchPaths(containerId: string, paths: string[]) {
	const el = document.getElementById(containerId);
	if (el) {
		el.dataset.paths = JSON.stringify(paths);
		const list = el.querySelector("[data-watch-list]");
		if (list) {
			list.innerHTML = paths
				.map(
					(p, i) =>
						`<span class="inline-flex items-center gap-1 rounded-md border bg-secondary px-2 py-0.5 text-xs">${p}<button type="button" class="text-muted-foreground hover:text-destructive" data-watch-remove="${i}">×</button></span>`,
				)
				.join("");
		}
	}
}

function bindWatchPaths(containerId: string, inputId: string) {
	const container = document.getElementById(containerId);
	const input = document.getElementById(inputId) as HTMLInputElement | null;
	if (!container || !input) return;
	container.addEventListener("click", (e) => {
		const btn = (e.target as Element).closest("[data-watch-remove]");
		if (!(btn instanceof HTMLElement)) return;
		const idx = Number(btn.dataset.watchRemove);
		const paths = getWatchPaths(containerId);
		paths.splice(idx, 1);
		setWatchPaths(containerId, paths);
	});
	const add = () => {
		const path = input.value.trim();
		if (!path) return;
		const paths = getWatchPaths(containerId);
		paths.push(path);
		setWatchPaths(containerId, paths);
		input.value = "";
	};
	container.querySelector("[data-watch-add]")?.addEventListener("click", add);
	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			e.preventDefault();
			add();
		}
	});
}

function bindDeployActions(root: HTMLElement, bootstrap: AppBootstrap) {
	const dlg = document.getElementById("nz-app-act-dialog");
	if (!(dlg instanceof HTMLDialogElement)) return;
	if (root.dataset.nzAppActionsBound === "1") return;
	root.dataset.nzAppActionsBound = "1";

	const titleEl = document.getElementById("nz-app-act-dialog-title");
	const descEl = document.getElementById("nz-app-act-desc");
	const errEl = document.getElementById("nz-app-act-error");
	const runBtn = document.getElementById("nz-app-act-run");
	if (!titleEl || !descEl || !errEl || !(runBtn instanceof HTMLButtonElement)) return;

	let pending: string | null = null;
	let lastOpener: HTMLButtonElement | null = null;

	const presets: Record<string, [string, string]> = {
		deploy: ["Deploy Application", "Are you sure you want to deploy this application?"],
		reload: ["Reload Application", "Are you sure you want to reload this application?"],
		redeploy: ["Rebuild Application", "Are you sure you want to rebuild this application?"],
		start: ["Start Application", "Are you sure you want to start this application?"],
		stop: ["Stop Application", "Are you sure you want to stop this application?"],
	};

	const cancelBtn = document.getElementById("nz-app-act-cancel");

	const setActModalBusy = (busy: boolean) => {
		runBtn.disabled = busy;
		runBtn.setAttribute("aria-busy", busy ? "true" : "false");
		setButtonLoadingVisuals(runBtn, busy);
		if (cancelBtn instanceof HTMLButtonElement) cancelBtn.disabled = busy;
	};

	const close = () => {
		closeDialog("nz-app-act-dialog");
	};

	dlg.addEventListener("close", () => {
		lastOpener = null;
		pending = null;
		setActModalBusy(false);
	});

	root.addEventListener("click", (event) => {
		const tgt = event.target instanceof Element ? event.target : null;
		if (!tgt) return;
		const btn = tgt.closest<HTMLButtonElement>(
			"button.nz-app-act-btn[data-act]:not(:disabled)",
		);
		if (btn && btn.closest("[data-application-action-root='1']") === root && !dlg.contains(btn)) {
			event.preventDefault();
			const act = btn.dataset.act;
			if (!act || !presets[act]) return;
			lastOpener = btn;
			pending = act;
			titleEl.textContent = presets[act][0];
			descEl.textContent = presets[act][1];
			errEl.textContent = "";
			errEl.classList.add("hidden");
			setActModalBusy(false);
			openDialog("nz-app-act-dialog");
		}
	});

	runBtn.addEventListener("click", async () => {
		const act = pending;
		if (!act || !bootstrap.applicationId || runBtn.getAttribute("aria-busy") === "true") return;
		setActModalBusy(true);
		errEl.classList.add("hidden");
		if (lastOpener?.hasAttribute("data-busy-reload")) setBusy("nz-app-reload-btn", true);
		if (lastOpener?.hasAttribute("data-busy-startstop")) {
			setBusy("nz-app-start-btn", true);
			setBusy("nz-app-stop-btn", true);
		}
		try {
			if (act === "deploy") {
				await trpcMutate("application.deploy", { applicationId: bootstrap.applicationId });
				showToast("Application deployed successfully", "success");
				window.location.href = bootstrap.deploymentsTabHref || window.location.href;
				return;
			}
			if (act === "reload") {
				await trpcMutate("application.reload", {
					applicationId: bootstrap.applicationId,
					appName: bootstrap.appName,
				});
				showToast("Application reloaded successfully", "success");
				window.location.reload();
				return;
			}
			if (act === "redeploy") {
				await trpcMutate("application.redeploy", { applicationId: bootstrap.applicationId });
				showToast("Application rebuilt successfully", "success");
				window.location.reload();
				return;
			}
			if (act === "start") {
				await trpcMutate("application.start", { applicationId: bootstrap.applicationId });
				showToast("Application started successfully", "success");
				window.location.reload();
				return;
			}
			if (act === "stop") {
				await trpcMutate("application.stop", { applicationId: bootstrap.applicationId });
				showToast("Application stopped successfully", "success");
				window.location.reload();
				return;
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : "Request failed";
			const lines = message
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean);
			const headline = lines[0] ?? "Request failed";
			const description =
				lines.length > 1 ? lines.slice(1).join("\n") : undefined;
			// Show the failure through the generalized toast notification with
			// full detail, and close the confirmation dialog so it is visible.
			close();
			showToast(headline, "error", { description, persistent: true });
		} finally {
			setActModalBusy(false);
			setBusy("nz-app-reload-btn", false);
			setBusy("nz-app-start-btn", false);
			setBusy("nz-app-stop-btn", false);
		}
	});
}

function bindRunningStatusRefresh(bootstrap: AppBootstrap) {
	if (bootstrap.applicationStatus !== "running" || !bootstrap.applicationId) return;

	const poll = async () => {
		try {
			const rows = await trpcQuery<AppDeploymentRow[]>("deployment.all", {
				applicationId: bootstrap.applicationId,
			});
			const latestStatus = rows?.[0]?.status?.toLowerCase();
			if (latestStatus === "done" || latestStatus === "error") {
				window.location.reload();
			}
		} catch {
			// Keep the current UI if deployment status is temporarily unavailable.
		}
	};

	void poll();
	const interval = window.setInterval(poll, 3500);
	// Stop on both SPA navigation (Astro <ViewTransitions /> swaps the DOM but
	// leaves timers running) and full page unload. Without the before-swap
	// handler this interval keeps hitting deployment.all — and can fire
	// window.location.reload() on whatever page you navigated to.
	const stop = () => {
		window.clearInterval(interval);
		document.removeEventListener("astro:before-swap", stop);
		window.removeEventListener("beforeunload", stop);
	};
	document.addEventListener("astro:before-swap", stop);
	window.addEventListener("beforeunload", stop);
}

export function bindCollapsibles(root: HTMLElement) {
	for (const section of root.querySelectorAll<HTMLElement>(
		"[data-app-collapse]",
	)) {
		if (section.dataset.collapseBound === "1") continue;
		section.dataset.collapseBound = "1";
		const toggle = section.querySelector<HTMLButtonElement>(
			"[data-app-collapse-toggle]",
		);
		if (!toggle) continue;
		toggle.addEventListener("click", () => {
			const collapsed = section.dataset.collapsed !== "true";
			section.dataset.collapsed = collapsed ? "true" : "false";
			toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
		});
	}
}

export function bindSettingPanelHints(root: HTMLElement) {
	if (root.dataset.nzAppSettingHintsBound === "1") return;
	root.dataset.nzAppSettingHintsBound = "1";
	root.addEventListener("click", (event) => {
		const target = event.target instanceof Element ? event.target : null;
		if (!target?.closest("[data-nz-setting-hint]")) return;
		event.stopPropagation();
	});
}

export function bindServiceTabs(root: HTMLElement) {
	if (root.dataset.nzAppTabsBound === "1") return;
	root.dataset.nzAppTabsBound = "1";
	const scope =
		root.id === "nz-app-deploy-root" ?
			root
		:	(root.querySelector<HTMLElement>("#nz-app-deploy-root") ?? root);
	const tabs = Array.from(
		scope.querySelectorAll<HTMLButtonElement>("[data-app-tab]"),
	);
	const panels = Array.from(
		scope.querySelectorAll<HTMLElement>("[data-app-tab-panel]"),
	);
	if (tabs.length === 0) return;

	const show = (name: string) => {
		for (const t of tabs) {
			const active = t.dataset.appTab === name;
			t.classList.toggle("nz-domains-tab--active", active);
			t.setAttribute("aria-selected", active ? "true" : "false");
		}
		for (const p of panels) {
			p.classList.toggle("hidden", p.dataset.appTabPanel !== name);
		}
	};

	for (const t of tabs) {
		t.addEventListener("click", () => show(t.dataset.appTab ?? "overview"));
	}
	show("overview");
}

function bindDeleteService(root: HTMLElement, bootstrap: AppBootstrap) {
	const btn = root.querySelector<HTMLButtonElement>("#nz-app-delete-service");
	if (!btn || btn.dataset.bound === "1") return;
	btn.dataset.bound = "1";
	// Ensure the shared delete-service confirm dialog handlers are active.
	bindDeleteServiceModal();
	btn.addEventListener("click", () => {
		if (btn.disabled) return;
		const name = btn.dataset.serviceName?.trim() || "this service";
		// We're on the application's own detail page, so after deletion the
		// current URL would 404 ("Application not found"). Redirect to the
		// project/environment overview instead.
		//
		// NOTE: the live path is org-slug prefixed (e.g.
		// `/BvnYoAcw_3/dashboard/project/<id>/environment/<id>/services/...`).
		// The previous `^/dashboard/...` anchor never matched the prefixed path,
		// so redirectHref came back null and we reloaded the deleted page. Allow
		// an optional leading prefix and preserve it in the redirect target.
		const match = window.location.pathname.match(
			/^(.*?\/dashboard\/project\/[^/]+\/environment\/[^/]+)\//,
		);
		const redirectHref = match ? `${match[1]}/overview` : null;
		openDeleteServiceDialog(
			"application",
			bootstrap.applicationId,
			name,
			redirectHref,
		);
	});
}

function bindRollbackButton(root: HTMLElement) {
	const btn = root.querySelector<HTMLButtonElement>("#nz-app-rollback-btn");
	if (!btn || btn.dataset.bound === "1") return;
	btn.dataset.bound = "1";
	btn.addEventListener("click", async () => {
		const rollbackId = btn.dataset.rollbackId?.trim();
		if (!rollbackId || btn.disabled) return;
		btn.disabled = true;
		try {
			await trpcMutate("rollback.rollback", { rollbackId });
			showToast("Rollback started", "success");
			window.location.reload();
		} catch (err) {
			showToast(err instanceof Error ? err.message : "Rollback failed", "error");
			btn.disabled = false;
		}
	});
}

function bindDefaultDomainProvision(root: HTMLElement, bootstrap: AppBootstrap) {
	const buttons = root.querySelectorAll<HTMLButtonElement>(
		"#nz-app-default-domain-create, #nz-app-default-domain-create-settings, .nz-app-default-domain-create",
	);
	for (const btn of buttons) {
		if (btn.dataset.bound === "1") continue;
		btn.dataset.bound = "1";
		btn.addEventListener("click", async () => {
			if (!bootstrap.canCreateDomain || btn.disabled) return;
			btn.disabled = true;
			btn.setAttribute("aria-busy", "true");
			try {
				const domain = await trpcMutate<{ host?: string }>(
					"domain.provisionServiceDomain",
					{
						environmentId: bootstrap.environmentId,
						serviceName: bootstrap.serviceName,
						port: bootstrap.domainPort,
						serverId: bootstrap.serverId || null,
						applicationId: bootstrap.applicationId,
						domainType: "application",
					},
				);
				const host = domain?.host || bootstrap.defaultDomainHost;
				showToast("Default URL created", "success");
				if (host) {
					const next = new URL(window.location.href);
					next.searchParams.set("liveUrl", `https://${host}`);
					window.location.href = next.toString();
					return;
				}
				window.location.reload();
			} catch (err) {
				showToast(
					err instanceof Error ? err.message : "Could not create the default URL",
					"error",
				);
				btn.disabled = false;
				btn.setAttribute("aria-busy", "false");
			}
		});
	}
}

function bindDeploymentHistory(root: HTMLElement) {
	if (root.dataset.nzAppDeploymentHistoryBound === "1") return;
	root.dataset.nzAppDeploymentHistoryBound = "1";

	const dialog = document.getElementById("nz-app-deployment-log-dialog");
	const commitEl = document.getElementById("nz-app-deployment-log-commit");
	const output = document.getElementById("nz-app-deployment-log-output");
	const closeBtn = document.getElementById("nz-app-deployment-log-close");
	const copyBtn = document.getElementById("nz-app-deployment-log-copy");
	if (!(dialog instanceof HTMLDialogElement) || !(output instanceof HTMLElement)) return;

	let latestLogs = "";

	const openLogs = async (deploymentId: string, commitId: string) => {
		if (!deploymentId) return;
		if (commitEl) commitEl.textContent = commitId || "—";
		output.textContent = "Loading logs...";
		latestLogs = "";
		if (!dialog.open) dialog.showModal();
		try {
			const logs = await trpcQuery<string>("deployment.readLogs", {
				deploymentId,
				tail: 10000,
			});
			const raw = logs?.trim() ? logs : "";
			latestLogs = raw
				? renderDeploymentLogOutput(output, raw)
				: "No logs available for this deployment.";
			if (!raw) output.textContent = latestLogs;
		} catch (err) {
			const message = err instanceof Error ? err.message : "Failed to load logs";
			latestLogs = message;
			output.textContent = message;
			showToast(message, "error");
		}
	};

	root.addEventListener("click", async (event) => {
		const target = event.target instanceof Element ? event.target : null;
		if (!target) return;

		const rollbackBtn = target.closest<HTMLButtonElement>(
			"[data-app-deployment-rollback]",
		);
		if (rollbackBtn && root.contains(rollbackBtn)) {
			event.preventDefault();
			event.stopPropagation();
			const rollbackId = rollbackBtn.dataset.rollbackId?.trim();
			if (!rollbackId || rollbackBtn.disabled) return;
			rollbackBtn.disabled = true;
			try {
				await trpcMutate("rollback.rollback", { rollbackId });
				showToast("Rollback started", "success");
				window.location.reload();
			} catch (err) {
				showToast(err instanceof Error ? err.message : "Rollback failed", "error");
				rollbackBtn.disabled = false;
			}
			return;
		}

		const openBtn = target.closest<HTMLButtonElement>(
			"[data-app-deployment-open]",
		);
		if (openBtn && root.contains(openBtn)) {
			event.preventDefault();
			await openLogs(
				openBtn.dataset.deploymentId ?? "",
				openBtn.dataset.deploymentCommit ?? "",
			);
		}
	});

	closeBtn?.addEventListener("click", () => dialog.close());
	dialog.addEventListener("cancel", () => {
		latestLogs = "";
	});
	copyBtn?.addEventListener("click", async () => {
		if (!latestLogs) return;
		try {
			await navigator.clipboard.writeText(latestLogs);
			showToast("Logs copied", "success");
		} catch {
			showToast("Could not copy logs", "error");
		}
	});
}

function bindAuxControls(bootstrap: AppBootstrap) {
	if (!bootstrap.canUpdateService) return;
	const autoEl = document.getElementById("nz-app-autodeploy");
	const cacheEl = document.getElementById("nz-app-clean-cache");
	autoEl?.addEventListener("change", async () => {
		if (!(autoEl instanceof HTMLInputElement)) return;
		try {
			await trpcMutate("application.update", {
				applicationId: bootstrap.applicationId,
				autoDeploy: autoEl.checked,
			});
			showToast("Auto Deploy Updated", "success");
		} catch {
			autoEl.checked = !autoEl.checked;
			showToast("Error updating Auto Deploy", "error");
		}
	});
	cacheEl?.addEventListener("change", async () => {
		if (!(cacheEl instanceof HTMLInputElement)) return;
		try {
			await trpcMutate("application.update", {
				applicationId: bootstrap.applicationId,
				cleanCache: cacheEl.checked,
			});
			showToast("Clean Cache Updated", "success");
		} catch {
			cacheEl.checked = !cacheEl.checked;
			showToast("Error updating Clean Cache", "error");
		}
	});

	const serviceName =
		document.getElementById("nz-app-terminal-dialog-crumb-name")?.textContent?.trim() ||
		bootstrap.appName;
	bindDockerTerminalUi({
		openBtnId: "nz-app-terminal-open",
		dialogId: "nz-app-terminal-dialog",
		hostId: "nz-app-terminal-host",
		containerSelectId: "nz-app-terminal-container",
		shellSelectId: "nz-app-terminal-way",
		closeRequestId: "nz-app-terminal-close-request",
		appName: bootstrap.appName,
		serverId: bootstrap.serverId || undefined,
		sectionLabel: "application",
		nameLabel: serviceName,
		confirmCloseDialogId: "nz-app-terminal-close-dialog",
		confirmCloseBtnId: "nz-app-terminal-close-confirm",
		confirmCloseCancelId: "nz-app-terminal-close-cancel",
		defaultShell: "bash",
	});

	document.getElementById("nz-app-disconnect-git")?.addEventListener("click", async () => {
		try {
			await trpcMutate("application.disconnectGitProvider", {
				applicationId: bootstrap.applicationId,
			});
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

function bindProviderTabs(root: HTMLElement, bootstrap: AppBootstrap) {
	const tabs = root.querySelectorAll<HTMLButtonElement>("[data-app-provider-tab]");
	const panels = root.querySelectorAll<HTMLElement>("[data-app-provider-panel]");
	const showTab = (tab: string) => {
		tabs.forEach((t) => {
			const active = t.dataset.appProviderTab === tab;
			t.dataset.active = active ? "true" : "false";
		});
		panels.forEach((p) => {
			p.classList.toggle("hidden", p.dataset.appProviderPanel !== tab);
		});
	};
	tabs.forEach((t) => {
		t.addEventListener("click", () => showTab(t.dataset.appProviderTab ?? "github"));
	});
	showTab(bootstrap.sourceType === "drop" ? "drop" : bootstrap.sourceType || "github");
}

function bindProviderForms(bootstrap: AppBootstrap) {
	bindWatchPaths("nz-app-github-watch", "nz-app-github-watch-input");
	bindWatchPaths("nz-app-git-watch", "nz-app-git-watch-input");

	const ghAccount = document.getElementById("nz-app-github-account") as HTMLSelectElement | null;
	const ghRepo = document.getElementById("nz-app-github-repo") as HTMLSelectElement | null;
	const ghBranch = document.getElementById("nz-app-github-branch") as HTMLSelectElement | null;
	ghAccount?.addEventListener("change", async () => {
		if (!ghRepo || !ghBranch || !ghAccount.value) return;
		ghBranch.innerHTML = `<option value="">Select branch</option>`;
		await loadGithubRepos(ghAccount.value, ghRepo);
	});
	ghRepo?.addEventListener("change", async () => {
		if (!ghRepo?.value || !ghAccount?.value || !ghBranch) return;
		const { owner, repo } = JSON.parse(ghRepo.value) as { owner: string; repo: string };
		await loadGithubBranches(ghAccount.value, owner, repo, ghBranch);
	});

	const glAccount = document.getElementById("nz-app-gitlab-account") as HTMLSelectElement | null;
	const glRepo = document.getElementById("nz-app-gitlab-repo") as HTMLSelectElement | null;
	const glBranch = document.getElementById("nz-app-gitlab-branch") as HTMLSelectElement | null;
	glAccount?.addEventListener("change", async () => {
		if (!glRepo || !glAccount.value) return;
		await loadGitlabRepos(glAccount.value, glRepo);
	});
	glRepo?.addEventListener("change", async () => {
		if (!glRepo?.value || !glAccount?.value || !glBranch) return;
		const parsed = JSON.parse(glRepo.value) as {
			owner: string;
			repo: string;
			gitlabPathNamespace: string;
			id: number | null;
		};
		await loadGitlabBranches(
			glAccount.value,
			parsed.owner,
			parsed.repo,
			parsed.gitlabPathNamespace,
			parsed.id,
			glBranch,
		);
	});

	document.getElementById("nz-app-github-form")?.addEventListener("submit", async (e) => {
		e.preventDefault();
		if (!ghAccount?.value || !ghRepo?.value || !ghBranch?.value) {
			showToast("Please complete all required fields", "error");
			return;
		}
		const { owner, repo } = JSON.parse(ghRepo.value) as { owner: string; repo: string };
		setBusy("nz-app-github-save", true);
		try {
			await trpcMutate("application.saveGithubProvider", {
				applicationId: bootstrap.applicationId,
				githubId: ghAccount.value,
				owner,
				repository: repo,
				branch: ghBranch.value,
				buildPath: val("nz-app-github-build-path") || "/",
				triggerType: val("nz-app-github-trigger") || "push",
				watchPaths: getWatchPaths("nz-app-github-watch"),
				enableSubmodules: checked("nz-app-github-submodules"),
			});
			if (bootstrap.canDeploy) {
				await trpcMutate("application.deploy", {
					applicationId: bootstrap.applicationId,
					title: "GitHub deploy",
					description: `Deploy ${owner}/${repo}`,
				});
				showToast("GitHub source saved and deployment queued", "success");
				window.location.href = bootstrap.deploymentsTabHref || window.location.href;
				return;
			}
			showToast("GitHub source saved", "success");
			window.location.reload();
		} catch (err) {
			const message =
				err instanceof Error ? err.message : "Error saving the GitHub provider";
			showToast(message, "error");
		} finally {
			setBusy("nz-app-github-save", false);
		}
	});

	document.getElementById("nz-app-gitlab-form")?.addEventListener("submit", async (e) => {
		e.preventDefault();
		if (!glAccount?.value || !glRepo?.value || !glBranch?.value) {
			showToast("Please complete all required fields", "error");
			return;
		}
		const parsed = JSON.parse(glRepo.value) as {
			owner: string;
			repo: string;
			gitlabPathNamespace: string;
			id: number | null;
		};
		setBusy("nz-app-gitlab-save", true);
		try {
			await trpcMutate("application.saveGitlabProvider", {
				applicationId: bootstrap.applicationId,
				gitlabId: glAccount.value,
				gitlabOwner: parsed.owner,
				gitlabRepository: parsed.repo,
				gitlabPathNamespace: parsed.gitlabPathNamespace,
				gitlabProjectId: parsed.id,
				gitlabBranch: glBranch.value,
				gitlabBuildPath: val("nz-app-gitlab-build-path") || "/",
				watchPaths: getWatchPaths("nz-app-gitlab-watch"),
				enableSubmodules: checked("nz-app-gitlab-submodules"),
			});
			showToast("Service Provider Saved", "success");
			window.location.reload();
		} catch {
			showToast("Error saving the GitLab provider", "error");
		} finally {
			setBusy("nz-app-gitlab-save", false);
		}
	});

	document.getElementById("nz-app-docker-form")?.addEventListener("submit", async (e) => {
		e.preventDefault();
		setBusy("nz-app-docker-save", true);
		try {
			await trpcMutate("application.saveDockerProvider", {
				applicationId: bootstrap.applicationId,
				dockerImage: val("nz-app-docker-image"),
				username: val("nz-app-docker-username") || null,
				password: val("nz-app-docker-password") || null,
				registryUrl: val("nz-app-docker-registry") || null,
			});
			showToast("Docker Provider Saved", "success");
			window.location.reload();
		} catch {
			showToast("Error saving the Docker provider", "error");
		} finally {
			setBusy("nz-app-docker-save", false);
		}
	});

	document.getElementById("nz-app-git-form")?.addEventListener("submit", async (e) => {
		e.preventDefault();
		setBusy("nz-app-git-save", true);
		try {
			await trpcMutate("application.saveGitProvider", {
				applicationId: bootstrap.applicationId,
				customGitUrl: val("nz-app-git-url"),
				customGitBranch: val("nz-app-git-branch"),
				customGitBuildPath: val("nz-app-git-build-path") || "/",
				customGitSSHKeyId:
					val("nz-app-git-ssh") === "none" ? null : val("nz-app-git-ssh") || null,
				watchPaths: getWatchPaths("nz-app-git-watch"),
				enableSubmodules: checked("nz-app-git-submodules"),
			});
			showToast("Git Provider Saved", "success");
			window.location.reload();
		} catch {
			showToast("Error saving the Git provider", "error");
		} finally {
			setBusy("nz-app-git-save", false);
		}
	});

	const bbAccount = document.getElementById("nz-app-bitbucket-account") as HTMLSelectElement | null;
	const bbRepo = document.getElementById("nz-app-bitbucket-repo") as HTMLSelectElement | null;
	const bbBranch = document.getElementById("nz-app-bitbucket-branch") as HTMLSelectElement | null;
	bbAccount?.addEventListener("change", async () => {
		if (!bbRepo || !bbAccount.value) return;
		await loadBitbucketRepos(bbAccount.value, bbRepo);
	});
	bbRepo?.addEventListener("change", async () => {
		if (!bbRepo?.value || !bbAccount?.value || !bbBranch) return;
		const parsed = JSON.parse(bbRepo.value) as {
			owner: string;
			repo: string;
			slug: string;
		};
		await loadBitbucketBranches(bbAccount.value, parsed, bbBranch);
	});
	if (bbAccount?.value && bbRepo) void bbAccount.dispatchEvent(new Event("change"));

	document.getElementById("nz-app-bitbucket-form")?.addEventListener("submit", async (e) => {
		e.preventDefault();
		if (!bbAccount?.value || !bbRepo?.value || !bbBranch?.value) {
			showToast("Please complete all required fields", "error");
			return;
		}
		const parsed = JSON.parse(bbRepo.value) as { owner: string; repo: string; slug: string };
		setBusy("nz-app-bitbucket-save", true);
		try {
			await trpcMutate("application.saveBitbucketProvider", {
				applicationId: bootstrap.applicationId,
				bitbucketId: bbAccount.value,
				bitbucketOwner: parsed.owner,
				bitbucketRepository: parsed.repo,
				bitbucketRepositorySlug: parsed.slug || parsed.repo,
				bitbucketBranch: bbBranch.value,
				bitbucketBuildPath: val("nz-app-bitbucket-build-path") || "/",
				watchPaths: [],
				enableSubmodules: false,
			});
			showToast("Service Provider Saved", "success");
			window.location.reload();
		} catch {
			showToast("Error saving the Bitbucket provider", "error");
		} finally {
			setBusy("nz-app-bitbucket-save", false);
		}
	});

	const giteaAccount = document.getElementById("nz-app-gitea-account") as HTMLSelectElement | null;
	const giteaRepo = document.getElementById("nz-app-gitea-repo") as HTMLSelectElement | null;
	const giteaBranch = document.getElementById("nz-app-gitea-branch") as HTMLSelectElement | null;
	giteaAccount?.addEventListener("change", async () => {
		if (!giteaRepo || !giteaAccount.value) return;
		giteaRepo.innerHTML = `<option value="">Loading...</option>`;
		const repos = await trpcQuery<any[]>("gitea.getGiteaRepositories", {
			giteaId: giteaAccount.value,
		});
		giteaRepo.innerHTML = `<option value="">Select repository</option>`;
		for (const repo of repos ?? []) {
			const opt = document.createElement("option");
			opt.value = JSON.stringify({ owner: repo.owner?.login ?? repo.owner?.username ?? "", repo: repo.name });
			opt.textContent = repo.full_name ?? repo.name;
			giteaRepo.appendChild(opt);
		}
	});
	giteaRepo?.addEventListener("change", async () => {
		if (!giteaRepo?.value || !giteaAccount?.value || !giteaBranch) return;
		const parsed = JSON.parse(giteaRepo.value) as { owner: string; repo: string };
		giteaBranch.innerHTML = `<option value="">Loading...</option>`;
		const branches = await trpcQuery<any[]>("gitea.getGiteaBranches", {
			giteaId: giteaAccount.value,
			owner: parsed.owner,
			repositoryName: parsed.repo,
		});
		giteaBranch.innerHTML = `<option value="">Select branch</option>`;
		for (const b of branches ?? []) {
			const opt = document.createElement("option");
			opt.value = b.name;
			opt.textContent = b.name;
			giteaBranch.appendChild(opt);
		}
	});
	if (giteaAccount?.value && giteaRepo) void giteaAccount.dispatchEvent(new Event("change"));

	document.getElementById("nz-app-gitea-form")?.addEventListener("submit", async (e) => {
		e.preventDefault();
		if (!giteaAccount?.value || !giteaRepo?.value || !giteaBranch?.value) {
			showToast("Please complete all required fields", "error");
			return;
		}
		const parsed = JSON.parse(giteaRepo.value) as { owner: string; repo: string };
		setBusy("nz-app-gitea-save", true);
		try {
			await trpcMutate("application.saveGiteaProvider", {
				applicationId: bootstrap.applicationId,
				giteaId: giteaAccount.value,
				giteaOwner: parsed.owner,
				giteaRepository: parsed.repo,
				giteaBranch: giteaBranch.value,
				giteaBuildPath: val("nz-app-gitea-build-path") || "/",
				watchPaths: [],
				enableSubmodules: false,
			});
			showToast("Service Provider Saved", "success");
			window.location.reload();
		} catch {
			showToast("Error saving the Gitea provider", "error");
		} finally {
			setBusy("nz-app-gitea-save", false);
		}
	});

	document.getElementById("nz-app-drop-form")?.addEventListener("submit", async (e) => {
		e.preventDefault();
		const fileInput = document.getElementById("nz-app-drop-file") as HTMLInputElement | null;
		if (!fileInput?.files?.[0]) {
			showToast("Please select a zip file", "error");
			return;
		}
		setBusy("nz-app-drop-save", true);
		try {
			const fd = new FormData();
			fd.append("applicationId", bootstrap.applicationId);
			fd.append("zip", fileInput.files[0]);
			const bp = val("nz-app-drop-build-path");
			if (bp) fd.append("dropBuildPath", bp);
			await trpcFormMutate("application.dropDeployment", fd);
			showToast("Deployment saved", "success");
			window.location.reload();
		} catch {
			showToast("Error saving the deployment", "error");
		} finally {
			setBusy("nz-app-drop-save", false);
		}
	});
}

function bindBuildForm(bootstrap: AppBootstrap) {
	const section = document.getElementById("nz-app-build-section");
	if (!section || bootstrap.sourceType === "docker") return;

	const fields: Record<string, HTMLElement | null> = {
		dockerfile: document.getElementById("nz-app-build-dockerfile-fields"),
		heroku_buildpacks: document.getElementById("nz-app-build-heroku-fields"),
		nixpacks: document.getElementById("nz-app-build-nixpacks-fields"),
		static: document.getElementById("nz-app-build-static-fields"),
		railpack: document.getElementById("nz-app-build-railpack-fields"),
	};

	const syncFields = () => {
		const selected =
			(document.querySelector('input[name="buildType"]:checked') as HTMLInputElement | null)
				?.value ?? "nixpacks";
		for (const [k, el] of Object.entries(fields)) {
			el?.classList.toggle("hidden", k !== selected);
		}
	};
	document.querySelectorAll('input[name="buildType"]').forEach((el) => {
		el.addEventListener("change", syncFields);
	});
	syncFields();

	document.getElementById("nz-app-build-form")?.addEventListener("submit", async (e) => {
		e.preventDefault();
		const buildType =
			(document.querySelector('input[name="buildType"]:checked') as HTMLInputElement | null)
				?.value ?? "nixpacks";
		const buildExecutionTarget =
			(document.querySelector(
				'input[name="buildExecutionTarget"]:checked',
			) as HTMLInputElement | null)?.value ?? bootstrap.buildExecutionTarget;
		setBusy("nz-app-build-save", true);
		try {
			await trpcMutate("application.saveBuildType", {
				applicationId: bootstrap.applicationId,
				buildType,
				buildExecutionTarget,
				dockerfile: buildType === "dockerfile" ? val("nz-app-build-dockerfile") : null,
				dockerContextPath:
					buildType === "dockerfile" ? val("nz-app-build-docker-context") : null,
				dockerBuildStage:
					buildType === "dockerfile" ? val("nz-app-build-docker-stage") : null,
				herokuVersion: buildType === "heroku_buildpacks" ? val("nz-app-build-heroku") : null,
				publishDirectory: buildType === "nixpacks" ? val("nz-app-build-publish") : null,
				isStaticSpa: buildType === "static" ? checked("nz-app-build-static-spa") : null,
				railpackVersion:
					buildType === "railpack" ? val("nz-app-build-railpack") || "0.15.4" : null,
			});
			await trpcMutate("application.saveBuildCommands", {
				applicationId: bootstrap.applicationId,
				customInstallCommand: val("nz-app-custom-install-command").trim(),
				customBuildCommand: val("nz-app-custom-build-command").trim(),
				customStartCommand: val("nz-app-custom-start-command").trim(),
			});
			showToast("Build type saved", "success");
			window.location.reload();
		} catch {
			showToast("Error saving the build type", "error");
		} finally {
			setBusy("nz-app-build-save", false);
		}
	});
}

export function mountApplicationDashboard() {
	const root = document.querySelector<HTMLElement>("[data-application-action-root='1']");
	if (!root || root.dataset.appDashboardBound === "1") return;
	root.dataset.appDashboardBound = "1";
	const bootstrap = parseBootstrap(root);
	bindRunningStatusRefresh(bootstrap);
	bindDeployActions(root, bootstrap);
	bindAuxControls(bootstrap);
	bindRollbackButton(root);
	bindDeploymentHistory(root);
	bindDefaultDomainProvision(root, bootstrap);
	bindServiceTabs(root);
	bindSettingPanelHints(root);
	bindDeleteService(root, bootstrap);
	bindCollapsibles(root);
	if (bootstrap.hasGitProviderAccess) {
		bindProviderTabs(root, bootstrap);
		bindProviderForms(bootstrap);
	}
	bindBuildForm(bootstrap);

	for (const id of ["nz-app-github-watch", "nz-app-git-watch"]) {
		setWatchPaths(id, getWatchPaths(id));
	}
	const ghAccount = document.getElementById("nz-app-github-account") as HTMLSelectElement | null;
	const ghRepo = document.getElementById("nz-app-github-repo") as HTMLSelectElement | null;
	const ghBranch = document.getElementById("nz-app-github-branch") as HTMLSelectElement | null;
	if (ghAccount?.value && ghRepo && ghBranch) {
		void loadGithubRepos(ghAccount.value, ghRepo).then(() => {
			const init = ghRepo.dataset.initial;
			if (init) {
				ghRepo.value = init;
				const { owner, repo } = JSON.parse(init) as { owner: string; repo: string };
				void loadGithubBranches(ghAccount.value, owner, repo, ghBranch, ghBranch.dataset.initial);
			}
		});
	}
}

function bindLiveUrlBanner() {
	const params = new URLSearchParams(window.location.search);
	const liveUrl = params.get("liveUrl")?.trim();
	const banner = document.getElementById("nz-app-live-url-banner");
	const link = document.getElementById("nz-app-live-url-link");
	if (!liveUrl || !(banner instanceof HTMLElement) || !(link instanceof HTMLAnchorElement)) {
		return;
	}
	link.href = liveUrl;
	link.textContent = liveUrl;
	banner.classList.remove("hidden");
	const clean = new URL(window.location.href);
	clean.searchParams.delete("liveUrl");
	window.history.replaceState({}, "", clean);

	document.getElementById("nz-app-live-url-dismiss")?.addEventListener("click", () => {
		banner.classList.add("hidden");
	});
}

export function bootApplicationDashboard() {
	bindLiveUrlBanner();
	mountApplicationDashboard();
}
