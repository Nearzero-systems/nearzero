import { trpcMutate, trpcQuery } from "@/lib/client-api";
import {
	rememberDefaultLabel,
	setButtonLoadingVisuals,
} from "@/lib/auth-button-state";
import { disconnectDockerLogs, mountDockerLogs } from "@/scripts/docker-logs-ws";
import { executeWithHealthCheck } from "@/scripts/health-check";
import { bindDropdown, closeDialog, openDialog, showToast } from "@/scripts/ui";

type TraefikPort = {
	targetPort: number;
	publishedPort: number;
	protocol: "tcp" | "udp" | "sctp";
};

export function bindWebServerActionDropdowns(root: HTMLElement, serverId?: string, menuSuffix = "") {
	const suffix = menuSuffix || (serverId ? `-${serverId}` : "");
	bindDropdown(`nz-ws-server-menu${suffix}`, `nz-ws-server-panel${suffix}`);
	bindDropdown(`nz-ws-traefik-menu${suffix}`, `nz-ws-traefik-panel${suffix}`);
	bindDropdown(`nz-ws-space-menu${suffix}`, `nz-ws-space-panel${suffix}`);

	root.querySelectorAll("[data-ws-action-type]").forEach((el) => {
		el.addEventListener("click", async () => {
			const action = el.getAttribute("data-ws-action-type");
			if (!action) return;
			const sid =
				serverId ??
				el.getAttribute("data-ws-server-id") ??
				undefined;
			try {
				switch (action) {
					case "reload-server":
						await trpcMutate("settings.reloadServer");
						showToast("Server Reloaded", "success");
						break;
					case "clean-redis":
						await trpcMutate("settings.cleanRedis");
						showToast("Redis cleaned", "success");
						break;
					case "reload-redis":
						await trpcMutate("settings.reloadRedis");
						showToast("Redis reloaded", "success");
						break;
					case "clean-queue":
						await trpcMutate("settings.cleanAllDeploymentQueue");
						showToast("Deployment queue cleaned", "success");
						break;
					case "reload-traefik":
						await executeWithHealthCheck(
							() => trpcMutate("settings.reloadTraefik", { serverId: sid }),
							{ initialDelay: 5000, pollInterval: 4000, successMessage: "Traefik Reloaded" },
						);
						break;
					case "clean-images":
						await trpcMutate("settings.cleanUnusedImages", { serverId: sid });
						showToast("Cleaned images", "success");
						break;
					case "clean-volumes":
						await trpcMutate("settings.cleanUnusedVolumes", { serverId: sid });
						showToast("Cleaned volumes", "success");
						break;
					case "clean-containers":
						await trpcMutate("settings.cleanStoppedContainers", { serverId: sid });
						showToast("Stopped containers cleaned", "success");
						break;
					case "clean-patch":
						await trpcMutate("patch.cleanPatchRepos", { serverId: sid });
						showToast("Cleaned Patch Caches", "success");
						break;
					case "clean-builder":
						await trpcMutate("settings.cleanDockerBuilder", { serverId: sid });
						showToast("Cleaned Docker Builder", "success");
						break;
					case "clean-monitoring":
						await trpcMutate("settings.cleanMonitoring");
						showToast("Cleaned Monitoring", "success");
						break;
					case "clean-all":
						await trpcMutate("settings.cleanAll", { serverId: sid });
						showToast("Cleaning in progress... Please wait", "success");
						break;
					case "open-terminal":
						openTerminalDialog(sid || "local");
						break;
					case "open-logs":
						openLogsDialog(el.getAttribute("data-ws-logs-app") || "nearzero", sid, el.getAttribute("data-ws-logs-type") as "standalone" | "swarm" | null);
						break;
					case "open-update-ip":
						openDialog("nz-ws-update-ip-dialog");
						break;
					case "open-traefik-env":
						void openTraefikEnvDialog(sid);
						break;
					case "open-traefik-ports":
						void openTraefikPortsDialog(sid);
						break;
					case "open-gpu":
						openDialog("nz-ws-gpu-dialog");
						break;
					case "toggle-traefik-dashboard": {
						const enabled = el.getAttribute("data-traefik-dashboard") === "1";
						openTraefikDashboardConfirm(!enabled, sid);
						break;
					}
				}
			} catch (e) {
				showToast(e instanceof Error ? e.message : "Action failed", "error");
			}
		});
	});
}

