import { setButtonLoadingVisuals } from "@/lib/auth-button-state";
import { trpcMutate, trpcQuery } from "@/lib/client-api";
import { isPlatformWebSocketSplit } from "@/lib/platform-websocket";
import { trpcSubscribe } from "@/lib/trpc-subscribe";
import {
	bindDropdown,
	bindElementEventOnce,
	closeDialog,
	openDialog,
	showToast,
} from "@/scripts/ui";
import {
	bindCopyServerIp,
	bindDockerCleanupToggle,
	bindLogsDialog,
	bindSharedDialogCloseButtons,
	bindTerminalDialog,
	bindTraefikDashboardConfirm,
	bindTraefikEnvDialog,
	bindTraefikPortsDialog,
	bindUpdateServerIpDialog,
	bindWebServerActionDropdowns,
	openTerminalDialog,
} from "@/scripts/web-server-shared";

type ServerRow = {
	serverId: string;
	name: string;
	description?: string | null;
	ipAddress: string;
	port: number;
	username: string;
	sshKeyId?: string | null;
	serverStatus?: string;
	setupStatus?: "not_started" | "running" | "ready" | "failed" | string;
	setupError?: string | null;
	setupStartedAt?: string | null;
	setupFinishedAt?: string | null;
	totalSum?: number;
	createdAt: string;
	metricsConfig?: { server?: { port?: number; token?: string } };
};

let canCreateMore = true;
let pendingDeleteId = "";
let pendingDeleteAttachedServices = false;
let editingServerId = "";
let setupServerId = "";
let advancedServerId = "";
let unsubscribeSetupLogs: (() => void) | null = null;
// Tracks whether the currently open setup dialog belongs to a server that was
// just created. If its initial setup fails we roll the server back so failed
// servers don't linger on the dashboard.
let setupIsNewServer = false;
let setupServerRemoved = false;
let setupFailed = false;
let serverFormBusy = false;

type ServerDeploymentRow = {
	deploymentId: string;
	title?: string | null;
	description?: string | null;
	status?: string | null;
	createdAt?: string | null;
	logPath?: string | null;
};

function getRoot() {
	return document.getElementById("nz-servers-root");
}

