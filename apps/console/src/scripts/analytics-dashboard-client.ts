import copy from "copy-to-clipboard";
import { format } from "date-fns";
import { badgeClassForHttpStatus } from "@/components/dashboard/analytics/logBadges";
import { trpcMutate } from "@/lib/client-api";
import { showToast } from "@/scripts/ui";

export type ReqLogRecord = Record<string, unknown>;

function formatDurationNanos(nanos: number) {
	const ms = nanos / 1000000;
	if (ms < 1) {
		return `${(nanos / 1000).toFixed(2)} µs`;
	}
	if (ms < 1000) {
		return `${ms.toFixed(2)} ms`;
	}
	return `${(ms / 1000).toFixed(2)} s`;
}

function escHtml(s: string) {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/"/g, "&quot;");
}

function formatDetailCell(key: string, value: unknown): string {
	if (typeof value === "object" && value !== null) {
		return escHtml(JSON.stringify(value, null, 2));
	}
	if (key === "Duration" || key === "OriginDuration" || key === "Overhead") {
		const nanos = Number(value);
		return escHtml(formatDurationNanos(Number.isFinite(nanos) ? nanos : 0));
	}
	if (key === "level") {
		return `<span class="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold border-transparent bg-secondary text-secondary-foreground">${escHtml(String(value))}</span>`;
	}
	if (key === "RequestMethod") {
		return `<span class="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold text-foreground">${escHtml(String(value))}</span>`;
	}
	if (key === "DownstreamStatus" || key === "OriginStatus") {
		const num = Number(value);
		if (num === 0) {
			return `<span class="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold border-transparent bg-secondary text-secondary-foreground">N/A</span>`;
		}
		return `<span class="${badgeClassForHttpStatus(num)}">${escHtml(String(value))}</span>`;
	}
	return escHtml(String(value ?? ""));
}

function pageSig(logs: ReqLogRecord[]): string {
	if (!logs.length) return "empty";
	const a = logs[0];
	const b = logs[logs.length - 1];
	return `${String(a?.StartUTC ?? "")}:${String(a?.RequestPath ?? "")}:${String(b?.StartUTC ?? "")}:${String(b?.RequestPath ?? "")}`;
}