export function bindDockerCleanupToggle(root: HTMLElement, serverId?: string) {
	const toggle = serverId
		? document.getElementById("nz-server-actions-docker-cleanup")
		: root.querySelector<HTMLInputElement>("[data-docker-cleanup-local]");
	if (!(toggle instanceof HTMLInputElement)) return;
	toggle.addEventListener("change", async () => {
		const checked = toggle.checked;
		try {
			await trpcMutate("settings.updateDockerCleanup", {
				enableDockerCleanup: checked,
				...(serverId ? { serverId } : {}),
			});
			showToast("Docker Cleanup updated", "success");
		} catch {
			showToast("Docker Cleanup Error", "error");
			toggle.checked = !checked;
		}
	});
}

let pendingTraefikDashboard: { enable: boolean; serverId?: string } | null = null;

function openTraefikDashboardConfirm(enable: boolean, serverId?: string) {
	pendingTraefikDashboard = { enable, serverId };
	openDialog("nz-ws-traefik-dashboard-dialog");
}

export function bindTraefikDashboardConfirm(root: HTMLElement) {
	document.getElementById("nz-ws-traefik-dashboard-cancel")?.addEventListener("click", () => {
		pendingTraefikDashboard = null;
		closeDialog("nz-ws-traefik-dashboard-dialog");
	});
	document.getElementById("nz-ws-traefik-dashboard-confirm")?.addEventListener("click", async () => {
		if (!pendingTraefikDashboard) return;
		const btn = document.getElementById("nz-ws-traefik-dashboard-confirm");
		if (btn instanceof HTMLButtonElement) btn.disabled = true;
		try {
			await executeWithHealthCheck(
				() =>
					trpcMutate("settings.toggleDashboard", {
						enableDashboard: pendingTraefikDashboard!.enable,
						serverId: pendingTraefikDashboard!.serverId,
					}),
				{
					initialDelay: 5000,
					successMessage: "Traefik dashboard updated successfully",
					onSuccess: () => window.location.reload(),
				},
			);
			closeDialog("nz-ws-traefik-dashboard-dialog");
		} catch (e) {
			showToast(e instanceof Error ? e.message : "Failed to toggle dashboard", "error");
		} finally {
			if (btn instanceof HTMLButtonElement) btn.disabled = false;
			pendingTraefikDashboard = null;
		}
	});
}

export function bindUpdateServerIpDialog() {
	const form = document.getElementById("nz-ws-update-ip-form");
	const ipInput = document.getElementById("nz-ws-update-ip-input");
	const submit = document.getElementById("nz-ws-update-ip-submit");
	if (!(form instanceof HTMLFormElement) || !(ipInput instanceof HTMLInputElement) || !(submit instanceof HTMLButtonElement)) return;

	document.getElementById("nz-ws-update-ip-use-public")?.addEventListener("click", async () => {
		try {
			const ip = await trpcQuery<string>("server.publicIp");
			if (ip) ipInput.value = ip;
		} catch {
			showToast("Could not fetch public IP", "error");
		}
	});

	form.addEventListener("submit", async (e) => {
		e.preventDefault();
		submit.disabled = true;
		try {
			await trpcMutate("settings.updateServerIp", { serverIp: ipInput.value });
			showToast("Server IP Updated", "success");
			closeDialog("nz-ws-update-ip-dialog");
			window.location.reload();
		} catch {
			showToast("Error updating the IP of the server", "error");
		} finally {
			submit.disabled = false;
		}
	});
}

