import { trpcQuery } from "@/lib/client-api";
import { format } from "date-fns";

const ACTION_LABELS: Record<string, string> = {
	create: "Created",
	update: "Updated",
	delete: "Deleted",
	deploy: "Deployed",
	cancel: "Cancelled",
	redeploy: "Redeployed",
	login: "Login",
	logout: "Logout",
};

const RESOURCE_LABELS: Record<string, string> = {
	project: "Project",
	service: "Service",
	environment: "Environment",
	deployment: "Deployment",
	user: "User",
	customRole: "Custom Role",
	domain: "Domain",
	certificate: "Certificate",
	registry: "Registry",
	server: "Server",
	sshKey: "SSH Key",
	gitProvider: "Git Provider",
	notification: "Notification",
	settings: "Settings",
	session: "Session",
};

type AuditLogRow = {
	createdAt: string;
	userEmail?: string | null;
	userRole?: string | null;
	action: string;
	resourceType: string;
	resourceName?: string | null;
	metadata?: string | null;
};

function parseMetadata(value: unknown) {
	if (!value || typeof value !== "string") return null;
	try {
		return JSON.parse(value) as { actorType?: string };
	} catch {
		return null;
	}
}

function actorLabel(log: AuditLogRow) {
	return parseMetadata(log.metadata)?.actorType === "agent"
		? "Agent"
		: (log.userEmail ?? "");
}

function roleLabel(log: AuditLogRow) {
	return parseMetadata(log.metadata)?.actorType === "agent"
		? "agent"
		: (log.userRole ?? "");
}

function setCell(row: HTMLTableRowElement, className: string, text: string) {
	const cell = document.createElement("td");
	cell.className = className;
	cell.textContent = text;
	row.appendChild(cell);
	return cell;
}

function renderRows(tbody: HTMLElement, logs: AuditLogRow[]) {
	tbody.replaceChildren();
	for (const log of logs) {
		const row = document.createElement("tr");
		row.className = "border-b";
		setCell(
			row,
			"p-3 text-xs text-muted-foreground whitespace-nowrap",
			format(new Date(log.createdAt), "MMM d, yyyy HH:mm"),
		);
		setCell(row, "p-3 text-xs", actorLabel(log));
		setCell(row, "p-3 text-xs", ACTION_LABELS[log.action] ?? log.action);
		setCell(
			row,
			"p-3 text-xs text-muted-foreground",
			RESOURCE_LABELS[log.resourceType] ?? log.resourceType,
		);
		setCell(row, "p-3 text-xs font-medium", log.resourceName ?? "-");
		setCell(
			row,
			"p-3 text-xs text-muted-foreground capitalize",
			roleLabel(log),
		);
		const metadataCell = setCell(row, "p-3 text-xs", "-");
		if (log.metadata) {
			metadataCell.textContent = "";
			const button = document.createElement("button");
			button.type = "button";
			button.className = "text-xs underline";
			button.dataset.metadata = log.metadata;
			button.textContent = "View";
			metadataCell.appendChild(button);
		}
		tbody.appendChild(row);
	}
}

export function bindAuditLogsPage() {
	const root = document.getElementById("nz-audit-logs-root");
	if (!root || root.dataset.bound === "1" || root.dataset.haveLicense !== "1") {
		return;
	}
	root.dataset.bound = "1";

	let pageIndex = 0;
	let debounceTimer = 0;

	const tbody = document.getElementById("nz-audit-tbody");
	const totalEl = document.getElementById("nz-audit-total");
	const metaDlg = document.getElementById("nz-audit-metadata-dialog");
	const metaBody = document.getElementById("nz-audit-metadata-body");

	const getFilters = () => {
		const searchEl = document.getElementById("nz-audit-search");
		const actionEl = document.getElementById("nz-audit-action");
		const resourceTypeEl = document.getElementById("nz-audit-resource-type");
		const pageSizeEl = document.getElementById("nz-audit-page-size");
		const pageSize = Number.parseInt(
			pageSizeEl instanceof HTMLSelectElement ? pageSizeEl.value : "50",
			10,
		);
		const search =
			searchEl instanceof HTMLInputElement
				? searchEl.value.trim() || undefined
				: undefined;
		return {
			search,
			action:
				actionEl instanceof HTMLSelectElement ? actionEl.value || undefined : undefined,
			resourceType:
				resourceTypeEl instanceof HTMLSelectElement
					? resourceTypeEl.value || undefined
					: undefined,
			limit: pageSize,
			offset: pageIndex * pageSize,
		};
	};

	const load = async () => {
		if (!(tbody instanceof HTMLElement)) return;
		tbody.innerHTML =
			'<tr><td colspan="7" class="p-6 text-center text-xs text-muted-foreground">Loading...</td></tr>';
		try {
			const data = await trpcQuery<{ logs?: AuditLogRow[]; total?: number }>(
				"auditLog.all",
				getFilters(),
			);
			const logs = data?.logs ?? [];
			const total = data?.total ?? 0;
			if (totalEl) totalEl.textContent = `${total} total`;
			if (logs.length === 0) {
				tbody.innerHTML =
					'<tr><td colspan="7" class="p-6 text-center text-xs text-muted-foreground">No audit logs found</td></tr>';
				return;
			}
			renderRows(tbody, logs);
		} catch {
			tbody.innerHTML =
				'<tr><td colspan="7" class="p-6 text-center text-xs text-destructive">Failed to load audit logs</td></tr>';
		}
	};

	const scheduleLoad = () => {
		window.clearTimeout(debounceTimer);
		debounceTimer = window.setTimeout(() => {
			pageIndex = 0;
			void load();
		}, 400);
	};

	document.getElementById("nz-audit-search")?.addEventListener("input", scheduleLoad);
	document.getElementById("nz-audit-action")?.addEventListener("change", () => {
		pageIndex = 0;
		void load();
	});
	document
		.getElementById("nz-audit-resource-type")
		?.addEventListener("change", () => {
			pageIndex = 0;
			void load();
		});
	document.getElementById("nz-audit-page-size")?.addEventListener("change", () => {
		pageIndex = 0;
		void load();
	});
	document.getElementById("nz-audit-prev")?.addEventListener("click", () => {
		if (pageIndex > 0) {
			pageIndex -= 1;
			void load();
		}
	});
	document.getElementById("nz-audit-next")?.addEventListener("click", () => {
		pageIndex += 1;
		void load();
	});

	root.addEventListener("click", (event) => {
		const button = (
			event.target instanceof Element ? event.target : null
		)?.closest("[data-metadata]");
		if (
			!(button instanceof HTMLElement) ||
			!button.dataset.metadata ||
			!(metaDlg instanceof HTMLDialogElement) ||
			!(metaBody instanceof HTMLElement)
		) {
			return;
		}
		try {
			metaBody.textContent = JSON.stringify(
				JSON.parse(button.dataset.metadata),
				null,
				2,
			);
		} catch {
			metaBody.textContent = button.dataset.metadata;
		}
		metaDlg.showModal();
	});

	metaDlg?.querySelector("[data-close-metadata]")?.addEventListener("click", () => {
		if (metaDlg instanceof HTMLDialogElement) metaDlg.close();
	});
}
