import { renderDeploymentLogOutput } from "@/lib/deployment-logs";
import { trpcMutate, trpcQuery } from "@/lib/client-api";
import { NZ_TOAST_EVENT } from "@/lib/nzToast";
import { logLineClass, parseLogs } from "@/lib/parse-logs";
import { trpcSubscribe } from "@/lib/trpc-subscribe";
import { bindDockerTerminalUi } from "@/scripts/bind-docker-terminal-ui";
import { closeDialog, openDialog } from "@/scripts/ui";
import {
	DATABASE_VARIANT_CONFIG,
	type DatabaseServiceVariant,
} from "@/components/dashboard/services/databaseVariantConfig";

type DbActionRoot = HTMLElement & { _nzDbAbort?: AbortController };

function toast(
	input:
		| string
		| {
				message: string;
				description?: string;
				variant?: "success" | "error";
				persistent?: boolean;
		  },
	variant?: "success" | "error",
) {
	const detail =
		typeof input === "string" ? { message: input, variant } : input;
	document.dispatchEvent(
		new CustomEvent(NZ_TOAST_EVENT, {
			bubbles: true,
			detail,
		}),
	);
}

function setBusyReload(root: HTMLElement, v: boolean) {
	for (const el of root.querySelectorAll("[data-busy-reload='1']")) {
		if (el instanceof HTMLButtonElement) {
			el.disabled = v;
			el.setAttribute("aria-busy", v ? "true" : "false");
		}
	}
}

function setBusyStartStop(root: HTMLElement, v: boolean) {
	for (const el of root.querySelectorAll("[data-busy-startstop='1']")) {
		if (el instanceof HTMLButtonElement) {
			el.disabled = v;
			el.setAttribute("aria-busy", v ? "true" : "false");
		}
	}
}

/**
 * Centralizes gating of the database Deploy action so it is non-invocable
 * (hidden + disabled + aria-disabled) whenever the service is not idle/error.
 * Setting `disabled` is what actually blocks invocation: the action click
 * handler matches `button.nz-db-act-btn[data-act]:not(:disabled)`, and a CSS
 * rule can visually override the `hidden` attribute, so `hidden` alone is not
 * enough to prevent a duplicate deploy during the status-lag window.
 */
function setDeployInvocable(invocable: boolean, deployBtn?: HTMLElement | null) {
	const btn = deployBtn ?? document.getElementById("nz-db-btn-deploy");
	if (!(btn instanceof HTMLElement)) return;
	btn.hidden = !invocable;
	if (btn instanceof HTMLButtonElement) btn.disabled = !invocable;
	btn.setAttribute("aria-disabled", invocable ? "false" : "true");
}

function setStopTerminalInvocable(
	invocable: boolean,
	visible: boolean,
	stopBtn?: HTMLElement | null,
	terminalBtn?: HTMLElement | null,
) {
	for (const btn of [stopBtn, terminalBtn]) {
		if (!(btn instanceof HTMLElement)) continue;
		btn.hidden = !visible;
		if (btn instanceof HTMLButtonElement) btn.disabled = !invocable;
		btn.setAttribute("aria-disabled", invocable ? "false" : "true");
	}
}

function appendLogLine(container: HTMLElement, message: string) {
	const spinner = container.querySelector("#nz-db-logs-spinner");
	if (spinner) spinner.remove();

	const line = document.createElement("div");
	line.className = `whitespace-pre-wrap break-words py-0.5 ${logLineClass(message)}`;
	line.textContent = message;
	container.appendChild(line);
	container.scrollTop = container.scrollHeight;
}