export function bindPublicDomainDialog(root: HTMLElement) {
	const open = document.getElementById("nz-ws-domain-open");
	const form = document.getElementById("nz-ws-domain-form");
	const hostInput = document.getElementById("nz-ws-domain-host");
	const emailInput = document.getElementById("nz-ws-domain-email");
	const submit = document.getElementById("nz-ws-domain-submit");
	if (
		!(form instanceof HTMLFormElement) ||
		!(hostInput instanceof HTMLInputElement) ||
		!(emailInput instanceof HTMLInputElement) ||
		!(submit instanceof HTMLButtonElement)
	) {
		return;
	}

	open?.addEventListener("click", () => {
		hostInput.value = root.dataset.publicHost ?? "";
		emailInput.value = root.dataset.letsencryptEmail ?? "";
		openDialog("nz-ws-domain-dialog");
	});
	if (
		new URL(window.location.href).searchParams.get("setup") === "domain" &&
		open instanceof HTMLElement
	) {
		open.click();
	}

	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		if (!form.reportValidity()) return;
		submit.disabled = true;
		submit.setAttribute("aria-busy", "true");
		rememberDefaultLabel(submit);
		setButtonLoadingVisuals(submit, true);
		try {
			await trpcMutate("settings.assignDomainServer", {
				host: hostInput.value.trim().toLowerCase(),
				certificateType: "letsencrypt",
				letsEncryptEmail: emailInput.value.trim(),
				https: true,
			});
			closeDialog("nz-ws-domain-dialog");
			showToast(
				"Domain configured. DNS and HTTPS may take a few minutes to become ready.",
				"success",
			);
			window.setTimeout(() => window.location.reload(), 1200);
		} catch (error) {
			showToast(
				error instanceof Error ? error.message : "Could not configure the domain",
				"error",
			);
		} finally {
			submit.disabled = false;
			submit.removeAttribute("aria-busy");
			setButtonLoadingVisuals(submit, false);
		}
	});
}

let traefikEnvLocked = true;

export async function openTraefikEnvDialog(serverId?: string) {
	const textarea = document.getElementById("nz-ws-traefik-env-input");
	const lockBtn = document.getElementById("nz-ws-traefik-env-lock");
	if (!(textarea instanceof HTMLTextAreaElement)) return;
	traefikEnvLocked = true;
	textarea.readOnly = true;
	if (lockBtn) lockBtn.textContent = "Unlock";
	try {
		const env = await trpcQuery<string>("settings.readTraefikEnv", { serverId });
		textarea.value = env || "";
		openDialog("nz-ws-traefik-env-dialog");
	} catch {
		showToast("Could not load Traefik environment", "error");
	}
}

export function bindTraefikEnvDialog(root: HTMLElement) {
	const form = document.getElementById("nz-ws-traefik-env-form");
	const textarea = document.getElementById("nz-ws-traefik-env-input");
	const lockBtn = document.getElementById("nz-ws-traefik-env-lock");
	const submit = document.getElementById("nz-ws-traefik-env-submit");
	if (!(form instanceof HTMLFormElement) || !(textarea instanceof HTMLTextAreaElement) || !(submit instanceof HTMLButtonElement)) return;

	lockBtn?.addEventListener("click", () => {
		traefikEnvLocked = !traefikEnvLocked;
		textarea.readOnly = traefikEnvLocked;
		if (lockBtn) lockBtn.textContent = traefikEnvLocked ? "Unlock" : "Lock";
		submit.disabled = traefikEnvLocked;
	});

	form.addEventListener("submit", async (e) => {
		e.preventDefault();
		const serverId = root.dataset.serverId || undefined;
		submit.disabled = true;
		try {
			await executeWithHealthCheck(
				() => trpcMutate("settings.writeTraefikEnv", { env: textarea.value, serverId }),
				{ successMessage: "Traefik Env Updated" },
			);
			closeDialog("nz-ws-traefik-env-dialog");
		} catch {
			showToast("Error updating the Traefik env", "error");
		} finally {
			submit.disabled = traefikEnvLocked;
		}
	});
}

let traefikPorts: TraefikPort[] = [];

function renderTraefikPorts() {
	const container = document.getElementById("nz-ws-traefik-ports-rows");
	if (!container) return;
	if (traefikPorts.length === 0) {
		container.innerHTML = `<p class="text-sm text-muted-foreground text-center py-6">No port mappings configured</p>`;
		return;
	}
	container.innerHTML = traefikPorts
		.map(
			(p, i) => `
		<div class="grid grid-cols-4 gap-3 rounded-lg border p-3" data-port-row="${i}">
			<label class="text-xs font-medium text-muted-foreground">Target<input type="number" class="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm" data-port-target="${i}" value="${p.targetPort || ""}" /></label>
			<label class="text-xs font-medium text-muted-foreground">Published<input type="number" class="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm" data-port-published="${i}" value="${p.publishedPort || ""}" /></label>
			<label class="text-xs font-medium text-muted-foreground">Protocol
				<select class="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm" data-port-protocol="${i}">
					${(["tcp", "udp", "sctp"] as const).map((proto) => `<option value="${proto}" ${p.protocol === proto ? "selected" : ""}>${proto}</option>`).join("")}
				</select>
			</label>
			<div class="flex items-end"><button type="button" class="inline-flex h-9 w-9 items-center justify-center rounded-md hover:bg-accent" data-port-remove="${i}" aria-label="Remove">✕</button></div>
		</div>`,
		)
		.join("");

	container.querySelectorAll("[data-port-remove]").forEach((btn) => {
		btn.addEventListener("click", () => {
			const idx = Number(btn.getAttribute("data-port-remove"));
			traefikPorts.splice(idx, 1);
			renderTraefikPorts();
		});
	});
}

