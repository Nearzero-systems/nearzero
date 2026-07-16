import { trpcMutate, trpcQuery } from "@/lib/client-api";
import { navigateDashboardHref } from "@/scripts/dashboard-async-region";
import { showToast } from "@/scripts/ui";

export function bindDeploymentsFilters() {
	const form = document.getElementById("nz-deployments-filter-form");
	const search = document.getElementById("nz-deployments-search");
	if (!(form instanceof HTMLFormElement)) return;
	if (search instanceof HTMLInputElement && search.dataset.bound !== "1") {
		search.dataset.bound = "1";
		let timer = 0;
		search.addEventListener("input", () => {
			window.clearTimeout(timer);
			timer = window.setTimeout(() => form.requestSubmit(), 400);
		});
	}
}

export function bindDeploymentsQueueCancel() {
	const root = document.getElementById("nz-deployments-root");
	if (!root) return;

	for (const btn of root.querySelectorAll<HTMLButtonElement>(
		".nz-queue-cancel",
	)) {
		if (btn.dataset.bound === "1") continue;
		btn.dataset.bound = "1";
		btn.addEventListener("click", async (e) => {
			e.stopPropagation();
			const appId = btn.dataset.applicationId;
			const compId = btn.dataset.composeId;
			btn.disabled = true;
			try {
				if (appId)
					await trpcMutate("application.cancelDeployment", {
						applicationId: appId,
					});
				else if (compId)
					await trpcMutate("compose.cancelDeployment", { composeId: compId });
				else return;
				showToast("Cancellation requested", "success");
				window.location.reload();
			} catch (e) {
				showToast(e instanceof Error ? e.message : "Cancel failed", "error");
				btn.disabled = false;
			}
		});
	}
}

type DeploymentRowEl = HTMLElement & { _nzRowNavAbort?: AbortController };

type RedeployResult = {
	jobId?: string | number | null;
	applicationId?: string | null;
	composeId?: string | null;
};

type DeploymentQueueRow = {
	id: string | number;
	state?: string | null;
	timestamp?: string | number | null;
	processedOn?: string | number | null;
	finishedOn?: string | number | null;
	failedReason?: string | null;
	data?: {
		applicationId?: string | null;
		composeId?: string | null;
	};
};

type CentralizedDeploymentRow = {
	deploymentId?: string | null;
	status?: string | null;
	createdAt?: string | number | Date | null;
	applicationId?: string | null;
	composeId?: string | null;
	application?: { applicationId?: string | null } | null;
	compose?: { composeId?: string | null } | null;
};