function bindDatabaseActionsForRoot(root: DbActionRoot) {
	const dlg = root.querySelector("#nz-db-act-dialog");
	const titleEl = root.querySelector("#nz-db-act-dialog-title");
	const descEl = root.querySelector("#nz-db-act-desc");
	const errEl = root.querySelector("#nz-db-act-error");
	const runBtn = root.querySelector("#nz-db-act-run");

	if (!(dlg instanceof HTMLDialogElement)) return;

	const variantKey = root.dataset.dbVariant ?? "";
	const dbId = root.dataset.dbId?.trim() ?? "";
	const idField = root.dataset.dbIdField ?? "";
	const appName = root.dataset.dbAppname ?? "";
	const config =
		variantKey in DATABASE_VARIANT_CONFIG ?
			DATABASE_VARIANT_CONFIG[variantKey as DatabaseServiceVariant]
		:	null;

	if (
		!config ||
		!variantKey ||
		!dbId ||
		!idField ||
		!descEl ||
		!errEl ||
		!(runBtn instanceof HTMLButtonElement)
	) {
		return;
	}

	const bindKey = `${variantKey}:${dbId}`;
	if (root.dataset.nzDbActionsBound === bindKey) return;

	root._nzDbAbort?.abort();
	const ac = new AbortController();
	root._nzDbAbort = ac;
	const { signal } = ac;
	root.dataset.nzDbActionsBound = bindKey;

	let pending: string | null = null;
	let unsubscribeDeploy: (() => void) | null = null;
	let isDeploying = false;

	const presets: Record<string, [string, string]> = {
		deploy: [config.deployTitle, config.deployDescription],
		reload: [config.reloadTitle, config.reloadDescription],
		start: [config.startTitle, config.startDescription],
		stop: [config.stopTitle, config.stopDescription],
	};

	const successMessages: Record<string, string> = {
		deploy: config.deploySuccess,
		reload: config.reloadSuccess,
		start: config.startSuccess,
		stop: config.stopSuccess,
	};

	const errorMessages: Record<string, string> = {
		deploy: config.deployError,
		reload: config.reloadError,
		start: config.startError,
		stop: config.stopError,
	};

	const closeConfirm = () => {
		pending = null;
		closeDialog("nz-db-act-dialog");
	};

	const getLogsUi = () => {
		const panel = root.querySelector("#nz-db-deploy-panel");
		const logsBody = root.querySelector("#nz-db-logs-body");
		const statusEl = root.querySelector("#nz-db-deploy-status");
		if (!(panel instanceof HTMLElement) || !(logsBody instanceof HTMLElement)) {
			return null;
		}
		return { panel, logsBody, statusEl };
	};

	const showDeployPanel = () => {
		const logsUi = getLogsUi();
		if (!logsUi) return;
		logsUi.panel.classList.remove("hidden");
		if (logsUi.statusEl instanceof HTMLElement) {
			logsUi.statusEl.textContent = "Running";
			logsUi.statusEl.dataset.state = "running";
		}
		logsUi.panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
	};

	const closeLogs = () => {
		const logsUi = getLogsUi();
		if (!logsUi) return;
		const { panel, logsBody } = logsUi;
		unsubscribeDeploy?.();
		unsubscribeDeploy = null;
		isDeploying = false;
		logsBody.replaceChildren();
		panel.classList.add("hidden");
		window.location.reload();
	};

	const startDeploySubscription = () => {
		// Optimistically make Deploy non-invocable before the next status
		// refresh so a second deploy cannot be triggered during the lag window.
		setDeployInvocable(false);
		const logsUi = getLogsUi();
		if (!logsUi) {
			toast("Deployment logs panel is unavailable. Refresh the page.", "error");
			return;
		}
		const { logsBody } = logsUi;
		if (isDeploying) return;
		isDeploying = true;
		logsBody.replaceChildren();
		showDeployPanel();

		const input = { [idField]: dbId };
		unsubscribeDeploy = trpcSubscribe<string>(
			`${variantKey}.deployWithLogs`,
			input,
			{
				onData(log) {
					for (const parsed of parseLogs(log)) {
						appendLogLine(logsBody, parsed.message);
					}
					if (log === "Deployment completed successfully!") {
						isDeploying = false;
						unsubscribeDeploy?.();
						unsubscribeDeploy = null;
						const statusEl = root.querySelector("#nz-db-deploy-status");
						if (statusEl instanceof HTMLElement) {
							statusEl.textContent = "Done";
							statusEl.dataset.state = "done";
						}
						toast(config.deploySuccess, "success");
					}
				},
				onError(err) {
					console.error("Deployment logs error:", err);
					isDeploying = false;
					unsubscribeDeploy?.();
					unsubscribeDeploy = null;
					const statusEl = root.querySelector("#nz-db-deploy-status");
					if (statusEl instanceof HTMLElement) {
						statusEl.textContent = "Error";
						statusEl.dataset.state = "error";
					}
					toast(config.deployError, "error");
				},
			},
		);
	};

	root.addEventListener(
		"click",
		(event) => {
			const tgt = event.target instanceof Element ? event.target : null;
			if (!tgt) return;

			const actionBtn = tgt.closest<HTMLButtonElement>(
				"button.nz-db-act-btn[data-act]:not(:disabled)",
			);
			if (
				actionBtn &&
				actionBtn.closest("[data-db-action-root='1']") === root &&
				!dlg.contains(actionBtn)
			) {
				const act = actionBtn.dataset.act;
				if (!act) return;
				const preset = presets[act];
				if (!preset) return;
				// Click-time status guard: never start a deploy while the service
				// is running/deploying (defends against the `:not(:disabled)`
				// selector lag right after creation/auto-deploy). idle/error only.
				const liveStatus = (root.dataset.dbStatus ?? "idle").trim().toLowerCase();
				if (
					act === "deploy" &&
					!["idle", "error"].includes(liveStatus)
				) {
					event.preventDefault();
					return;
				}
				if (
					(act === "stop" || act === "start") &&
					liveStatus !== "done"
				) {
					event.preventDefault();
					return;
				}
				event.preventDefault();
				pending = act;
				if (titleEl instanceof HTMLElement) titleEl.textContent = preset[0];
				descEl.textContent = preset[1];
				errEl.textContent = "";
			errEl.classList.add("hidden");
			runBtn.disabled = false;
			openDialog("nz-db-act-dialog");
			return;
		}

			if (tgt.closest("#nz-db-act-cancel") && dlg.contains(tgt as Node)) {
				event.preventDefault();
				closeConfirm();
			}

			if (tgt.closest("[data-close-db-logs]")) {
				event.preventDefault();
				closeLogs();
			}
		},
		{ signal },
	);

	const panelToggle = root.querySelector("[data-nz-db-deploy-panel-toggle]");
	const panelBody = root.querySelector("[data-nz-db-deploy-panel-body]");
	if (panelToggle instanceof HTMLButtonElement && panelBody instanceof HTMLElement) {
		panelToggle.addEventListener(
			"click",
			() => {
				const collapsed = panelBody.classList.toggle("hidden");
				panelToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
				const chevron = root.querySelector("[data-nz-db-deploy-chevron]");
				chevron?.classList.toggle("-rotate-90", collapsed);
			},
			{ signal },
		);
	}

	runBtn.addEventListener(
		"click",
		async () => {
			const act = pending;
			if (!act || !dbId) return;

			const busyReload = act === "reload";
			const busySs = act === "start" || act === "stop";

			runBtn.disabled = true;
			errEl.classList.add("hidden");
			errEl.textContent = "";

			if (busyReload) setBusyReload(root, true);
			if (busySs) setBusyStartStop(root, true);

			try {
				const idPayload = { [idField]: dbId };

				if (act === "deploy") {
					closeConfirm();
					startDeploySubscription();
					return;
				}
				if (act === "reload") {
					await trpcMutate(`${variantKey}.reload`, {
						...idPayload,
						appName,
					});
					toast(successMessages.reload, "success");
					window.location.reload();
					return;
				}
				if (act === "start") {
					await trpcMutate(`${variantKey}.start`, idPayload);
					toast(successMessages.start, "success");
					window.location.reload();
					return;
				}
				if (act === "stop") {
					await trpcMutate(`${variantKey}.stop`, idPayload);
					toast(successMessages.stop, "success");
					window.location.reload();
					return;
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : "Request failed";
				const lines = msg
					.split("\n")
					.map((line) => line.trim())
					.filter(Boolean);
				const headline = lines[0] ?? errorMessages[act] ?? "Request failed";
				const description =
					lines.length > 1 ? lines.slice(1).join("\n") : undefined;
				// Surface the failure through the generalized toast notification
				// (with full detail) instead of an inline red box, and close the
				// confirmation dialog so the toast is clearly visible.
				closeConfirm();
				toast({
					message: headline,
					description,
					variant: "error",
					persistent: true,
				});
			} finally {
				runBtn.disabled = false;
				setBusyReload(root, false);
				setBusyStartStop(root, false);
			}
		},
		{ signal },
	);

	const termBtn = root.querySelector("#nz-db-terminal-open");
	if (termBtn instanceof HTMLButtonElement) {
		bindDockerTerminalUi({
			openBtnId: "nz-db-terminal-open",
			dialogId: "nz-db-terminal-dialog",
			hostId: "nz-db-terminal-host",
			containerSelectId: "nz-db-terminal-container",
			shellSelectId: "nz-db-terminal-way",
			closeRequestId: "nz-db-terminal-close-request",
			appName,
			serverId: root.dataset.dbServerId || undefined,
			sectionLabel: root.dataset.dbVariant || "database",
			nameLabel: root.dataset.dbServiceName || appName,
			defaultShell: "sh",
		});
	}
}

export function bindDatabaseActions() {
	for (const root of document.querySelectorAll<DbActionRoot>(
		"[data-db-action-root='1']",
	)) {
		bindDatabaseActionsForRoot(root);
	}
}

// Status → UI mappings kept in sync with src/lib/service-status-ui.ts.
const DB_STATUS_LABELS: Record<string, string> = {
	idle: "Not running",
	running: "Deploying",
	done: "Running",
	error: "Error",
};

function dbStatusDotState(status: string): "done" | "error" | "running" {
	if (status === "done") return "done";
	if (status === "error") return "error";
	return "running";
}

type DbStatusRoot = HTMLElement & { _nzDbStatusAbort?: AbortController };

// Track every live status poller so we can tear them all down on SPA
// navigation. The console uses Astro <ViewTransitions />, which swaps the DOM
// but leaves JS timers running — without this, a poller started on a database
// page keeps calling `${variant}.one` (e.g. mongo.one) forever after you
// navigate to an unrelated page like an application deploy.
const activeDbStatusPollers = new Set<AbortController>();
let dbStatusNavCleanupRegistered = false;

function stopAllDbStatusPollers() {
	for (const controller of activeDbStatusPollers) {
		controller.abort();
	}
	activeDbStatusPollers.clear();
	// Clear the bound flag so pollers rebind cleanly if a database page is
	// rendered again after the swap.
	for (const root of document.querySelectorAll<DbStatusRoot>(
		"[data-db-action-root='1']",
	)) {
		delete root.dataset.nzDbStatusBound;
	}
}

function ensureDbStatusNavCleanup() {
	if (dbStatusNavCleanupRegistered) return;
	dbStatusNavCleanupRegistered = true;
	// Fires before Astro swaps in the next page's DOM during ViewTransitions.
	document.addEventListener("astro:before-swap", stopAllDbStatusPollers);
	// Full page unload (hard navigation / reload).
	window.addEventListener("beforeunload", stopAllDbStatusPollers);
}

/**
 * Keep the database detail page's status and action buttons in sync with the
 * real runtime status. The page is server-rendered, so right after a service is
 * created (and auto-deployed) the static markup can show a "Deploy" button even
 * though a deployment is already running — clicking it triggers a duplicate
 * deploy. Polling the live status fixes that lag: Deploy shows only when the
 * service is genuinely idle/errored, Stop/Terminal only when it is up, and
 * Stop/Terminal visible while deploying but disabled until the service is running.
 */
function bindDatabaseStatusPollingForRoot(root: DbStatusRoot) {
	const variantKey = root.dataset.dbVariant ?? "";
	const dbId = root.dataset.dbId?.trim() ?? "";
	const idField = root.dataset.dbIdField ?? "";
	if (!variantKey || !dbId || !idField) return;
	if (root.dataset.nzDbStatusBound === "1") return;
	root.dataset.nzDbStatusBound = "1";

	root._nzDbStatusAbort?.abort();
	const ac = new AbortController();
	root._nzDbStatusAbort = ac;
	const { signal } = ac;

	// Register for global teardown on SPA navigation / unload, and de-register
	// once this poller is aborted so the set never leaks detached controllers.
	ensureDbStatusNavCleanup();
	activeDbStatusPollers.add(ac);
	signal.addEventListener("abort", () => {
		activeDbStatusPollers.delete(ac);
	});

	const dot = document.getElementById("nz-db-status-dot");
	const label = document.getElementById("nz-db-status-label");
	const deployBtn = document.getElementById("nz-db-btn-deploy");
	const stopBtn = document.getElementById("nz-db-btn-stop");
	const terminalBtn = document.getElementById("nz-db-terminal-open");

	const applyStatus = (statusRaw: string) => {
		const status = (statusRaw || "idle").trim().toLowerCase();
		root.dataset.dbStatus = status;
		if (dot instanceof HTMLElement) dot.dataset.state = dbStatusDotState(status);
		if (label instanceof HTMLElement) {
			label.textContent = DB_STATUS_LABELS[status] ?? status.replace(/_/g, " ");
		}
		// Deploy only when there is nothing running and nothing deploying.
		const showDeploy = status === "idle" || status === "error";
		// Stop/Terminal stay visible during deploy, but only work once running.
		const showStopTerminal = status === "done" || status === "running";
		const enableStopTerminal = status === "done";
		// Hidden + disabled + aria-disabled so the Deploy action cannot be
		// invoked (by click or programmatically) while running/deploying.
		setDeployInvocable(showDeploy, deployBtn);
		setStopTerminalInvocable(
			enableStopTerminal,
			showStopTerminal,
			stopBtn,
			terminalBtn,
		);
	};

	let timer: ReturnType<typeof setTimeout> | null = null;
	const clear = () => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	};
	signal.addEventListener("abort", clear);

	const poll = async () => {
		if (signal.aborted) return;
		try {
			const service = await trpcQuery<{ applicationStatus?: string }>(
				`${variantKey}.one`,
				{ [idField]: dbId },
			);
			if (signal.aborted) return;
			const status = (service?.applicationStatus || "idle").toLowerCase();
			applyStatus(status);
			// Poll faster while a deployment is in progress so the UI flips to its
			// final state promptly; slower once the service has settled.
			const nextDelay = status === "running" ? 2000 : 5000;
			clear();
			timer = setTimeout(() => void poll(), nextDelay);
		} catch {
			// Transient failure (e.g. navigating away) — retry on the slow cadence.
			if (signal.aborted) return;
			clear();
			timer = setTimeout(() => void poll(), 5000);
		}
	};

	// Apply the SSR status immediately, then start polling shortly after so we
	// pick up the background auto-deploy that runs right after creation.
	applyStatus(root.dataset.dbStatus ?? "idle");
	timer = setTimeout(() => void poll(), 1200);
}

