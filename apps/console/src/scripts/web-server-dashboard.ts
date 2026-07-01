import { trpcMutate, trpcQuery } from "@/lib/client-api";
import {
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
} from "@/scripts/web-server-shared";

type HealthResult = {
	postgres: { status: string; message?: string };
	redis: { status: string; message?: string };
	traefik: { status: string; message?: string };
};

type UpdateState = "idle" | "checking" | "results" | "updating";

let updateState: UpdateState = "idle";
let healthResult: HealthResult | null = null;

function renderUpdateDialog() {
	const title = document.getElementById("nz-ws-update-title");
	const body = document.getElementById("nz-ws-update-body");
	const footer = document.getElementById("nz-ws-update-footer");
	if (!title || !body || !footer) return;

	if (updateState === "idle") {
		title.textContent = "Web Server Update";
		body.innerHTML = `<p class="text-sm text-muted-foreground">Check for new releases and update Nearzero. We recommend checking for updates regularly.</p>`;
		footer.innerHTML = `
			<button type="button" class="inline-flex h-9 items-center rounded-md border px-4 text-sm" id="nz-ws-update-cancel">Cancel</button>
			<button type="button" class="inline-flex h-9 items-center rounded-md bg-secondary px-4 text-sm" id="nz-ws-update-check">Check for updates</button>`;
	} else if (updateState === "checking") {
		title.textContent = "Checking for updates…";
		body.innerHTML = `<p class="text-sm text-muted-foreground">Pulling latest version information…</p>`;
		footer.innerHTML = "";
	} else if (updateState === "updating") {
		title.textContent = "Server update in progress";
		body.innerHTML = `<p class="text-sm text-muted-foreground">The server is being updated, please wait…</p>`;
		footer.innerHTML = "";
	} else if (updateState === "results") {
		const root = document.getElementById("nz-web-server-root");
		const hasUpdate = root?.dataset.updateAvailable === "1";
		const latest = root?.dataset.latestVersion ?? "";
		if (hasUpdate && latest) {
			title.textContent = "Update available";
			body.innerHTML = `
				<div class="rounded-lg border border-emerald-900 bg-emerald-900/40 px-3 py-2 text-sm text-emerald-300 mb-4">New version available: <strong>${latest}</strong></div>
				<p class="text-sm text-muted-foreground">Review release notes before updating.</p>`;
			footer.innerHTML = `
				<button type="button" class="inline-flex h-9 items-center rounded-md border px-4 text-sm" id="nz-ws-update-cancel">Cancel</button>
				<button type="button" class="inline-flex h-9 items-center rounded-md bg-secondary px-4 text-sm" id="nz-ws-update-run">Update Server</button>`;
		} else {
			title.textContent = "You are using the latest version";
			body.innerHTML = `<p class="text-sm text-muted-foreground">Your server is up to date.</p>`;
			footer.innerHTML = `<button type="button" class="inline-flex h-9 items-center rounded-md border px-4 text-sm" id="nz-ws-update-cancel">Close</button>`;
		}
	}

	footer
		.querySelector("#nz-ws-update-cancel")
		?.addEventListener("click", () => {
			if (updateState !== "updating") closeDialog("nz-ws-update-dialog");
		});
	footer
		.querySelector("#nz-ws-update-check")
		?.addEventListener("click", () => void checkUpdates());
	footer
		.querySelector("#nz-ws-update-run")
		?.addEventListener("click", () => void openUpdateConfirm());
}

async function checkUpdates() {
	updateState = "checking";
	renderUpdateDialog();
	try {
		const data = await trpcMutate<{
			updateAvailable: boolean;
			latestVersion?: string;
		}>("settings.getUpdateData");
		const root = document.getElementById("nz-web-server-root");
		if (root) {
			root.dataset.updateAvailable = data.updateAvailable ? "1" : "0";
			root.dataset.latestVersion = data.latestVersion ?? "";
		}
		if (data.updateAvailable) {
			showToast(data.latestVersion ?? "Update available", "success");
		} else {
			showToast("No updates available", "default");
		}
	} catch {
		showToast("Error checking for updates", "error");
	} finally {
		updateState = "results";
		renderUpdateDialog();
	}
}