export async function openTraefikPortsDialog(serverId?: string) {
	try {
		const ports = await trpcQuery<TraefikPort[]>("settings.getTraefikPorts", { serverId });
		traefikPorts = (ports || []).map((p) => ({
			targetPort: p.targetPort,
			publishedPort: p.publishedPort,
			protocol: (p.protocol as TraefikPort["protocol"]) || "tcp",
		}));
		renderTraefikPorts();
		openDialog("nz-ws-traefik-ports-dialog");
		(document.getElementById("nz-ws-traefik-ports-dialog") as HTMLElement | null)?.setAttribute(
			"data-server-id",
			serverId || "",
		);
	} catch {
		showToast("Could not load Traefik ports", "error");
	}
}

export function bindTraefikPortsDialog(root: HTMLElement) {
	document.getElementById("nz-ws-traefik-ports-add")?.addEventListener("click", () => {
		traefikPorts.push({ targetPort: 0, publishedPort: 0, protocol: "tcp" });
		renderTraefikPorts();
	});

	document.getElementById("nz-ws-traefik-ports-form")?.addEventListener("submit", async (e) => {
		e.preventDefault();
		const dlg = document.getElementById("nz-ws-traefik-ports-dialog");
		const serverId = dlg?.getAttribute("data-server-id") || root.dataset.serverId || undefined;
		const rows = document.querySelectorAll("[data-port-row]");
		const ports: TraefikPort[] = [];
		rows.forEach((row) => {
			const i = row.getAttribute("data-port-row");
			if (i == null) return;
			const target = (row.querySelector(`[data-port-target="${i}"]`) as HTMLInputElement)?.value;
			const published = (row.querySelector(`[data-port-published="${i}"]`) as HTMLInputElement)?.value;
			const protocol = (row.querySelector(`[data-port-protocol="${i}"]`) as HTMLSelectElement)?.value;
			ports.push({
				targetPort: Number(target) || 0,
				publishedPort: Number(published) || 0,
				protocol: (protocol as TraefikPort["protocol"]) || "tcp",
			});
		});
		const submit = document.getElementById("nz-ws-traefik-ports-submit");
		if (submit instanceof HTMLButtonElement) submit.disabled = true;
		try {
			await executeWithHealthCheck(
				() => trpcMutate("settings.updateTraefikPorts", { serverId, additionalPorts: ports }),
				{
					successMessage: "Ports updated successfully",
					onSuccess: () => closeDialog("nz-ws-traefik-ports-dialog"),
				},
			);
		} catch (err) {
			showToast(err instanceof Error ? err.message : "Error updating Traefik ports", "error");
		} finally {
			if (submit instanceof HTMLButtonElement) submit.disabled = false;
		}
	});
}

let activeLogsServerId: string | undefined;
let activeLogsApp = "nearzero";

export async function openLogsDialog(
	appName: string,
	serverId?: string,
	type: "standalone" | "swarm" | null = "swarm",
) {
	activeLogsApp = appName;
	activeLogsServerId = serverId;
	const select = document.getElementById("nz-ws-logs-container");
	const output = document.getElementById("nz-ws-logs-output");
	if (!(select instanceof HTMLSelectElement) || !(output instanceof HTMLElement)) return;
	select.innerHTML = `<option value="">Loading...</option>`;
	output.textContent = "";
	openDialog("nz-ws-logs-dialog");
	try {
		const containers = await trpcQuery<
			Array<{ containerId: string; name: string; state: string }>
		>("docker.getContainersByAppLabel", { appName, serverId, type: type || "swarm" });
		select.innerHTML =
			containers.length === 0
				? `<option value="">No containers found</option>`
				: containers
						.map(
							(c) =>
								`<option value="${c.containerId}">${c.name} (${c.containerId}) — ${c.state}</option>`,
						)
						.join("");
		if (containers[0]) mountLogsContainer(containers[0].containerId);
	} catch {
		select.innerHTML = `<option value="">Failed to load containers</option>`;
	}
}