export function bindDatabaseStatusPolling() {
	for (const root of document.querySelectorAll<DbStatusRoot>(
		"[data-db-action-root='1']",
	)) {
		bindDatabaseStatusPollingForRoot(root);
	}
}

export function bindDatabaseServiceTabs() {
	for (const root of document.querySelectorAll<HTMLElement>(
		"[data-db-service-root='1']",
	)) {
		if (root.dataset.nzDbTabsBound === "1") continue;
		root.dataset.nzDbTabsBound = "1";
		const tabs = Array.from(
			root.querySelectorAll<HTMLButtonElement>("[data-db-tab]"),
		);
		const panels = Array.from(
			root.querySelectorAll<HTMLElement>("[data-db-tab-panel]"),
		);
		if (tabs.length === 0) continue;

		const show = (name: string) => {
			for (const tab of tabs) {
				const active = tab.dataset.dbTab === name;
				tab.dataset.active = active ? "true" : "false";
				tab.setAttribute("aria-selected", active ? "true" : "false");
			}
			for (const panel of panels) {
				panel.classList.toggle("hidden", panel.dataset.dbTabPanel !== name);
			}
		};

		for (const tab of tabs) {
			tab.addEventListener("click", () => show(tab.dataset.dbTab ?? "overview"));
		}
		show("overview");
	}
}