function renderUpdateConfirmDialog() {
	const body = document.getElementById("nz-ws-update-confirm-body");
	const title = document.getElementById("nz-ws-update-confirm-title");
	if (!body || !title) return;

	if (updateState === "idle") {
		title.textContent = "Are you absolutely sure?";
		body.innerHTML = `<p class="text-sm text-muted-foreground">This will update the web server. The page will reload when finished. Verify services before updating.</p>`;
	} else if (updateState === "checking") {
		title.textContent = "Verifying Services…";
		body.innerHTML = `<p class="text-sm text-muted-foreground">Checking PostgreSQL, Redis and Traefik…</p>`;
	} else if (updateState === "results") {
		const allHealthy =
			healthResult &&
			healthResult.postgres.status === "healthy" &&
			healthResult.redis.status === "healthy" &&
			healthResult.traefik.status === "healthy";
		title.textContent = allHealthy
			? "Ready to Update"
			: "Service Issues Detected";
		if (healthResult) {
			body.innerHTML = `
				<ul class="space-y-2 text-sm mb-3">
					<li>PostgreSQL: ${healthResult.postgres.status}${healthResult.postgres.message ? ` — ${healthResult.postgres.message}` : ""}</li>
					<li>Redis: ${healthResult.redis.status}${healthResult.redis.message ? ` — ${healthResult.redis.message}` : ""}</li>
					<li>Traefik: ${healthResult.traefik.status}${healthResult.traefik.message ? ` — ${healthResult.traefik.message}` : ""}</li>
				</ul>
				<p class="text-sm text-muted-foreground">${allHealthy ? "All services are running." : "Some services are not healthy. You can still proceed."}</p>`;
		} else {
			body.innerHTML = `<p class="text-sm text-yellow-700">Could not verify services. You can still proceed.</p>`;
		}
	} else if (updateState === "updating") {
		title.textContent = "Server update in progress";
		body.innerHTML = `<p class="text-sm text-muted-foreground">Please wait…</p>`;
	}
}

async function openUpdateConfirm() {
	updateState = "idle";
	healthResult = null;
	renderUpdateConfirmDialog();
	openDialog("nz-ws-update-confirm-dialog");
}

async function verifyServices() {
	updateState = "checking";
	renderUpdateConfirmDialog();
	try {
		healthResult = await trpcQuery<HealthResult>(
			"settings.checkInfrastructureHealth",
		);
	} catch {
		healthResult = null;
	}
	updateState = "results";
	renderUpdateConfirmDialog();
}

async function pollHealthReload() {
	try {
		const res = await fetch("/api/health");
		if (!res.ok) throw new Error("not ok");
		showToast("The server has been updated. Reloading…", "success");
		window.setTimeout(() => window.location.reload(), 2000);
	} catch {
		await new Promise((r) => window.setTimeout(r, 2000));
		await pollHealthReload();
	}
}

async function runUpdate() {
	updateState = "updating";
	renderUpdateConfirmDialog();
	try {
		await trpcMutate("settings.updateServer");
		await new Promise((r) => window.setTimeout(r, 8000));
		await pollHealthReload();
	} catch {
		updateState = "results";
		renderUpdateConfirmDialog();
		showToast("Error updating server", "error");
	}
}

function bindWebServerUpdateActions() {
	bindElementEventOnce(
		document.getElementById("nz-ws-update-open"),
		"wsUpdateOpenBound",
		"click",
		() => {
			updateState = "idle";
			renderUpdateDialog();
			openDialog("nz-ws-update-dialog");
		},
	);

	bindElementEventOnce(
		document.getElementById("nz-ws-update-confirm-verify"),
		"wsUpdateVerifyBound",
		"click",
		() => void verifyServices(),
	);
	bindElementEventOnce(
		document.getElementById("nz-ws-update-confirm-run"),
		"wsUpdateRunBound",
		"click",
		() => void runUpdate(),
	);
	bindElementEventOnce(
		document.getElementById("nz-ws-update-confirm-cancel"),
		"wsUpdateCancelBound",
		"click",
		() => {
			if (updateState !== "updating")
				closeDialog("nz-ws-update-confirm-dialog");
		},
	);

	const autoToggle = document.getElementById("nz-ws-auto-check-updates");
	if (autoToggle instanceof HTMLInputElement) {
		autoToggle.checked =
			localStorage.getItem("enableAutoCheckUpdates") === "true";
		bindElementEventOnce(
			autoToggle,
			"wsAutoCheckUpdatesBound",
			"change",
			() => {
				localStorage.setItem(
					"enableAutoCheckUpdates",
					String(autoToggle.checked),
				);
			},
		);
	}
}

export function bindWebServerDashboard() {
	const root = document.getElementById("nz-web-server-root");
	if (!root) return;
	bindWebServerUpdateActions();
	if (root.dataset.bound === "1") return;
	root.dataset.bound = "1";

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
}

bindWebServerDashboard();
document.addEventListener("astro:page-load", bindWebServerDashboard);
document.addEventListener("astro:after-swap", bindWebServerDashboard);