export function bindAnalyticsDashboardActions(root: HTMLElement, pageLogs: ReqLogRecord[]) {
	type RootEx = HTMLElement & { __nzReqTeardown?: () => void };
	const r = root as RootEx;

	const activeFlag = root.dataset.isActive === "true" ? "1" : "0";
	const sig = `${activeFlag}:${pageLogs.length}:${pageSig(pageLogs)}`;
	// Always rebind after DOM swaps even when the inactive empty-state signature repeats.
	const prev = r.__nzReqTeardown;
	if (typeof prev === "function") prev();
	root.dataset.nzReqSig = sig;

	const ac = new AbortController();
	const opts = { signal: ac.signal };
	r.__nzReqTeardown = () => {
		ac.abort();
	};

	const dlg = root.querySelector<HTMLDialogElement>("#nz-req-detail");
	const dlgTable = root.querySelector<HTMLElement>("#nz-req-detail-table");

	let selected: ReqLogRecord | null = null;

	const renderDetail = (log: ReqLogRecord) => {
		selected = log;
		if (!(dlgTable && dlg)) return;
		dlgTable.innerHTML = `
			<table class="w-full caption-bottom text-sm">
				<tbody class="[&_tr:last-child]:border-0">
					${Object.entries(log)
						.map(([key, value]) => {
							const addr = key === "RequestAddr";
							const inner =
								addr && typeof value === "string"
									? `<div class="flex items-center gap-2 bg-muted p-1 rounded"><span>${escHtml(value)}</span><button type="button" class="nz-req-copy-addr inline-flex shrink-0"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-4 w-4 text-muted-foreground cursor-pointer"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg></button></div>`
									: formatDetailCell(key, value);
							return `<tr class="border-b transition-colors hover:bg-muted/50"><td class="p-4 align-middle font-medium">${escHtml(key)}</td><td class="p-4 align-middle truncate break-words break-before-all whitespace-pre-wrap">${inner}</td></tr>`;
						})
						.join("")}
				</tbody>
			</table>`;
		dlg.showModal();
	};

	dlgTable?.addEventListener(
		"click",
		(e) => {
			const t = e.target;
			if (!(t instanceof Element)) return;
			if (t.closest(".nz-req-copy-addr")) {
				e.stopPropagation();
				const v = selected?.RequestAddr;
				if (typeof v === "string") {
					copy(v);
					showToast("Copied to clipboard", "success");
				}
			}
		},
		opts,
	);

	root.addEventListener(
		"click",
		(e) => {
			const t = e.target;
			if (!(t instanceof Element)) return;
			const tr = t.closest("tr.nz-req-row");
			if (!(tr instanceof HTMLTableRowElement)) return;
			const idx = Number(tr.dataset.logIndex);
			const log = pageLogs[idx];
			if (log) renderDetail(log);
		},
		opts,
	);

	const dl = root.querySelector<HTMLButtonElement>("#nz-req-download-json");
	dl?.addEventListener(
		"click",
		() => {
			if (!selected) return;
			const logs = JSON.stringify(selected, null, 2);
			const element = document.createElement("a");
			element.setAttribute("href", `data:text/plain;charset=utf-8,${encodeURIComponent(logs)}`);
			element.setAttribute("download", "logs.json");
			element.style.display = "none";
			document.body.appendChild(element);
			element.click();
			document.body.removeChild(element);
		},
		opts,
	);

	const toggleBtn = root.querySelector<HTMLButtonElement>("#nz-req-toggle-open");
	const toggleDlg = root.querySelector<HTMLDialogElement>("#nz-req-toggle-dialog");
	const toggleConfirm = root.querySelector<HTMLButtonElement>("#nz-req-toggle-confirm");
	const active = root.dataset.isActive === "true";

	const runToggleRequests = async (enable: boolean) => {
		try {
			const ok = await trpcMutate<boolean>("settings.toggleRequests", { enable });
			if (!ok) {
				showToast(
					"Could not update Traefik access logging. Finish web-server / Traefik setup, then try again.",
					"error",
				);
				return false;
			}
			showToast(`Analytics ${enable ? "activated" : "deactivated"}`, "success");
			window.location.reload();
			return true;
		} catch (e) {
			showToast(e instanceof Error ? e.message : "Request failed", "error");
			return false;
		}
	};

	const openToggleDialog = () => {
		if (toggleDlg) {
			toggleDlg.showModal();
			return;
		}
		void runToggleRequests(!active);
	};

	root.addEventListener(
		"click",
		(e) => {
			const t = e.target;
			if (!(t instanceof Element)) return;
			if (!t.closest("[data-analytics-activate]")) return;
			e.preventDefault();
			openToggleDialog();
		},
		opts,
	);

	toggleBtn?.addEventListener("click", () => openToggleDialog(), opts);
	toggleConfirm?.addEventListener(
		"click",
		async () => {
			toggleConfirm.disabled = true;
			const ok = await runToggleRequests(!active);
			if (!ok) toggleConfirm.disabled = false;
		},
		opts,
	);

	const cronIn = root.querySelector<HTMLInputElement>("#nz-cron-input");
	const cronSave = root.querySelector<HTMLButtonElement>("#nz-cron-save");
	cronSave?.addEventListener(
		"click",
		async () => {
			const expr = cronIn?.value?.trim();
			if (!expr) {
				showToast("Please enter a valid cron expression", "error");
				return;
			}
			cronSave.disabled = true;
			try {
				await trpcMutate("settings.updateLogCleanup", { cronExpression: expr });
				showToast("Log cleanup schedule updated", "success");
			} catch (e) {
				showToast(
					`Failed to update log cleanup schedule: ${e instanceof Error ? e.message : "Unknown error"}`,
					"error",
				);
			} finally {
				cronSave.disabled = false;
			}
		},
		opts,
	);
}

export function formatLogTime(val: unknown) {
	try {
		if (typeof val === "string" || val instanceof Date) {
			return format(new Date(val), "yyyy-MM-dd HH:mm:ss");
		}
	} catch {
		/* ignore */
	}
	return "—";
}