export function bindDatabaseDeploymentHistory() {
	for (const root of document.querySelectorAll<HTMLElement>(
		"[data-db-service-root='1']",
	)) {
		if (root.dataset.nzDbHistoryBound === "1") continue;
		root.dataset.nzDbHistoryBound = "1";

		const dialog = root.querySelector("#nz-db-history-log-dialog");
		const commitEl = root.querySelector("#nz-db-history-log-commit");
		const output = root.querySelector("#nz-db-history-log-output");
		const closeBtn = root.querySelector("#nz-db-history-log-close");
		const copyBtn = root.querySelector("#nz-db-history-log-copy");
		if (!(dialog instanceof HTMLDialogElement) || !(output instanceof HTMLElement)) {
			continue;
		}

		let latestLogs = "";

		root.addEventListener("click", async (event) => {
			const target = event.target instanceof Element ? event.target : null;
			if (!target) return;
			const openBtn = target.closest<HTMLButtonElement>(
				"[data-db-deployment-open]",
			);
			if (!openBtn || !root.contains(openBtn)) return;

			event.preventDefault();
			const deploymentId = openBtn.dataset.deploymentId?.trim();
			if (!deploymentId) return;
			if (commitEl instanceof HTMLElement) {
				commitEl.textContent = openBtn.dataset.deploymentCommit?.trim() || "—";
			}
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
				toast(message, "error");
			}
		});

		closeBtn?.addEventListener("click", () => dialog.close());
		copyBtn?.addEventListener("click", async () => {
			if (!latestLogs) return;
			try {
				await navigator.clipboard.writeText(latestLogs);
				toast("Logs copied", "success");
			} catch {
				toast("Could not copy logs", "error");
			}
		});
	}
}