function mountLogsContainer(containerId: string) {
	const output = document.getElementById("nz-ws-logs-output");
	if (!(output instanceof HTMLElement) || !containerId) return;
	disconnectDockerLogs();
	mountDockerLogs(output, {
		containerId,
		serverId: activeLogsServerId,
		runType: "native",
	});
}

export function bindLogsDialog() {
	const select = document.getElementById("nz-ws-logs-container");
	select?.addEventListener("change", () => {
		if (select instanceof HTMLSelectElement && select.value) mountLogsContainer(select.value);
	});
	document.getElementById("nz-ws-logs-dialog")?.addEventListener("close", () => {
		disconnectDockerLogs();
	});
}

let activeTerminalServerId = "local";

function formatTerminalTabLabel(serverId: string) {
	if (serverId === "local") return "local";
	if (serverId.length <= 18) return serverId;
	return `${serverId.slice(0, 8)}…${serverId.slice(-4)}`;
}

function updateTerminalShellChrome(serverId: string, serverName = "") {
	const section = document.getElementById("nz-ws-terminal-crumb-section");
	const nameEl = document.getElementById("nz-ws-terminal-crumb-name");
	const tabLabel = document.getElementById("nz-ws-terminal-tab-label");
	const isLocal = serverId === "local";
	const displayName =
		serverName.trim() || (isLocal ? "local" : "server");

	if (section) section.textContent = isLocal ? "web server" : "servers";
	if (nameEl) nameEl.textContent = displayName;
	if (tabLabel) tabLabel.textContent = formatTerminalTabLabel(serverId);
}

export function openTerminalDialog(serverId: string, serverName = "") {
	activeTerminalServerId = serverId;
	updateTerminalShellChrome(serverId, serverName);
	const localCfg = document.getElementById("nz-ws-terminal-local-config");
	localCfg?.classList.toggle("hidden", serverId !== "local");
	openDialog("nz-ws-terminal-dialog");
	window.requestAnimationFrame(() => {
		window.requestAnimationFrame(() => {
			void mountTerminalInDialog();
		});
	});
}

async function mountTerminalInDialog() {
	const host = document.getElementById("nz-ws-terminal-host");
	if (!(host instanceof HTMLElement)) return;
	const { mountSshTerminal } = await import("@/scripts/xterm-terminal");
	await mountSshTerminal(host, activeTerminalServerId);
}

export function bindTerminalDialog() {
	document.getElementById("nz-ws-terminal-dialog")?.addEventListener("close", async () => {
		const { disconnectSshTerminal } = await import("@/scripts/xterm-terminal");
		disconnectSshTerminal();
	});

	document.getElementById("nz-ws-terminal-brand-link")?.addEventListener("click", () => {
		closeDialog("nz-ws-terminal-dialog");
	});

	const localForm = document.getElementById("nz-ws-terminal-local-form");
	localForm?.addEventListener("submit", async (e) => {
		e.preventDefault();
		const portEl = document.getElementById("nz-ws-terminal-local-port");
		const userEl = document.getElementById("nz-ws-terminal-local-user");
		if (!(portEl instanceof HTMLInputElement) || !(userEl instanceof HTMLInputElement)) return;
		const { saveLocalServerData } = await import("@/scripts/xterm-terminal");
		saveLocalServerData({
			port: Number(portEl.value) || 22,
			username: userEl.value || "root",
		});
		await mountTerminalInDialog();
	});
}

export function bindSharedDialogCloseButtons() {
	document.querySelectorAll("[data-close-dialog]").forEach((el) => {
		el.addEventListener("click", () => {
			const id = el.getAttribute("data-close-dialog");
			if (id) closeDialog(id);
		});
	});
}

export function bindCopyServerIp() {
	document.getElementById("nz-ws-copy-ip")?.addEventListener("click", () => {
		const ip = document.getElementById("nz-ws-server-ip")?.textContent?.trim();
		if (!ip) return;
		void navigator.clipboard.writeText(ip).then(() => showToast("Copied to clipboard", "success"));
	});
}
