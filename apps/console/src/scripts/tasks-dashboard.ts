import { setButtonLoadingVisuals } from "@/lib/auth-button-state";
import { trpcMutate, trpcQuery } from "@/lib/client-api";
import { closeDialog, openDialog, showToast } from "@/scripts/ui";

const CRON_PRESETS = [
	{ label: "Every minute", value: "* * * * *" },
	{ label: "Every hour", value: "0 * * * *" },
	{ label: "Every day at midnight", value: "0 0 * * *" },
	{ label: "Every Sunday at midnight", value: "0 0 * * 0" },
	{ label: "Every month on the 1st at midnight", value: "0 0 1 * *" },
	{ label: "Every 15 minutes", value: "*/15 * * * *" },
	{ label: "Every weekday at midnight", value: "0 0 * * 1-5" },
	{ label: "Custom", value: "custom" },
] as const;

export function bindTasksFilters() {
	const form = document.getElementById("nz-tasks-filter-form");
	const search = document.getElementById("nz-tasks-search");
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

function setSubmitLabel(button: HTMLButtonElement, label: string) {
	const labelEl = button.querySelector<HTMLElement>("[data-auth-btn-label]");
	if (labelEl) labelEl.textContent = label;
	else button.textContent = label;
	button.dataset.defaultLabel = label;
}

function setTaskFormBusy(els: TaskFormElements, busy: boolean) {
	const cancel = document.querySelector(
		"#nz-task-form-dialog [data-nz-modal-close]",
	);
	els.formSubmit.disabled = busy;
	els.formSubmit.setAttribute("aria-busy", busy ? "true" : "false");
	setButtonLoadingVisuals(els.formSubmit, busy);
	if (cancel instanceof HTMLButtonElement) cancel.disabled = busy;
	for (const el of [
		els.nameEl,
		els.descEl,
		els.cronPreset,
		els.cronEl,
		els.tzEl,
		els.scriptEl,
		els.enabledEl,
	]) {
		el.disabled = busy;
	}
}

type TaskFormElements = {
	formId: HTMLInputElement;
	formTitle: HTMLElement;
	formSubmit: HTMLButtonElement;
	formError: HTMLElement;
	nameEl: HTMLInputElement;
	descEl: HTMLInputElement;
	cronPreset: HTMLSelectElement;
	cronEl: HTMLInputElement;
	tzEl: HTMLInputElement;
	scriptEl: HTMLTextAreaElement;
	enabledEl: HTMLInputElement;
	deleteDesc: HTMLElement;
	deleteConfirm: HTMLButtonElement;
	deleteCancel: HTMLElement | null;
};

function getFormElements(): TaskFormElements | null {
	const formId = document.getElementById("nz-task-form-id");
	const formTitle =
		document.getElementById("nz-task-form-title") ??
		document.getElementById("nz-task-form-dialog-title");
	const formSubmit = document.getElementById("nz-task-form-submit");
	const formError = document.getElementById("nz-task-form-error");
	const nameEl = document.getElementById("nz-task-name");
	const descEl = document.getElementById("nz-task-description");
	const cronPreset = document.getElementById("nz-task-cron-preset");
	const cronEl = document.getElementById("nz-task-cron");
	const tzEl = document.getElementById("nz-task-timezone");
	const scriptEl = document.getElementById("nz-task-script");
	const enabledEl = document.getElementById("nz-task-enabled");
	const deleteDesc = document.getElementById("nz-task-delete-desc");
	const deleteConfirm = document.getElementById("nz-task-delete-confirm");
	const deleteCancel = document.getElementById("nz-task-delete-cancel");

	if (
		!(formId instanceof HTMLInputElement) ||
		!(formTitle instanceof HTMLElement) ||
		!(formSubmit instanceof HTMLButtonElement) ||
		!(formError instanceof HTMLElement) ||
		!(nameEl instanceof HTMLInputElement) ||
		!(descEl instanceof HTMLInputElement) ||
		!(cronPreset instanceof HTMLSelectElement) ||
		!(cronEl instanceof HTMLInputElement) ||
		!(tzEl instanceof HTMLInputElement) ||
		!(scriptEl instanceof HTMLTextAreaElement) ||
		!(enabledEl instanceof HTMLInputElement) ||
		!(deleteDesc instanceof HTMLElement) ||
		!(deleteConfirm instanceof HTMLButtonElement)
	) {
		return null;
	}

	return {
		formId,
		formTitle,
		formSubmit,
		formError,
		nameEl,
		descEl,
		cronPreset,
		cronEl,
		tzEl,
		scriptEl,
		enabledEl,
		deleteDesc,
		deleteConfirm,
		deleteCancel: deleteCancel instanceof HTMLElement ? deleteCancel : null,
	};
}

export function mountTasksDashboard() {
	const root = document.getElementById("nz-tasks-root");
	if (!root || root.dataset.bound === "1") return;

	const userId = root.dataset.userId?.trim() ?? "";
	const scheduleType = root.dataset.scheduleType ?? "nearzero-server";
	if (!userId) return;

	const form = document.getElementById("nz-task-form");
	if (!(form instanceof HTMLFormElement)) return;

	const els = getFormElements();
	if (!els) return;

	root.dataset.bound = "1";
	bindTasksFilters();

	let pendingDeleteId = "";
	const running = new Set();

	const resetForm = () => {
		els.formId.value = "";
		els.nameEl.value = "";
		els.descEl.value = "";
		els.cronPreset.value = "";
		els.cronEl.value = "";
		els.tzEl.value = "";
		els.scriptEl.value = "";
		els.enabledEl.checked = true;
		els.formTitle.textContent = "Create task";
		setSubmitLabel(els.formSubmit, "Create task");
		els.formError.classList.add("hidden");
	};

	const openCreate = () => {
		resetForm();
		openDialog("nz-task-form-dialog");
	};

	const openEdit = async (scheduleId: string) => {
		els.formError.classList.add("hidden");
		els.formId.value = scheduleId;
		els.formTitle.textContent = "Edit task";
		setSubmitLabel(els.formSubmit, "Update task");
		try {
			const schedule = await trpcQuery<any>("schedule.one", { scheduleId });
			els.nameEl.value = schedule.name ?? "";
			els.descEl.value = schedule.description ?? "";
			els.cronEl.value = schedule.cronExpression ?? "";
			els.tzEl.value = schedule.timezone ?? "";
			els.scriptEl.value = schedule.script ?? "";
			els.enabledEl.checked = Boolean(schedule.enabled);
			openDialog("nz-task-form-dialog");
		} catch (err) {
			showToast(err instanceof Error ? err.message : "Failed to load task", "error");
		}
	};

	els.cronPreset.addEventListener("change", () => {
		const v = els.cronPreset.value;
		if (v && v !== "custom") els.cronEl.value = v;
	});

	els.cronEl.addEventListener("input", () => {
		const v = els.cronEl.value.trim();
		const match = CRON_PRESETS.find((e) => e.value === v);
		els.cronPreset.value = match ? match.value : v ? "custom" : "";
	});

	root.addEventListener("click", (e) => {
		const target = e.target instanceof Element ? e.target : null;
		if (!target) return;

		if (target.closest("[data-task-create], #nz-task-create-open")) {
			e.preventDefault();
			openCreate();
			return;
		}

		if (target.closest("[data-close-task-form]")) {
			closeDialog("nz-task-form-dialog");
		}
	});

	for (const btn of document.querySelectorAll<HTMLButtonElement>("[data-task-run]")) {
		if (btn.dataset.bound === "1") continue;
		btn.dataset.bound = "1";
		btn.addEventListener("click", () => {
			const id = btn.dataset.taskRun;
			if (!id || running.has(id)) return;
			running.add(id);
			btn.disabled = true;
			void trpcMutate("schedule.runManually", { scheduleId: id })
				.then(() => {
					showToast("Task started", "success");
					window.location.reload();
				})
				.catch(() => showToast("Error running task", "error"))
				.finally(() => {
					running.delete(id);
					btn.disabled = false;
				});
		});
	}

	for (const btn of document.querySelectorAll<HTMLButtonElement>("[data-task-edit]")) {
		if (btn.dataset.bound === "1") continue;
		btn.dataset.bound = "1";
		btn.addEventListener("click", () => {
			const id = btn.dataset.taskEdit;
			if (id) void openEdit(id);
		});
	}

	for (const btn of document.querySelectorAll<HTMLButtonElement>("[data-task-delete]")) {
		if (btn.dataset.bound === "1") continue;
		btn.dataset.bound = "1";
		btn.addEventListener("click", () => {
			const id = btn.dataset.taskDelete;
			if (!id) return;
			pendingDeleteId = id;
			els.deleteDesc.textContent = `Delete "${btn.dataset.taskName ?? "this task"}"?`;
			openDialog("nz-task-delete-dialog");
		});
	}

	for (const btn of document.querySelectorAll<HTMLButtonElement>("[data-task-history]")) {
		if (btn.dataset.bound === "1") continue;
		btn.dataset.bound = "1";
		btn.addEventListener("click", () => {
			const id = btn.dataset.taskHistory;
			if (id) {
				window.location.href = `/dashboard/deployments?q=${encodeURIComponent(id)}`;
			}
		});
	}

	form.addEventListener("submit", async (e) => {
		e.preventDefault();
		els.formError.classList.add("hidden");
		setTaskFormBusy(els, true);
		const scheduleId = els.formId.value.trim();
		const payload = {
			name: els.nameEl.value.trim(),
			description: els.descEl.value.trim() || undefined,
			cronExpression: els.cronEl.value.trim(),
			shellType: "bash",
			command: "",
			enabled: els.enabledEl.checked,
			serviceName: "",
			scheduleType,
			script: els.scriptEl.value,
			timezone: els.tzEl.value.trim() || undefined,
			scheduleId: scheduleId || "",
			userId,
		};
		try {
			if (scheduleId) {
				await trpcMutate("schedule.update", payload);
				showToast("Task updated", "success");
			} else {
				await trpcMutate("schedule.create", payload);
				showToast("Task created", "success");
			}
			closeDialog("nz-task-form-dialog");
			window.location.reload();
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Request failed";
			els.formError.textContent = msg;
			els.formError.classList.remove("hidden");
			showToast(msg, "error");
		} finally {
			setTaskFormBusy(els, false);
		}
	});

	els.deleteConfirm.addEventListener("click", async () => {
		if (!pendingDeleteId) return;
		els.deleteConfirm.disabled = true;
		try {
			await trpcMutate("schedule.delete", { scheduleId: pendingDeleteId });
			showToast("Task deleted", "success");
			closeDialog("nz-task-delete-dialog");
			window.location.reload();
		} catch {
			showToast("Error deleting task", "error");
		} finally {
			els.deleteConfirm.disabled = false;
			pendingDeleteId = "";
		}
	});

	els.deleteCancel?.addEventListener("click", () => {
		pendingDeleteId = "";
		closeDialog("nz-task-delete-dialog");
	});
}
