import { setButtonLoadingVisuals } from "@/lib/auth-button-state";
import { trpcMutate } from "@/lib/client-api";
import { bindDropdownEl, closeDialog, openDialog, showToast } from "@/scripts/ui";

type ServiceKind =
	| "application"
	| "compose"
	| "postgres"
	| "mysql"
	| "mongo"
	| "redis"
	| "mariadb"
	| "libsql";

const DELETE_BY_KIND: Record<
	ServiceKind,
	{ procedure: string; idField: string; extraInput?: Record<string, unknown> }
> = {
	application: { procedure: "application.delete", idField: "applicationId" },
	compose: {
		procedure: "compose.delete",
		idField: "composeId",
		extraInput: { deleteVolumes: true },
	},
	postgres: { procedure: "postgres.remove", idField: "postgresId" },
	mysql: { procedure: "mysql.remove", idField: "mysqlId" },
	mongo: { procedure: "mongo.remove", idField: "mongoId" },
	redis: { procedure: "redis.remove", idField: "redisId" },
	mariadb: { procedure: "mariadb.remove", idField: "mariadbId" },
	libsql: { procedure: "libsql.remove", idField: "libsqlId" },
};

function escapeHtml(value: string) {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function highlightServiceName(name: string) {
	return `<span class="font-semibold text-foreground">${escapeHtml(name)}</span>`;
}

let deleteServiceKind: ServiceKind | null = null;
let deleteServiceId: string | null = null;
let deleteServiceName = "";
let deleteServiceRedirectHref: string | null = null;
let deleteServiceModalBound = false;

function setDeleteServiceBusy(busy: boolean) {
	const actionBtn = document.getElementById(
		"delete-service-confirm",
	) as HTMLButtonElement | null;
	const cancelBtn = document.querySelector<HTMLButtonElement>(
		"#delete-service-dialog [data-nz-modal-close]",
	);
	const input = document.getElementById(
		"delete-service-input",
	) as HTMLInputElement | null;

	if (actionBtn) {
		actionBtn.disabled = busy;
		actionBtn.setAttribute("aria-busy", busy ? "true" : "false");
		setButtonLoadingVisuals(actionBtn, busy);
	}
	if (cancelBtn) cancelBtn.disabled = busy;
	if (input) input.disabled = busy;

	if (!busy) syncDeleteServiceConfirm();
}

function syncDeleteServiceConfirm() {
	const input = document.getElementById(
		"delete-service-input",
	) as HTMLInputElement | null;
	const actionBtn = document.getElementById(
		"delete-service-confirm",
	) as HTMLButtonElement | null;
	if (actionBtn?.getAttribute("aria-busy") === "true") return;
	const nameMatches = input?.value.trim() === deleteServiceName;
	if (actionBtn) actionBtn.disabled = !nameMatches;
}

export function openDeleteServiceDialog(
	kind: ServiceKind,
	serviceId: string,
	serviceName: string,
	redirectHref?: string | null,
) {
	deleteServiceKind = kind;
	deleteServiceId = serviceId;
	deleteServiceName = serviceName;
	// When deleting from the service's own detail page, reloading the current
	// URL 404s ("Application not found"). Callers pass where to go instead.
	deleteServiceRedirectHref = redirectHref?.trim() || null;

	const confirmText = document.getElementById("delete-service-confirm-text");
	const inputLabel = document.getElementById("delete-service-input-label");
	const input = document.getElementById(
		"delete-service-input",
	) as HTMLInputElement | null;

	if (confirmText) {
		confirmText.innerHTML = `Are you sure you want to delete ${highlightServiceName(serviceName)}? Nearzero will remove the service, its Docker image, and its data volumes when Docker allows it.`;
	}
	if (inputLabel) {
		inputLabel.innerHTML = highlightServiceName(serviceName);
	}
	if (input) {
		input.value = "";
		input.placeholder = serviceName;
		input.disabled = false;
	}

	setDeleteServiceBusy(false);
	openDialog("delete-service-dialog");
}

export function bindDeleteServiceModal() {
	if (deleteServiceModalBound) return;
	deleteServiceModalBound = true;

	// Use document-level delegation so the handlers survive Astro view-transition
	// DOM swaps (the dialog lives in the layout and its nodes get replaced on
	// navigation; direct listeners would be lost and typing the name would no
	// longer re-enable the Delete button).
	document.addEventListener("input", (event) => {
		const target = event.target;
		if (target instanceof HTMLElement && target.id === "delete-service-input") {
			syncDeleteServiceConfirm();
		}
	});

	document.addEventListener("click", async (event) => {
		const target = event.target;
		if (!(target instanceof Element)) return;
		const confirmBtn = target.closest("#delete-service-confirm");
		if (!confirmBtn) return;

		if (!deleteServiceKind || !deleteServiceId) return;
		const input = document.getElementById(
			"delete-service-input",
		) as HTMLInputElement | null;
		if (input?.value.trim() !== deleteServiceName) return;

		const route = DELETE_BY_KIND[deleteServiceKind];
		if (!route) return;

		const actionBtn = document.getElementById(
			"delete-service-confirm",
		) as HTMLButtonElement | null;
		if (actionBtn?.getAttribute("aria-busy") === "true") return;

		setDeleteServiceBusy(true);
		let keepLocked = false;

		try {
			await trpcMutate(route.procedure, {
				[route.idField]: deleteServiceId,
				...(route.extraInput ?? {}),
			});
			keepLocked = true;
			showToast("Service removed", "success");
			closeDialog("delete-service-dialog");
			if (deleteServiceRedirectHref) {
				window.location.assign(deleteServiceRedirectHref);
			} else {
				window.location.reload();
			}
		} catch (err) {
			showToast(
				err instanceof Error ? err.message : "Error removing service",
				"error",
			);
		} finally {
			if (!keepLocked) setDeleteServiceBusy(false);
		}
	});
}

function openManageDomainDialog(kind: "application" | "compose", serviceId: string) {
	openDialog("nz-env-domain-dialog");
	const form = document.getElementById("nz-env-domain-form");
	if (form instanceof HTMLFormElement) {
		form.reset();
	}
	const serviceSelect = document.getElementById(
		"nz-env-domain-service",
	) as HTMLSelectElement | null;
	const value = `${kind}:${serviceId}`;
	if (serviceSelect) {
		const hasOption = [...serviceSelect.options].some(
			(option) => option.value === value,
		);
		if (hasOption) serviceSelect.value = value;
	}
	const portInput = document.getElementById(
		"nz-env-domain-port",
	) as HTMLInputElement | null;
	const pathInput = document.getElementById(
		"nz-env-domain-path",
	) as HTMLInputElement | null;
	const httpsInput = document.getElementById(
		"nz-env-domain-https",
	) as HTMLInputElement | null;
	const certSelect = document.getElementById(
		"nz-env-domain-certificate",
	) as HTMLSelectElement | null;
	if (portInput) portInput.value = "3000";
	if (pathInput) pathInput.value = "/";
	if (httpsInput) httpsInput.checked = true;
	if (certSelect) certSelect.value = "letsencrypt";
	const errEl = document.getElementById("nz-env-domain-error");
	if (errEl instanceof HTMLElement) {
		errEl.textContent = "";
		errEl.classList.add("hidden");
	}
}

type ServiceRow = HTMLElement & { _nzRowNavAbort?: AbortController };

function bindProjectServiceRowNav(row: ServiceRow) {
	row._nzRowNavAbort?.abort();
	const ac = new AbortController();
	row._nzRowNavAbort = ac;
	row.classList.add("nz-project-service-item--clickable");

	row.addEventListener(
		"click",
		(e) => {
			const target = e.target;
			if (!(target instanceof Element)) return;
			if (
				target.closest(
					"[data-nz-row-action], [data-svc-menu-trigger], [data-svc-menu], [data-svc-remove], [data-svc-open], .nz-project-service-item__link",
				)
			) {
				return;
			}
			const href = row.dataset.serviceHref?.trim();
			if (href) window.location.assign(href);
		},
		{ signal: ac.signal },
	);
}

let projectServiceActionsBound = false;

function bindProjectServiceActionsDelegated() {
	if (projectServiceActionsBound) return;
	projectServiceActionsBound = true;

	document.addEventListener("click", (event) => {
		const target = event.target;
		if (!(target instanceof Element)) return;

		const removeBtn = target.closest<HTMLButtonElement>("[data-svc-remove]");
		if (removeBtn) {
			if (removeBtn.disabled) return;
			const row = removeBtn.closest<HTMLElement>("[data-service-row]");
			if (!row) return;
			const inProjectServices = row.closest(".nz-project-services");
			const inEnvironment = row.closest("#nz-environment-root");
			if (!inProjectServices && !inEnvironment) return;
			event.stopPropagation();
			const kind = row.dataset.serviceKind as ServiceKind | undefined;
			const serviceId = row.dataset.serviceId?.trim() ?? "";
			const serviceName = row.dataset.serviceName?.trim() ?? "this service";
			if (kind && serviceId) {
				openDeleteServiceDialog(kind, serviceId, serviceName);
			}
		}
	});
}

export function bindServiceRowActions(scope: ParentNode) {
	bindDeleteServiceModal();
	bindProjectServiceActionsDelegated();

	for (const row of scope.querySelectorAll<ServiceRow>("[data-service-row]")) {
		const kind = row.dataset.serviceKind as ServiceKind | undefined;
		const serviceId = row.dataset.serviceId?.trim() ?? "";

		const trigger = row.querySelector<HTMLButtonElement>(
			"[data-svc-menu-trigger]",
		);
		const menu = row.querySelector<HTMLElement>("[data-svc-menu]");
		if (trigger && menu) {
			delete trigger.dataset.nzDropdownBound;
			bindDropdownEl(trigger, menu);
		}

		if (row.closest(".nz-project-services")) {
			bindProjectServiceRowNav(row);
		}

		if (!kind || !serviceId) continue;

		const manageBtn = row.querySelector<HTMLButtonElement>(
			"[data-svc-manage-domain]",
		);
		if (manageBtn && manageBtn.dataset.nzManageBound !== "1") {
			manageBtn.dataset.nzManageBound = "1";
			manageBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				if (kind !== "application" && kind !== "compose") return;
				openManageDomainDialog(kind, serviceId);
			});
		}
	}
}

export function bindEnvironmentServicesTable() {
	const root = document.getElementById("nz-environment-root");
	if (!root) return;
	delete root.dataset.nzEnvServicesBound;
	bindServiceRowActions(root);
}

export function bindProjectServicesList() {
	const run = () => {
		const roots = document.querySelectorAll(
			"#nz-project-services-list, .nz-project-services[data-project-services]",
		);
		for (const root of roots) {
			if (!(root instanceof HTMLElement)) continue;
			bindServiceRowActions(root);
		}
	};

	requestAnimationFrame(() => {
		requestAnimationFrame(run);
	});
}

function boot() {
	bindEnvironmentServicesTable();
	bindProjectServicesList();
}

boot();
document.addEventListener("astro:page-load", boot);
document.addEventListener("astro:after-swap", boot);