function formatLiveDeploymentDuration(startMs: number, endMs = Date.now()) {
	const seconds = Math.max(0, Math.round((endMs - startMs) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const restSeconds = seconds % 60;
	if (minutes < 60) return `${minutes}m ${restSeconds}s`;
	const hours = Math.floor(minutes / 60);
	const restMinutes = minutes % 60;
	return `${hours}h ${restMinutes}m`;
}

function parseDeploymentTimeMs(value: string) {
	const numeric = Number(value);
	if (Number.isFinite(numeric)) return numeric;
	return new Date(value).getTime();
}

function isDeploymentQueueRow(
	row: DeploymentQueueRow | CentralizedDeploymentRow,
): row is DeploymentQueueRow {
	return "data" in row;
}

export function bindDeploymentRowNav() {
	const root = document.getElementById("nz-deployments-root");
	if (!root) return;

	for (const row of root.querySelectorAll<DeploymentRowEl>(
		".nz-deployments-row--clickable",
	)) {
		if (row.dataset.rowNavBound === "1") continue;
		row.dataset.rowNavBound = "1";
		row._nzRowNavAbort?.abort();
		const ac = new AbortController();
		row._nzRowNavAbort = ac;

		row.addEventListener(
			"click",
			(e) => {
				const target = e.target;
				if (!(target instanceof Element)) return;
				if (target.closest("[data-nz-row-action]")) return;
				const href = row.dataset.deploymentHref?.trim();
				if (!href) return;
				e.preventDefault();
				e.stopPropagation();
				e.stopImmediatePropagation();
				const handled = navigateDashboardHref(href, {
					routeId: "dashboard:deployments",
					label: "Loading deployment...",
					navKey: "deployments",
				});
				if (!handled) window.location.assign(href);
			},
			{ signal: ac.signal },
		);
	}
}

function rowMatchesRedeployTarget(
	row: DeploymentQueueRow | CentralizedDeploymentRow,
	target: { appId?: string; compId?: string },
) {
	if (isDeploymentQueueRow(row)) {
		if (target.appId) return row.data?.applicationId === target.appId;
		if (target.compId) return row.data?.composeId === target.compId;
		return false;
	}
	const appId = row.applicationId ?? row.application?.applicationId;
	const compId = row.composeId ?? row.compose?.composeId;
	if (target.appId) return appId === target.appId;
	if (target.compId) return compId === target.compId;
	return false;
}

function buildDeploymentDetailUrl(detailId: string) {
	const next = new URL(window.location.href);
	next.searchParams.set("deploymentId", detailId);
	return next.toString();
}

function sleep(ms: number) {
	return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

function sortNewestFirst<T extends { timestamp?: unknown; createdAt?: unknown }>(
	rows: T[],
) {
	return rows.sort((a, b) => {
		const aValue = "timestamp" in a ? a.timestamp : a.createdAt;
		const bValue = "timestamp" in b ? b.timestamp : b.createdAt;
		return new Date(bValue as any).getTime() - new Date(aValue as any).getTime();
	});
}

function getRowTimeMs(row: { timestamp?: unknown; createdAt?: unknown }) {
	const value = "timestamp" in row ? row.timestamp : row.createdAt;
	const time = new Date(value as any).getTime();
	return Number.isFinite(time) ? time : 0;
}

async function findQueuedRedeployDetailId(input: {
	appId?: string;
	compId?: string;
	jobId?: string | number | null;
}) {
	const target = { appId: input.appId, compId: input.compId };
	const jobId = input.jobId == null ? "" : String(input.jobId);
	try {
		const queueRows = await trpcQuery<DeploymentQueueRow[]>(
			"deployment.queueList",
		);
		const visibleQueueRows = queueRows.filter((row) => {
			const state = (row.state ?? "").toLowerCase();
			return (
				state !== "completed" &&
				state !== "failed" &&
				rowMatchesRedeployTarget(row, target)
			);
		});
		const explicitJob = visibleQueueRows.find((row) => String(row.id) === jobId);
		if (explicitJob) return String(explicitJob.id);
		const latestJob = sortNewestFirst(visibleQueueRows)[0];
		if (latestJob) return String(latestJob.id);
	} catch {
		// The deployment history poll below is the canonical follow-up.
	}
	return "";
}

async function findLatestRedeployDeploymentId(input: {
	appId?: string;
	compId?: string;
	currentDeploymentId?: string;
	startedAtMs?: number;
}) {
	const target = { appId: input.appId, compId: input.compId };
	if (!target.appId && !target.compId) return "";

	try {
		const deployments = await trpcQuery<CentralizedDeploymentRow[]>(
			"deployment.allCentralized",
		);
		const cutoff = input.startedAtMs ? input.startedAtMs - 10_000 : 0;
		const latestDeployment = sortNewestFirst(
			deployments.filter((row) => {
				if (!row.deploymentId || row.deploymentId === input.currentDeploymentId) {
					return false;
				}
				if (!rowMatchesRedeployTarget(row, target)) return false;
				const createdAt = getRowTimeMs(row);
				return !cutoff || !createdAt || createdAt >= cutoff;
			}),
		)[0];
		if (latestDeployment?.deploymentId) return latestDeployment.deploymentId;
	} catch {
		// The caller will retry or fall back to the queue row.
	}
	return "";
}

async function findNextRedeployDetailId(input: {
	appId?: string;
	compId?: string;
	jobId?: string | number | null;
	currentDeploymentId?: string;
	startedAtMs?: number;
	timeoutMs?: number;
}) {
	const deadline = Date.now() + (input.timeoutMs ?? 45_000);
	let queuedDetailId = "";

	while (Date.now() < deadline) {
		const deploymentId = await findLatestRedeployDeploymentId(input);
		if (deploymentId) return deploymentId;

		queuedDetailId =
			(await findQueuedRedeployDetailId(input)) || queuedDetailId;
		await sleep(1500);
	}

	return queuedDetailId;
}

function setRedeployButtonBusy(
	btn: HTMLButtonElement,
	busy: boolean,
	label = "Redeploy",
) {
	const labelEl = btn.querySelector<HTMLElement>("[data-redeploy-label]");
	const spinner = btn.querySelector<SVGElement>("[data-redeploy-spinner]");
	if (!btn.dataset.defaultLabel) {
		btn.dataset.defaultLabel = labelEl?.textContent?.trim() || "Redeploy";
	}
	btn.disabled = busy;
	btn.setAttribute("aria-busy", busy ? "true" : "false");
	spinner?.classList.toggle("hidden", !busy);
	if (labelEl) {
		labelEl.textContent = busy ? label : btn.dataset.defaultLabel || "Redeploy";
	}
}

export function bindDeploymentRedeploy() {
	const root = document.getElementById("nz-deployments-root");
	if (!root) return;

	for (const btn of root.querySelectorAll<HTMLButtonElement>(
		".nz-deployment-redeploy",
	)) {
		if (btn.dataset.bound === "1") continue;
		btn.dataset.bound = "1";
		btn.addEventListener("click", async (e) => {
			e.stopPropagation();
			const appId = btn.dataset.applicationId;
			const compId = btn.dataset.composeId;
			const currentDeploymentId = btn.dataset.currentDeploymentId;
			const startedAtMs = Date.now();
			setRedeployButtonBusy(btn, true, "Redeploying");
			try {
				let result: RedeployResult | undefined;
				if (appId) {
					result = await trpcMutate<RedeployResult>("application.redeploy", {
						applicationId: appId,
					});
				} else if (compId) {
					result = await trpcMutate<RedeployResult>("compose.redeploy", {
						composeId: compId,
					});
				} else {
					throw new Error("Deployment target is missing");
				}
				showToast("Redeployment queued", "success");
				setRedeployButtonBusy(btn, true, "Waiting for logs");
				const detailId = await findNextRedeployDetailId({
					appId: appId || result?.applicationId || undefined,
					compId: compId || result?.composeId || undefined,
					jobId: result?.jobId,
					currentDeploymentId,
					startedAtMs,
				});
				if (detailId) {
					window.location.assign(buildDeploymentDetailUrl(detailId));
					return;
				}
				window.location.reload();
			} catch (e) {
				showToast(e instanceof Error ? e.message : "Redeploy failed", "error");
				setRedeployButtonBusy(btn, false);
			}
		});
	}
}

export function bindDeploymentDetailRefresh() {
	const root = document.getElementById("nz-deployments-root");
	if (!root || root.dataset.detailRefreshBound === "1") return;
	if (root.dataset.selectedNeedsRefresh !== "1") return;
	root.dataset.detailRefreshBound = "1";

	const sourceKind = root.dataset.selectedSourceKind ?? "";
	const detailId = root.dataset.selectedDetailId ?? "";
	const deploymentId = root.dataset.selectedDeploymentId ?? "";
	const appId = root.dataset.selectedApplicationId || undefined;
	const compId = root.dataset.selectedComposeId || undefined;
	const status = (root.dataset.selectedStatus ?? "").toLowerCase();

	const poll = async () => {
		try {
			if (sourceKind === "queue") {
				const nextDeploymentId = await findLatestRedeployDeploymentId({
					appId,
					compId,
					currentDeploymentId: deploymentId,
				});
				if (nextDeploymentId) {
					window.location.assign(buildDeploymentDetailUrl(nextDeploymentId));
					return;
				}

				if (detailId) {
					const queuedDetailId = await findQueuedRedeployDetailId({
						appId,
						compId,
						jobId: detailId,
					});
					if (!queuedDetailId) {
						window.location.reload();
						return;
					}
				}
			} else if (deploymentId && status === "running") {
				const deployments = await trpcQuery<CentralizedDeploymentRow[]>(
					"deployment.allCentralized",
				);
				const current = deployments.find(
					(row) => row.deploymentId === deploymentId,
				);
				const nextStatus = (current?.status ?? "").toLowerCase();
				if (nextStatus && nextStatus !== "running") {
					window.location.reload();
					return;
				}
			}
		} catch {
			// Keep the current detail page usable; the next poll can recover.
		}
		window.setTimeout(poll, 3500);
	};

	window.setTimeout(poll, 2500);
}

export function bindDeploymentLiveDuration() {
	const root = document.getElementById("nz-deployments-root");
	if (!root || root.dataset.liveDurationBound === "1") return;
	root.dataset.liveDurationBound = "1";

	const durationEl = root.querySelector<HTMLElement>(
		"[data-deployment-duration='1']",
	);
	const startedAt = root.dataset.selectedStartedAt?.trim();
	const finishedAt = root.dataset.selectedFinishedAt?.trim();
	const status = (root.dataset.selectedStatus ?? "").toLowerCase();
	const isLiveStatus = ["running", "active", "pending", "waiting"].includes(
		status,
	);
	if (!durationEl || !startedAt || finishedAt || !isLiveStatus) return;

	const startedMs = parseDeploymentTimeMs(startedAt);
	if (Number.isNaN(startedMs)) return;

	const update = () => {
		if (!root.isConnected || !durationEl.isConnected) {
			window.clearInterval(timer);
			return;
		}
		durationEl.textContent = formatLiveDeploymentDuration(startedMs);
	};

	const timer = window.setInterval(update, 1000);
	update();
}

export function bindDeploymentRollback() {
	const root = document.getElementById("nz-deployments-root");
	if (!root) return;

	for (const btn of root.querySelectorAll<HTMLButtonElement>(
		".nz-deployment-rollback",
	)) {
		if (btn.dataset.bound === "1") continue;
		btn.dataset.bound = "1";
		btn.addEventListener("click", async (e) => {
			e.stopPropagation();
			const rollbackId = btn.dataset.rollbackId;
			if (!rollbackId) return;
			btn.disabled = true;
			try {
				await trpcMutate("rollback.rollback", { rollbackId });
				showToast("Rollback started", "success");
				window.location.reload();
			} catch (e) {
				showToast(e instanceof Error ? e.message : "Rollback failed", "error");
				btn.disabled = false;
			}
		});
	}
}

export function bindDeploymentLogs() {
	const root = document.getElementById("nz-deployments-root");
	if (!root) return;

	for (const panel of root.querySelectorAll<HTMLElement>(
		"[data-deployment-logs-panel]",
	)) {
		if (panel.dataset.bound === "1") continue;
		panel.dataset.bound = "1";
		const deploymentId = panel.dataset.deploymentId?.trim();
		const toggle = panel.querySelector<HTMLButtonElement>(
			"[data-deployment-logs-toggle]",
		);
		const body = panel.querySelector<HTMLElement>(
			"[data-deployment-logs-body]",
		);
		const output = panel.querySelector<HTMLElement>(
			"[data-deployment-logs-output]",
		);
		const state = panel.querySelector<HTMLElement>(
			"[data-deployment-logs-state]",
		);
		const chevron = panel.querySelector<SVGElement>(
			"[data-deployment-logs-chevron]",
		);
		const controls = panel.querySelector<HTMLElement>(
			"[data-deployment-logs-controls]",
		);
		const summary = panel.querySelector<HTMLElement>(
			"[data-deployment-logs-summary]",
		);
		const search = panel.querySelector<HTMLInputElement>(
			"[data-deployment-logs-search]",
		);
		const copy = panel.querySelector<HTMLButtonElement>(
			"[data-deployment-logs-copy]",
		);
		const scrollEl = panel.querySelector<HTMLElement>(
			"[data-deployment-logs-scroll]",
		);
		const logsWrap = panel.closest<HTMLElement>("[data-deployment-logs-wrap]");
		if (!deploymentId || !toggle || !body || !output || !state) continue;

		const scrollLogsToEnd = () => {
			if (!scrollEl) return;
			requestAnimationFrame(() => {
				scrollEl.scrollTop = scrollEl.scrollHeight;
			});
		};

		let loaded = false;
		let loading = false;
		let rawLogs = "";
		let refreshTimer = 0;
		// Lines currently rendered as DOM rows (only tracked when no search
		// filter is active). Used to append new log lines incrementally instead
		// of wiping and rebuilding the whole list on every poll.
		let renderedLines: string[] = [];
		const autoRefresh = panel.dataset.deploymentStatus === "running";

		const isNearBottom = () => {
			if (!scrollEl) return true;
			return (
				scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 40
			);
		};

		const setExpanded = (expanded: boolean) => {
			toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
			panel.dataset.logsExpanded = expanded ? "true" : "false";
			logsWrap?.classList.toggle("is-expanded", expanded);
			body.classList.toggle("hidden", !expanded);
			controls?.classList.toggle("hidden", !expanded);
			chevron?.classList.toggle("rotate-90", expanded);
		};

		const setState = (label: string) => {
			state.textContent = label;
		};

		const normalizeLogs = (value: string) => {
			const pathCleaned = value
				.replace(/\r/g, "\n")
				.replace(/\/Users\/[^\s'"`]+\/Desktop\/[^\s'"`]+/g, "<workspace>")
				.replace(/\/private\/var\/folders\/[^\s'"`]+/g, "<temp>");
			const result: string[] = [];
			let lastProgress = "";
			for (const line of pathCleaned.split("\n")) {
				const trimmed = line.trim();
				const progressMatch = trimmed.match(
					/^(remote:\s*)?(Counting objects|Compressing objects|Receiving objects|Resolving deltas):\s+\d+%/i,
				);
				if (progressMatch) {
					lastProgress = line;
					continue;
				}
				if (lastProgress) {
					result.push(lastProgress);
					lastProgress = "";
				}
				result.push(line);
			}
			if (lastProgress) result.push(lastProgress);
			return result.join("\n").trim();
		};

		const buildRow = (index: number, line: string) => {
			const row = document.createElement("div");
			row.className =
				"grid min-w-max grid-cols-[3rem_minmax(36rem,1fr)] gap-2 px-0.5 py-px";
			const isErrorLine = isFailureLine(line);
			if (isErrorLine) {
				row.className += " rounded-sm bg-red-50 text-red-700";
			}
			const number = document.createElement("span");
			number.className = `select-none text-right tabular-nums ${isErrorLine ? "text-red-500" : "text-[var(--nz-text-subtle)]"}`;
			number.textContent = String(index + 1).padStart(3, "0");
			const text = document.createElement("span");
			text.className = `min-w-0 whitespace-pre ${isErrorLine ? "text-red-700" : "text-[var(--nz-text-muted)]"}`;
			text.textContent = line || " ";
			row.append(number, text);
			return row;
		};

		const renderLogs = () => {
			const query = search?.value.trim().toLowerCase() || "";
			const normalized = normalizeLogs(rawLogs);
			const deploymentStatus = (
				panel.dataset.deploymentStatus || ""
			).toLowerCase();
			// Only declare failure once the deployment itself has failed. Recoverable
			// builder fallbacks (for example Railpack -> Nixpacks) write phase
			// diagnostics that must not look like a terminal error mid-build.
			const failure = isTerminalDeploymentFailure(deploymentStatus)
				? findFailureLine(normalized)
				: null;
			if (summary) {
				if (failure) {
					summary.textContent = `Failure detected on line ${failure.line}: ${failure.text}`;
					summary.classList.remove("hidden");
				} else {
					summary.textContent = "";
					summary.classList.add("hidden");
				}
			}
			if (!normalized) {
				output.textContent =
					"No build logs were written for this deployment yet.";
				renderedLines = [];
				scrollLogsToEnd();
				return;
			}

			const lines = normalized.split("\n");

			// When filtering, always do a full rebuild and mark the incremental
			// state as invalid so the next unfiltered render rebuilds cleanly.
			if (query) {
				const fragment = document.createDocumentFragment();
				let visible = 0;
				lines.forEach((line, index) => {
					if (!line.toLowerCase().includes(query)) return;
					visible++;
					fragment.append(buildRow(index, line));
				});
				output.textContent = "";
				renderedLines = [];
				if (visible === 0) {
					output.textContent = "No matching log lines.";
				} else {
					output.append(fragment);
				}
				scrollLogsToEnd();
				return;
			}

			// No filter: append only what changed so existing rows stay put and
			// the list doesn't disappear/reappear on each poll.
			const stickToBottom = isNearBottom();

			// Count how many leading lines are unchanged from what's rendered.
			let common = 0;
			const max = Math.min(lines.length, renderedLines.length);
			while (common < max && lines[common] === renderedLines[common]) {
				common++;
			}

			// Nothing changed at all: leave the DOM untouched (no flicker).
			if (
				common === renderedLines.length &&
				lines.length === renderedLines.length
			) {
				return;
			}

			if (renderedLines.length === 0) {
				// Clear any placeholder text (e.g. "Loading build logs...").
				output.textContent = "";
			} else if (common < renderedLines.length) {
				// A previously rendered line changed; drop diverged rows only.
				while (output.childNodes.length > common) {
					const last = output.lastChild;
					if (!last) break;
					output.removeChild(last);
				}
			}

			const fragment = document.createDocumentFragment();
			for (let index = common; index < lines.length; index++) {
				fragment.append(buildRow(index, lines[index]));
			}
			output.append(fragment);
			renderedLines = lines;

			if (stickToBottom) scrollLogsToEnd();
		};

		const load = async (force = false, expand = true) => {
			if (loading || (loaded && !force)) return;
			loading = true;
			if (expand) setExpanded(true);
			// Only show the loading placeholder on the first/interactive load.
			// Background polls keep the existing logs visible to avoid flicker.
			if (!loaded) {
				setState("Loading");
				output.textContent = "Loading build logs...";
				renderedLines = [];
			}
			try {
				const logs = await trpcQuery<string>("deployment.readLogs", {
					deploymentId,
					tail: 500,
				});
				rawLogs = String(logs ?? "");
				const trimmed = normalizeLogs(rawLogs);
				renderLogs();
				loaded = true;
				setState(trimmed ? "Loaded" : "Empty");
			} catch {
				output.textContent = "Could not load build logs.";
				setState("Failed");
			} finally {
				loading = false;
			}
		};

		const scheduleRefresh = () => {
			if (!autoRefresh) return;
			window.clearTimeout(refreshTimer);
			refreshTimer = window.setTimeout(async () => {
				await load(true, false);
				scheduleRefresh();
			}, 3500);
		};

		toggle.addEventListener("click", () => {
			const expanded = toggle.getAttribute("aria-expanded") === "true";
			if (expanded) {
				setExpanded(false);
				return;
			}
			if (loaded) {
				setExpanded(true);
				scrollLogsToEnd();
				return;
			}
			void load(true, true);
		});

		search?.addEventListener("click", (event) => event.stopPropagation());
		search?.addEventListener("input", () => {
			if (loaded) renderLogs();
		});

		copy?.addEventListener("click", (event) => {
			event.stopPropagation();
			const value = normalizeLogs(rawLogs);
			void navigator.clipboard.writeText(value).then(
				() => showToast("Logs copied", "success"),
				() => showToast("Could not copy logs", "error"),
			);
		});

		if (panel.dataset.deploymentLogsAutoload === "1") {
			setExpanded(true);
			void load(false, true).then(scheduleRefresh);
		}
	}
}

function isTerminalDeploymentFailure(status: string) {
	return status === "error" || status === "failed";
}

function isRecoverableOrchestrationLine(line: string) {
	return /\b(continuing with|handing control back|recoverable:|builder-selection phase)\b/i.test(
		line,
	);
}

function isFailureLine(line: string) {
	if (isRecoverableOrchestrationLine(line)) return false;
	return /\b(error|failed|failure|unsupported|exit code|eunsupportedprotocol)\b/i.test(
		line,
	);
}

function findFailureLine(logs: string): { line: number; text: string } | null {
	if (!logs.trim()) return null;
	const lines = logs.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const text = lines[i]?.trim() ?? "";
		if (!text || !isFailureLine(text)) continue;
		return { line: i + 1, text };
	}
	return null;
}

export function mountDeploymentsDashboard() {
	bindDeploymentsFilters();
	bindDeploymentRowNav();
	bindDeploymentsQueueCancel();
	bindDeploymentRedeploy();
	bindDeploymentRollback();
	bindDeploymentLogs();
	bindDeploymentLiveDuration();
	bindDeploymentDetailRefresh();
}