function escapeHtml(value: unknown): string {
	return String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function errorMessage(error: unknown, fallback: string) {
	if (error instanceof Error && error.message) return error.message;
	if (typeof error === "string" && error.trim()) return error;
	return fallback;
}

function setServerDeleteConfirmState(hasAttachedServices: boolean) {
	const confirm = document.getElementById("nz-server-delete-confirm");
	const checkbox = document.getElementById("nz-server-delete-attached-services");
	if (!(confirm instanceof HTMLButtonElement)) return;

	confirm.textContent = hasAttachedServices
		? "Delete services and server"
		: "Delete";
	confirm.disabled =
		hasAttachedServices &&
		!(checkbox instanceof HTMLInputElement && checkbox.checked);
}

function validationStatus(value: unknown) {
	if (typeof value === "boolean") return value ? "ready" : "not ready";
	if (typeof value === "string") return value || "not ready";
	if (typeof value === "number") return String(value);
	if (value && typeof value === "object") {
		const item = value as {
			enabled?: boolean;
			message?: string;
			status?: string;
			version?: string;
		};
		if (item.status) return item.status;
		if (item.message) return item.message;
		if (typeof item.enabled === "boolean") {
			return item.enabled
				? item.version && item.version !== "0.0.0"
					? item.version
					: "ready"
				: "not ready";
		}
		if (item.version) return item.version;
	}
	return "not ready";
}

function setupStatusLabel(value: string | null | undefined) {
	return (value || "not_started").replace(/_/g, " ");
}

function setupStatusClass(value: string | null | undefined) {
	switch (value) {
		case "ready":
			return "bg-emerald-600/20 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300";
		case "running":
			return "bg-blue-600/15 text-blue-700 dark:text-blue-300";
		case "failed":
			return "bg-red-600/15 text-destructive";
		default:
			return "bg-secondary text-secondary-foreground";
	}
}

function appendLog(output: HTMLElement | null, chunk: string) {
	if (!output) return;
	output.textContent += chunk;
	output.scrollTop = output.scrollHeight;
}

async function loadLatestServerSetupLog(
	serverId: string,
	output: HTMLElement | null,
	state: HTMLElement | null,
) {
	if (!output) return;
	try {
		const deployments = await trpcQuery<ServerDeploymentRow[]>(
			"deployment.allByServer",
			{ serverId },
		);
		const latest = deployments
			.filter(
				(row) => row.logPath || row.title?.toLowerCase().includes("setup"),
			)
			.sort(
				(a, b) =>
					new Date(b.createdAt || 0).getTime() -
					new Date(a.createdAt || 0).getTime(),
			)[0];
		if (!latest?.deploymentId) return;
		state && (state.textContent = "Loading latest log");
		const logs = await trpcQuery<string>("deployment.readLogs", {
			deploymentId: latest.deploymentId,
			tail: 500,
		});
		const trimmed = String(logs ?? "").trim();
		if (trimmed) {
			output.textContent = `${trimmed}\n`;
			output.scrollTop = output.scrollHeight;
			state && (state.textContent = "Latest log loaded");
		} else {
			state && (state.textContent = "No setup logs yet");
		}
	} catch {
		state && (state.textContent = "Could not load latest log");
	}
}

function serverFormTitleEl() {
	return document.getElementById("nz-server-form-dialog-title");
}

function serverFormSubmitButton() {
	return document.getElementById("nz-server-form-submit");
}

function serverFormSshSelect() {
	return document.getElementById("nz-server-ssh");
}

function setServerFormSubmitLabel(text: string) {
	const submit = serverFormSubmitButton();
	if (!(submit instanceof HTMLButtonElement)) return;
	submit.dataset.defaultLabel = text;
	const label = submit.querySelector<HTMLElement>("[data-auth-btn-label]");
	if (label) label.textContent = text;
}

function setServerFormBusy(busy: boolean) {
	serverFormBusy = busy;
	const submit = serverFormSubmitButton();
	const cancel = document.querySelector(
		"#nz-server-form-dialog [data-nz-modal-close]",
	);
	const fieldIds = [
		"nz-server-name",
		"nz-server-description",
		"nz-server-ssh",
		"nz-server-ip",
		"nz-server-port",
		"nz-server-user",
	];

	if (submit instanceof HTMLButtonElement) {
		submit.disabled = busy;
		submit.setAttribute("aria-busy", busy ? "true" : "false");
		setButtonLoadingVisuals(submit, busy);
	}
	if (cancel instanceof HTMLButtonElement) cancel.disabled = busy;
	for (const id of fieldIds) {
		const el = document.getElementById(id);
		if (
			el instanceof HTMLInputElement ||
			el instanceof HTMLTextAreaElement ||
			el instanceof HTMLSelectElement
		) {
			el.disabled = busy;
		}
	}
	if (!busy) updateServerFormSubmitState();
}

function updateServerFormSubmitState() {
	const submit = serverFormSubmitButton();
	const ssh = serverFormSshSelect();
	if (
		!(submit instanceof HTMLButtonElement) ||
		!(ssh instanceof HTMLSelectElement)
	) {
		return;
	}
	if (serverFormBusy) {
		submit.disabled = true;
		return;
	}
	const hasSshKey = ssh.value.trim() !== "";
	const blockedByLimit = !canCreateMore && !editingServerId;
	submit.disabled = !hasSshKey || blockedByLimit;
}

function resetServerForm() {
	editingServerId = "";
	const idEl = document.getElementById("nz-server-form-id");
	const title = serverFormTitleEl();
	const name = document.getElementById("nz-server-name");
	const desc = document.getElementById("nz-server-description");
	const ip = document.getElementById("nz-server-ip");
	const port = document.getElementById("nz-server-port");
	const user = document.getElementById("nz-server-user");
	const ssh = document.getElementById("nz-server-ssh");
	const warn = document.getElementById("nz-server-form-limit");
	if (idEl instanceof HTMLInputElement) idEl.value = "";
	if (title) title.textContent = "Create Server";
	setServerFormSubmitLabel("Create");
	setServerFormBusy(false);
	if (name instanceof HTMLInputElement) name.value = "";
	if (desc instanceof HTMLTextAreaElement) desc.value = "";
	if (ip instanceof HTMLInputElement) ip.value = "";
	if (port instanceof HTMLInputElement) port.value = "22";
	if (user instanceof HTMLInputElement) user.value = "root";
	if (ssh instanceof HTMLSelectElement) ssh.value = "";
	if (warn) warn.classList.toggle("hidden", canCreateMore);
	updateServerFormSubmitState();
}

async function openEditServer(serverId: string) {
	resetServerForm();
	editingServerId = serverId;
	try {
		const server = await trpcQuery<
			ServerRow & { sshKey?: { name?: string; publicKey?: string } }
		>("server.one", { serverId });
		const idEl = document.getElementById("nz-server-form-id");
		const title = serverFormTitleEl();
		const name = document.getElementById("nz-server-name");
		const desc = document.getElementById("nz-server-description");
		const ip = document.getElementById("nz-server-ip");
		const port = document.getElementById("nz-server-port");
		const user = document.getElementById("nz-server-user");
		const ssh = document.getElementById("nz-server-ssh");
		const warn = document.getElementById("nz-server-form-limit");
		if (idEl instanceof HTMLInputElement) idEl.value = serverId;
		if (title) title.textContent = "Edit Server";
		setServerFormSubmitLabel("Update");
		if (name instanceof HTMLInputElement) name.value = server.name || "";
		if (desc instanceof HTMLTextAreaElement)
			desc.value = server.description || "";
		if (ip instanceof HTMLInputElement) ip.value = server.ipAddress || "";
		if (port instanceof HTMLInputElement)
			port.value = String(server.port || 22);
		if (user instanceof HTMLInputElement)
			user.value = server.username || "root";
		if (ssh instanceof HTMLSelectElement) ssh.value = server.sshKeyId || "";
		if (warn) warn.classList.add("hidden");
		updateServerFormSubmitState();
		openDialog("nz-server-form-dialog");
	} catch {
		showToast("Could not load server", "error");
	}
}

async function refreshCanCreate() {
	try {
		canCreateMore = !!(await trpcQuery<boolean>("stripe.canCreateMoreServers"));
	} catch {
		canCreateMore = true;
	}
}

function closeServerMenu(serverId: string) {
	const menu = document.getElementById(`nz-server-menu-${serverId}`);
	const trigger = document.getElementById(`nz-server-menu-trigger-${serverId}`);
	menu?.classList.add("hidden");
	if (trigger) {
		trigger.setAttribute("aria-expanded", "false");
		menu?.style.removeProperty("position");
		menu?.style.removeProperty("top");
		menu?.style.removeProperty("right");
		menu?.style.removeProperty("left");
		menu?.style.removeProperty("minWidth");
		menu?.style.removeProperty("zIndex");
	}
}

async function runServerMenuAction(
	root: HTMLElement,
	action: string,
	serverId: string,
	el: HTMLElement,
) {
	closeServerMenu(serverId);

	switch (action) {
		case "view":
			await openServerViewDialog(serverId);
			break;
		case "setup":
			setupServerId = serverId;
			await openSetupDialog(serverId);
			break;
		case "terminal":
			openTerminalDialog(serverId, el.dataset.serverName || "");
			break;
		case "edit":
			await openEditServer(serverId);
			break;
		case "web-server": {
			root.dataset.serverId = serverId;
			const dlg = document.getElementById("nz-server-actions-dialog");
			dlg?.querySelectorAll("[data-ws-action-type]").forEach((btn) => {
				if (btn.getAttribute("data-ws-server-id") !== "local") {
					btn.setAttribute("data-ws-server-id", serverId);
				}
			});
			const cleanup = document.getElementById(
				"nz-server-actions-docker-cleanup",
			);
			try {
				const server = await trpcQuery<{ enableDockerCleanup?: boolean }>(
					"server.one",
					{ serverId },
				);
				if (cleanup instanceof HTMLInputElement)
					cleanup.checked = !!server.enableDockerCleanup;
			} catch {
				/* ignore */
			}
			openDialog("nz-server-actions-dialog");
			const actionsRoot = document.getElementById("nz-server-actions-dialog");
			if (actionsRoot) {
				bindWebServerActionDropdowns(actionsRoot, serverId, "-remote");
				bindDockerCleanupToggle(actionsRoot, serverId);
			}
			break;
		}
		case "delete": {
			pendingDeleteId = serverId;
			pendingDeleteAttachedServices = false;
			const body = document.getElementById("nz-server-delete-body");
			const canDeleteServer = el.dataset.canDeleteServer === "1";
			const serviceCount = Number.parseInt(
				el.dataset.serverServiceCount ?? "0",
				10,
			);
			const attachedServiceCount = Number.isFinite(serviceCount)
				? Math.max(serviceCount, 0)
				: 0;
			const hasAttachedServices = attachedServiceCount > 0 || !canDeleteServer;
			if (body) {
				const serviceLabel =
					attachedServiceCount <= 0
						? "attached services"
						: attachedServiceCount === 1
							? "1 attached service"
							: `${attachedServiceCount} attached services`;
				body.innerHTML = hasAttachedServices
					? `<div class="space-y-3">
						<p>This server has ${escapeHtml(serviceLabel)}. Deleting it can also permanently delete every attached service and its Docker resources.</p>
						<div class="nz-modal__callout border-amber-200/80 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">This cannot be undone. Back up anything important first.</div>
						<label class="flex cursor-pointer items-start gap-3 rounded-md border border-[var(--nz-border)] bg-[var(--nz-bg-muted)] p-3 text-[11px] text-[var(--nz-text)]">
							<input type="checkbox" id="nz-server-delete-attached-services" class="mt-0.5 size-4 cursor-pointer" />
							<span>Also delete all attached services on this server</span>
						</label>
					</div>`
					: "This will delete the server and all associated data.";
			}
			setServerDeleteConfirmState(hasAttachedServices);
			const checkbox = document.getElementById(
				"nz-server-delete-attached-services",
			);
			if (checkbox instanceof HTMLInputElement) {
				checkbox.addEventListener("change", () => {
					pendingDeleteAttachedServices = checkbox.checked;
					setServerDeleteConfirmState(hasAttachedServices);
				});
			}
			openDialog("nz-server-delete-dialog");
			break;
		}
		default: {
			advancedServerId = serverId;
			await openAdvancedDialog(action, serverId);
		}
	}
}

function bindServerCards(root: HTMLElement) {
	root
		.querySelectorAll("[id^='nz-server-menu-trigger-']")
		.forEach((trigger) => {
			const serverId = trigger.id.replace("nz-server-menu-trigger-", "");
			if (serverId) bindDropdown(trigger.id, `nz-server-menu-${serverId}`);
		});

	// Guard the delegated action listener: bindServerCards now runs on every
	// boot, so without this a no-op re-boot on the same root would stack
	// duplicate click handlers (firing each action twice).
	if (root.dataset.cardsActionBound === "1") return;
	root.dataset.cardsActionBound = "1";

	root.addEventListener("click", (e) => {
		const item =
			e.target instanceof Element
				? e.target.closest("[data-server-menu-action]")
				: null;
		if (!(item instanceof HTMLButtonElement) || item.disabled) return;
		const action = item.dataset.serverMenuAction ?? "";
		const serverId = item.dataset.serverId ?? "";
		if (!action || !serverId) return;
		void runServerMenuAction(root, action, serverId, item);
	});
}

type TraefikTreeItem = {
	id: string;
	name: string;
	type: "file" | "directory";
	children?: TraefikTreeItem[];
};

function renderTraefikTreeHtml(items: TraefikTreeItem[], depth = 0): string {
	return items
		.map((item) => {
			const typeLabel = item.type === "directory" ? "Directory" : "File";
			const row = `<li class="rounded border p-2" style="margin-left:${depth * 12}px">
				<span class="font-medium">${escapeHtml(item.name)}</span>
				<span class="text-xs text-muted-foreground"> (${typeLabel})</span>
				<br/>
				<span class="text-xs text-muted-foreground font-mono">${escapeHtml(item.id)}</span>
			</li>`;
			const children = item.children?.length
				? renderTraefikTreeHtml(item.children, depth + 1)
				: "";
			return row + children;
		})
		.join("");
}

async function openAdvancedDialog(action: string, serverId: string) {
	const title = document.getElementById("nz-server-advanced-dialog-title");
	const body = document.getElementById("nz-server-advanced-body");
	if (!title || !body) return;
	body.innerHTML = `<p class="text-sm text-muted-foreground">Loading…</p>`;
	openDialog("nz-server-advanced-dialog");

	try {
		switch (action) {
			case "traefik-fs": {
				title.textContent = "Traefik File System";
				const directories = await trpcQuery<TraefikTreeItem[]>(
					"settings.readDirectories",
					{ serverId },
				);
				body.innerHTML =
					!directories || directories.length === 0
						? `<p class="text-sm text-muted-foreground">No directories or files detected.</p>`
						: `<ul class="space-y-2 text-sm">${renderTraefikTreeHtml(directories)}</ul>`;
				break;
			}
			case "docker-containers": {
				title.textContent = "Docker Containers";
				const containers = await trpcQuery<
					Array<{ name: string; containerId: string; state: string }>
				>("docker.getContainers", { serverId });
				body.innerHTML =
					containers.length === 0
						? `<p class="text-sm text-muted-foreground">No containers found.</p>`
						: `<div class="overflow-x-auto"><table class="w-full text-sm"><thead><tr class="border-b"><th class="p-2 text-left">Name</th><th class="p-2 text-left">State</th><th class="p-2 text-left">ID</th></tr></thead><tbody>${containers.map((c) => `<tr class="border-b"><td class="p-2">${c.name}</td><td class="p-2">${c.state}</td><td class="p-2 font-mono text-xs">${c.containerId}</td></tr>`).join("")}</tbody></table></div>`;
				break;
			}
			case "swarm-nodes": {
				title.textContent = "Cluster Nodes";
				const nodes = await trpcQuery<
					Array<{
						Description?: { Hostname?: string };
						Status?: { State?: string };
						Spec?: { Role?: string };
					}>
				>("cluster.getNodes", { serverId });
				body.innerHTML =
					nodes.length === 0
						? `<p class="text-sm text-muted-foreground">No nodes found.</p>`
						: `<ul class="space-y-2 text-sm">${nodes.map((n) => `<li class="rounded border p-2 flex justify-between"><span>${n.Description?.Hostname ?? "—"}</span><span class="text-muted-foreground">${n.Spec?.Role ?? "—"} · ${n.Status?.State ?? "—"}</span></li>`).join("")}</ul>`;
				break;
			}
			case "schedules": {
				title.textContent = "Tasks";
				const schedules = await trpcQuery<
					Array<{ name: string; cronSchedule?: string; scheduleId: string }>
				>("schedule.list", { id: serverId, scheduleType: "server" });
				body.innerHTML =
					!schedules || schedules.length === 0
						? `<p class="text-sm text-muted-foreground">No tasks found.</p>`
						: `<ul class="space-y-2 text-sm">${schedules.map((s) => `<li class="rounded border p-2"><span class="font-medium">${s.name}</span><br/><span class="text-xs text-muted-foreground">${s.cronSchedule ?? "—"}</span></li>`).join("")}</ul>`;
				break;
			}
			default:
				body.innerHTML = `<p class="text-sm text-muted-foreground">Unknown action.</p>`;
		}
	} catch (e) {
		body.innerHTML = `<p class="text-sm text-destructive">${e instanceof Error ? e.message : "Failed to load"}</p>`;
	}
}

async function runServerValidation(
	serverId: string,
	validation: HTMLElement | null,
	state: HTMLElement | null,
	options?: { reloadOnSuccess?: boolean },
) {
	if (!(validation instanceof HTMLElement)) return false;
	validation.classList.remove("hidden");
	validation.textContent = "Checking server configuration…";
	state && (state.textContent = "Validating");
	try {
		const result = await trpcQuery<Record<string, unknown>>("server.validate", {
			serverId,
		});
		validation.innerHTML = `<div class="grid gap-2 md:grid-cols-2">${Object.entries(
			result || {},
		)
			.map(([key, value]) => {
				const label = key
					.replace(/([A-Z])/g, " $1")
					.replace(/^./, (c) => c.toUpperCase());
				const status = validationStatus(value);
				return `<div class="rounded-md border border-[var(--nz-border)] bg-[var(--nz-surface)] p-2"><p class="font-medium text-[var(--nz-text)]">${escapeHtml(label)}</p><p class="mt-1 text-[var(--nz-text-muted)]">${escapeHtml(status)}</p></div>`;
			})
			.join("")}</div>`;
		state && (state.textContent = "Validation complete");
		if (options?.reloadOnSuccess) {
			showToast("Server setup completed", "success");
			window.setTimeout(() => window.location.reload(), 900);
		}
		return true;
	} catch (error) {
		validation.innerHTML = `<p class="text-destructive">${escapeHtml(errorMessage(error, "Validation failed"))}</p>`;
		state && (state.textContent = "Validation failed");
		return false;
	}
}

function isStaleSetupRun(server: ServerRow) {
	if (server.setupStatus !== "running") return false;
	const startedAt = server.setupStartedAt
		? new Date(server.setupStartedAt).getTime()
		: 0;
	if (!startedAt || Number.isNaN(startedAt)) return true;
	return Date.now() - startedAt > 5 * 60 * 1000;
}

async function rollbackFailedNewServer(
	serverId: string,
	logs: HTMLElement | null,
) {
	if (setupServerRemoved || setupServerId !== serverId) return;
	setupServerRemoved = true;
	appendLog(
		logs,
		"\nSetup failed. The server is still saved — use “Run setup again” from the server menu to retry.\n",
	);
}

function formatServerTimestamp(value: string | null | undefined) {
	if (!value) return "—";
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function serverViewDetailRow(label: string, value: unknown) {
	return `<div class="nz-modal__field">
		<span class="nz-modal__label">${escapeHtml(label)}</span>
		<p class="mt-1 break-all text-xs text-[var(--nz-text)]">${escapeHtml(String(value ?? "—"))}</p>
	</div>`;
}

async function openServerViewDialog(serverId: string) {
	const body = document.getElementById("nz-server-view-body");
	const title = document.getElementById("nz-server-view-dialog-title");
	if (!body) return;

	body.innerHTML = `<p class="text-xs text-[var(--nz-text-muted)]">Loading server details…</p>`;
	openDialog("nz-server-view-dialog");

	try {
		const server = await trpcQuery<
			ServerRow & { sshKey?: { name?: string | null } | null }
		>("server.one", { serverId });
		const setupState = server.setupStatus || "not_started";

		if (title) title.textContent = server.name?.trim() || "Server details";

		body.innerHTML = `
			<div class="space-y-4 text-xs">
				<div class="flex flex-wrap items-start justify-between gap-3 rounded-md border border-[var(--nz-border)] bg-[var(--nz-bg-muted)] p-3">
					<div class="min-w-0">
						<p class="text-sm font-semibold text-[var(--nz-text)]">${escapeHtml(server.name)}</p>
						<p class="mt-1 break-all text-[var(--nz-text-muted)]">${escapeHtml(server.username)}@${escapeHtml(server.ipAddress)}:${escapeHtml(server.port)}</p>
					</div>
					<span class="inline-flex rounded-md px-2 py-1 text-[10px] font-medium capitalize ${setupStatusClass(setupState)}">${escapeHtml(setupStatusLabel(setupState))}</span>
				</div>
				<div class="grid gap-3 sm:grid-cols-2">
					${serverViewDetailRow("IP address", server.ipAddress)}
					${serverViewDetailRow("Port", server.port)}
					${serverViewDetailRow("Username", server.username)}
					${serverViewDetailRow("SSH key", server.sshKey?.name?.trim() || (server.sshKeyId ? "Connected" : "—"))}
					${serverViewDetailRow("Server ID", server.serverId)}
					${serverViewDetailRow("Setup finished", formatServerTimestamp(server.setupFinishedAt))}
				</div>
				${
					server.description
						? `<div class="nz-modal__field">
							<span class="nz-modal__label">Description</span>
							<p class="mt-1 text-xs text-[var(--nz-text-muted)]">${escapeHtml(server.description)}</p>
						</div>`
						: ""
				}
				<section class="space-y-2">
					<p class="text-xs font-medium text-[var(--nz-text)]">Setup validation</p>
					<div id="nz-server-view-validation" class="rounded-md border border-[var(--nz-border)] bg-[var(--nz-bg-muted)] p-3 text-[11px] text-[var(--nz-text-muted)]">
						Checking server configuration…
					</div>
				</section>
			</div>
		`;

		const validation = document.getElementById("nz-server-view-validation");
		await runServerValidation(serverId, validation, null);
	} catch {
		closeDialog("nz-server-view-dialog");
		showToast("Could not load server details", "error");
	}
}

async function openSetupDialog(
	serverId: string,
	options?: { isNewServer?: boolean },
) {
	setupServerId = serverId;
	setupIsNewServer = !!options?.isNewServer;
	setupServerRemoved = false;
	setupFailed = false;
	const body = document.getElementById("nz-server-setup-body");
	if (!body) return;
	unsubscribeSetupLogs?.();
	unsubscribeSetupLogs = null;
	try {
		const server = await trpcQuery<ServerRow>("server.one", { serverId });
		const setupState = server.setupStatus || "not_started";
		const canRunSetup = !!server.sshKeyId;

		body.innerHTML = `
				<div class="space-y-4 text-xs">
					<div class="flex flex-wrap items-start justify-between gap-3 rounded-md border border-[var(--nz-border)] bg-[var(--nz-bg-muted)] p-3">
						<div class="min-w-0">
							<p class="text-sm font-semibold text-[var(--nz-text)]">${escapeHtml(server.name)}</p>
							<p class="mt-1 text-[var(--nz-text-muted)]">${escapeHtml(server.username)}@${escapeHtml(server.ipAddress)}:${escapeHtml(server.port)}</p>
						</div>
						<span class="inline-flex rounded-md px-2 py-1 text-[10px] font-medium capitalize ${setupStatusClass(setupState)}">${escapeHtml(setupStatusLabel(setupState))}</span>
					</div>
					${
						canRunSetup
							? ""
							: `<div class="nz-modal__callout border-amber-200/80 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
								Add an SSH key before setup can run.
							</div>`
					}
					${
						server.setupError
							? `<div class="nz-modal__callout border-red-500/20 bg-red-500/10 text-destructive">${escapeHtml(server.setupError)}</div>`
							: ""
					}
					<p id="nz-server-setup-state" class="text-[11px] text-[var(--nz-text-subtle)]">Preparing…</p>
					<div id="nz-server-setup-validation" class="hidden rounded-md border border-[var(--nz-border)] bg-[var(--nz-bg-muted)] p-3 text-[11px] text-[var(--nz-text-muted)]"></div>
					<section class="overflow-hidden rounded-md border border-[var(--nz-border)] bg-[var(--nz-bg-muted)]">
						<div class="flex items-center justify-between border-b border-[var(--nz-border)] px-3 py-2 text-[11px] text-[var(--nz-text-muted)]">
							<span class="font-medium text-[var(--nz-text)]">Setup logs</span>
							<span>live</span>
						</div>
						<pre id="nz-server-setup-logs" class="max-h-[22rem] min-h-[14rem] overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-5 text-[var(--nz-text-muted)]"></pre>
					</section>
				</div>
			`;

		const logs = document.getElementById("nz-server-setup-logs");
		const state = document.getElementById("nz-server-setup-state");
		const validation = document.getElementById("nz-server-setup-validation");

		const setState = (label: string) => {
			if (state) state.textContent = label;
		};

		let setupRunning = false;
		let setupLogPoll: ReturnType<typeof setInterval> | null = null;

		const stopSetupLogPoll = () => {
			if (setupLogPoll !== null) {
				clearInterval(setupLogPoll);
				setupLogPoll = null;
			}
		};

		const finishSetup = async (failed: boolean, errorText?: string) => {
			stopSetupLogPoll();
			setupRunning = false;
			if (failed) {
				if (errorText) appendLog(logs, `\n${errorText}\n`);
				setState("Setup failed");
				setupFailed = true;
				showToast("Setup failed", "error");
				await rollbackFailedNewServer(serverId, logs);
				return;
			}

			const latest = await trpcQuery<ServerRow>("server.one", {
				serverId,
			}).catch(() => null);
			if (latest?.setupStatus === "failed") {
				appendLog(
					logs,
					`\nSetup failed${latest.setupError ? `: ${latest.setupError}` : ""}\n`,
				);
				await finishSetup(true);
				return;
			}

			appendLog(logs, "\nSetup completed.\n");
			await runServerValidation(serverId, validation, state, {
				reloadOnSuccess: true,
			});
		};

		const startSetupViaHttp = () => {
			if (!canRunSetup || setupRunning) return;
			unsubscribeSetupLogs?.();
			unsubscribeSetupLogs = null;
			setupRunning = true;
			setupIsNewServer = false;
			setState("Running setup");
			if (logs) logs.textContent = "Starting setup…\n";

			stopSetupLogPoll();
			setupLogPoll = setInterval(() => {
				void loadLatestServerSetupLog(serverId, logs, state);
			}, 1500);

			void (async () => {
				try {
					await trpcMutate("server.setup", { serverId });
					await loadLatestServerSetupLog(serverId, logs, state);
					await finishSetup(false);
				} catch (error) {
					await loadLatestServerSetupLog(serverId, logs, state);
					await finishSetup(true, errorMessage(error, "Setup failed"));
				}
			})();
		};

		const startSetup = () => {
			if (!canRunSetup || setupRunning) return;
			if (isPlatformWebSocketSplit()) {
				startSetupViaHttp();
				return;
			}

			unsubscribeSetupLogs?.();
			unsubscribeSetupLogs = null;
			setupRunning = true;
			setupIsNewServer = false;
			setState("Running setup");
			if (logs) logs.textContent = "Starting setup…\n";
			try {
				unsubscribeSetupLogs = trpcSubscribe<string>(
					"server.setupWithLogs",
					{ serverId },
					{
						onData(value) {
							appendLog(logs, value);
						},
						onError(error) {
							unsubscribeSetupLogs?.();
							unsubscribeSetupLogs = null;
							void finishSetup(true, errorMessage(error, "Setup failed"));
						},
						onComplete() {
							unsubscribeSetupLogs?.();
							unsubscribeSetupLogs = null;
							void finishSetup(false);
						},
					},
				);
			} catch (error) {
				void finishSetup(
					true,
					errorMessage(error, "Could not start setup stream"),
				);
			}
		};

		openDialog("nz-server-setup-dialog");

		if (!canRunSetup) {
			setState("SSH key required");
			if (logs)
				logs.textContent =
					"Connect an SSH key to this server before setup can run.";
			return;
		}

		if (setupState === "ready") {
			closeDialog("nz-server-setup-dialog");
			await openServerViewDialog(serverId);
			return;
		}

		if (setupState === "running" && !isStaleSetupRun(server)) {
			setState("Setup in progress");
			if (logs) logs.textContent = "Setup is already running…\n";
			await loadLatestServerSetupLog(serverId, logs, state);
			if (isPlatformWebSocketSplit()) {
				stopSetupLogPoll();
				setupLogPoll = setInterval(() => {
					void loadLatestServerSetupLog(serverId, logs, state);
				}, 1500);
			}
			return;
		}

		if (setupState === "running" && isStaleSetupRun(server)) {
			appendLog(logs, "Previous setup looks stalled. Retrying…\n");
		}

		startSetup();
	} catch {
		showToast("Could not load server setup", "error");
	}
}

function bindServerForm() {
	const form = document.getElementById("nz-server-form");
	const ssh = serverFormSshSelect();

	ssh?.addEventListener("change", updateServerFormSubmitState);
	updateServerFormSubmitState();

	form?.addEventListener("submit", async (e) => {
		e.preventDefault();
		const submit = document.getElementById("nz-server-form-submit");
		const name = document.getElementById("nz-server-name");
		const desc = document.getElementById("nz-server-description");
		const ip = document.getElementById("nz-server-ip");
		const port = document.getElementById("nz-server-port");
		const user = document.getElementById("nz-server-user");
		const ssh = document.getElementById("nz-server-ssh");
		if (
			!(submit instanceof HTMLButtonElement) ||
			!(name instanceof HTMLInputElement) ||
			!(desc instanceof HTMLTextAreaElement) ||
			!(ip instanceof HTMLInputElement) ||
			!(port instanceof HTMLInputElement) ||
			!(user instanceof HTMLInputElement) ||
			!(ssh instanceof HTMLSelectElement)
		) {
			return;
		}
		if (!canCreateMore && !editingServerId) {
			showToast("Cannot create more servers — upgrade your plan", "error");
			return;
		}
		if (!ssh.value.trim()) {
			showToast("Select an SSH key", "error");
			updateServerFormSubmitState();
			return;
		}
		setServerFormBusy(true);
		let keepLocked = false;
		const payload = {
			name: name.value,
			description: desc.value,
			ipAddress: ip.value.trim(),
			port: Number(port.value) || 22,
			username: user.value || "root",
			sshKeyId: ssh.value,
			serverId: editingServerId || "",
		};
		try {
			if (editingServerId) {
				await trpcMutate("server.update", payload);
				showToast("Server Updated", "success");
				keepLocked = true;
				closeDialog("nz-server-form-dialog");
				window.location.reload();
			} else {
				const created = await trpcMutate<ServerRow>("server.create", payload);
				showToast("Server Created", "success");
				keepLocked = true;
				closeDialog("nz-server-form-dialog");
				setServerFormBusy(false);
				if (created?.serverId) {
					void openSetupDialog(created.serverId, { isNewServer: true });
				} else {
					window.location.reload();
				}
			}
		} catch {
			showToast(
				editingServerId ? "Error updating a server" : "Error creating a server",
				"error",
			);
		} finally {
			if (!keepLocked) setServerFormBusy(false);
		}
	});
}

function bindWelcomeDialog() {
	const root = getRoot();
	if (root?.dataset.showWelcome !== "1") return;
	openDialog("nz-servers-welcome-dialog");
	document
		.getElementById("nz-servers-welcome-close")
		?.addEventListener("click", () => {
			closeDialog("nz-servers-welcome-dialog");
			const url = new URL(window.location.href);
			url.searchParams.delete("success");
			window.history.replaceState({}, "", url.pathname + url.search);
		});
}

function bindTabs(root: HTMLElement) {
	const tabs = root.querySelectorAll<HTMLButtonElement>("[data-servers-tab]");
	const panels = root.querySelectorAll<HTMLElement>("[data-servers-panel]");
	const tabInput = document.getElementById(
		"nz-servers-tab-input",
	) as HTMLInputElement | null;
	const filterForm = document.getElementById("nz-servers-filter-form");

	const setActiveTab = (id: string) => {
		const url = new URL(window.location.href);
		if (id === "servers") url.searchParams.delete("tab");
		else url.searchParams.set("tab", id);
		window.history.replaceState({}, "", url.pathname + url.search);
		if (tabInput) tabInput.value = id;

		for (const tab of tabs) {
			const isActive = tab.getAttribute("data-servers-tab") === id;
			tab.classList.toggle("nz-domains-tab--active", isActive);
			tab.setAttribute("aria-selected", isActive ? "true" : "false");
		}

		for (const panel of panels) {
			panel.classList.toggle(
				"hidden",
				panel.getAttribute("data-servers-panel") !== id,
			);
		}

		if (filterForm instanceof HTMLElement) {
			const searchWrap = filterForm.querySelector<HTMLElement>(
				"[data-servers-search-wrap]",
			);
			const status = filterForm.querySelector<HTMLElement>(
				"[data-servers-status-wrap]",
			);
			const showServerFilters = id === "servers";
			searchWrap?.classList.toggle("hidden", !showServerFilters);
			status?.classList.toggle("hidden", !showServerFilters);
			filterForm
				.querySelectorAll<HTMLElement>("[data-servers-add]")
				.forEach((btn) => {
					btn.classList.toggle(
						"hidden",
						btn.getAttribute("data-servers-add") !==
							(id === "ssh-keys" ? "ssh-key" : "server"),
					);
				});
		}
	};

	for (const tab of tabs) {
		tab.addEventListener("click", () => {
			const id = tab.getAttribute("data-servers-tab");
			if (!id) return;
			setActiveTab(id);
		});
	}

	root
		.querySelectorAll<HTMLElement>("[data-servers-tab-jump]")
		.forEach((el) => {
			el.addEventListener("click", () => {
				const id = el.getAttribute("data-servers-tab-jump");
				if (!id) return;
				setActiveTab(id);
				if (id === "ssh-keys") {
					document.getElementById("nz-ssh-create-open-list")?.click();
				}
			});
		});
}

function bindServersSearch() {
	const wrap = document.getElementById("nz-servers-search-root");
	if (!wrap || wrap.dataset.bound === "1") return;
	wrap.dataset.bound = "1";

	const toggle = document.getElementById("nz-servers-search-toggle");
	const panel = document.getElementById("nz-servers-search-panel");
	const input = document.getElementById("nz-servers-search");
	const form = document.getElementById("nz-servers-filter-form");

	if (
		!(toggle instanceof HTMLButtonElement) ||
		!(panel instanceof HTMLElement) ||
		!(input instanceof HTMLInputElement)
	) {
		return;
	}

	const openClasses = [
		"w-44",
		"sm:w-52",
		"px-2",
		"opacity-100",
		"pointer-events-auto",
		"border-[var(--nz-border)]",
	];
	const closedClasses = [
		"w-0",
		"px-0",
		"opacity-0",
		"pointer-events-none",
		"border-transparent",
	];

	const openSearch = () => {
		toggle.setAttribute("aria-expanded", "true");
		panel.classList.remove(...closedClasses);
		panel.classList.add(...openClasses);
		window.setTimeout(() => input.focus(), 120);
	};

	const closeSearch = () => {
		toggle.setAttribute("aria-expanded", "false");
		panel.classList.remove(...openClasses);
		panel.classList.add(...closedClasses);
		input.blur();
	};

	toggle.addEventListener("click", (event) => {
		event.stopPropagation();
		const expanded = toggle.getAttribute("aria-expanded") === "true";
		if (expanded) closeSearch();
		else openSearch();
	});

	document.addEventListener("click", (event) => {
		if (!(event.target instanceof Node)) return;
		if (!wrap.contains(event.target)) closeSearch();
	});

	input.addEventListener("keydown", (event) => {
		if (event.key === "Enter" && form instanceof HTMLFormElement) {
			event.preventDefault();
			form.submit();
		}
		if (event.key === "Escape") closeSearch();
	});

	if (input.value.trim()) openSearch();
}

function clearServersBindState() {
	document.getElementById("nz-servers-root")?.removeAttribute("data-bound");
	document
		.getElementById("nz-servers-search-root")
		?.removeAttribute("data-bound");
}

function bindServerDialogActions() {
	bindElementEventOnce(
		document.getElementById("nz-server-create-open"),
		"serverCreateOpenBound",
		"click",
		async () => {
			await refreshCanCreate();
			resetServerForm();
			openDialog("nz-server-form-dialog");
		},
	);

	bindElementEventOnce(
		document.getElementById("nz-server-delete-cancel"),
		"serverDeleteCancelBound",
			"click",
			() => {
				pendingDeleteId = "";
				pendingDeleteAttachedServices = false;
			},
		);
	bindElementEventOnce(
		document.getElementById("nz-server-delete-confirm"),
		"serverDeleteConfirmBound",
		"click",
		async () => {
			if (!pendingDeleteId) return;
			const btn = document.getElementById("nz-server-delete-confirm");
				if (btn instanceof HTMLButtonElement) btn.disabled = true;
				try {
					await trpcMutate("server.remove", {
						serverId: pendingDeleteId,
						deleteAttachedServices: pendingDeleteAttachedServices,
					});
					showToast("Server deleted successfully", "success");
					closeDialog("nz-server-delete-dialog");
					window.location.reload();
			} catch (e) {
				showToast(e instanceof Error ? e.message : "Delete failed", "error");
			} finally {
				if (btn instanceof HTMLButtonElement) btn.disabled = false;
			}
		},
	);

	bindElementEventOnce(
		document.getElementById("nz-servers-reset-onboarding"),
		"serversResetOnboardingBound",
		"click",
		() => {
			window.location.href = "/dashboard/servers?success=true";
		},
	);
}

export function bindServersDashboard() {
	const root = getRoot();
	if (!root) return;

	canCreateMore = root.dataset.canCreateMore !== "0";
	bindServerDialogActions();

	// The per-server 3-dot menu lives on cards that Astro view transitions swap
	// in as fresh DOM. Bind it on EVERY boot (not just the first) so it works on
	// client-side navigation without needing a full page refresh. bindServerCards
	// is idempotent — per-trigger dropdowns abort any prior binding and the
	// card-level action listener is guarded against double-binding — so running
	// it before the one-time guard below is safe.
	bindServerCards(root);

	if (root.dataset.bound === "1") return;
	root.dataset.bound = "1";

	bindServerForm();
	bindWelcomeDialog();
	bindTabs(root);
	bindServersSearch();
	bindWebServerActionDropdowns(root);
	bindDockerCleanupToggle(root);
	bindTraefikDashboardConfirm(root);
	bindTraefikEnvDialog(root);
	bindTraefikPortsDialog(root);
	bindUpdateServerIpDialog();
	bindLogsDialog();
	bindTerminalDialog();
	bindSharedDialogCloseButtons();
	bindCopyServerIp();

	// Setup dialog close handling (refresh-on-failure) is bound below.

	// When the setup dialog closes after a failed setup, refresh so the list
	// reflects reality: a rolled-back new server disappears, and a failed
	// re-run of an existing server shows its updated status.
	const setupDialog = document.getElementById("nz-server-setup-dialog");
	if (setupDialog instanceof HTMLDialogElement) {
		setupDialog.addEventListener("close", () => {
			unsubscribeSetupLogs?.();
			unsubscribeSetupLogs = null;
			if (setupFailed) {
				setupFailed = false;
				window.location.reload();
			}
		});
	}
}

function bootServersDashboard() {
	try {
		bindServersDashboard();
	} catch (error) {
		console.error("[servers-dashboard] bind failed", error);
		clearServersBindState();
	}
}

bootServersDashboard();
document.addEventListener("astro:before-swap", clearServersBindState);
document.addEventListener("astro:page-load", bootServersDashboard);
document.addEventListener("astro:after-swap", bootServersDashboard);
