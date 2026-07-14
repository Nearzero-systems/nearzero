import { trpcMutate, trpcQuery } from "@/lib/client-api";
import { closeDialog, openDialog, showToast } from "@/scripts/ui";

export function openCertificateCreateDialog() {
	const root = document.getElementById("nz-certificates-root");
	if (!root || root.dataset.bound !== "1") {
		openDialog("nz-cert-form-dialog");
		return;
	}
	const formDlg = document.getElementById("nz-cert-form-dialog");
	const formId = document.getElementById("nz-cert-form-id");
	const formSubmit = document.getElementById("nz-cert-form-submit");
	const formError = document.getElementById("nz-cert-form-error");
	const nameEl = document.getElementById("nz-cert-name");
	const dataEl = document.getElementById("nz-cert-data");
	const privateEl = document.getElementById("nz-cert-private");
	const serverRow = document.getElementById("nz-cert-server-row");
	const serverEl = document.getElementById("nz-cert-server");
	if (
		!(formId instanceof HTMLInputElement) ||
		!(formSubmit instanceof HTMLButtonElement) ||
		!(formError instanceof HTMLElement) ||
		!(nameEl instanceof HTMLInputElement) ||
		!(dataEl instanceof HTMLTextAreaElement) ||
		!(privateEl instanceof HTMLTextAreaElement) ||
		!(serverRow instanceof HTMLElement)
	) {
		openDialog("nz-cert-form-dialog");
		return;
	}
	const formTitle = formDlg?.querySelector(".nz-modal__title");
	const showServerOnCreate = root.dataset.showServerOnCreate === "1";
	formId.value = "";
	nameEl.value = "";
	dataEl.value = "";
	privateEl.value = "";
	privateEl.required = true;
	privateEl.placeholder = "-----BEGIN PRIVATE KEY-----";
	if (serverEl instanceof HTMLSelectElement) serverEl.value = "nearzero";
	formError.classList.add("hidden");
	formError.textContent = "";
	if (formTitle) formTitle.textContent = "Upload certificate";
	formSubmit.textContent = "Create";
	serverRow.classList.toggle("hidden", !showServerOnCreate);
	openDialog("nz-cert-form-dialog");
}

export function initCertificatesPanel() {
	const root = document.getElementById("nz-certificates-root");
	if (!root || root.dataset.bound === "1") return;
	root.dataset.bound = "1";

	const showServerOnCreate = root.dataset.showServerOnCreate === "1";
	const formDlg = document.getElementById("nz-cert-form-dialog");
	const deleteDlg = document.getElementById("nz-cert-delete-dialog");
	const form = document.getElementById("nz-cert-form");
	const formId = document.getElementById("nz-cert-form-id");
	const formSubmit = document.getElementById("nz-cert-form-submit");
	const formError = document.getElementById("nz-cert-form-error");
	const nameEl = document.getElementById("nz-cert-name");
	const dataEl = document.getElementById("nz-cert-data");
	const privateEl = document.getElementById("nz-cert-private");
	const serverRow = document.getElementById("nz-cert-server-row");
	const serverEl = document.getElementById("nz-cert-server");
	const deleteConfirm = document.getElementById("nz-cert-delete-confirm");

	if (
		!(formDlg instanceof HTMLDialogElement) ||
		!(deleteDlg instanceof HTMLDialogElement) ||
		!(form instanceof HTMLFormElement) ||
		!(formId instanceof HTMLInputElement) ||
		!(formSubmit instanceof HTMLButtonElement) ||
		!(formError instanceof HTMLElement) ||
		!(nameEl instanceof HTMLInputElement) ||
		!(dataEl instanceof HTMLTextAreaElement) ||
		!(privateEl instanceof HTMLTextAreaElement) ||
		!(serverRow instanceof HTMLElement) ||
		!(deleteConfirm instanceof HTMLButtonElement)
	) {
		return;
	}

	const formTitle = formDlg.querySelector(".nz-modal__title");

	let pendingDeleteId = "";

	root.querySelectorAll("[data-cert-toggle]").forEach((btn) => {
		btn.addEventListener("click", () => {
			const id = btn.getAttribute("data-cert-toggle");
			const details = root.querySelector(`[data-cert-chain="${id}"]`);
			if (!(details instanceof HTMLElement)) return;
			const expanded = !details.classList.contains("hidden");
			details.classList.toggle("hidden", expanded);
			details.classList.toggle("flex", !expanded);
			btn.setAttribute("aria-expanded", expanded ? "false" : "true");
			const chevron = btn.querySelector(".nz-cert-chevron");
			if (chevron instanceof SVGElement) {
				chevron.style.transform = expanded ? "" : "rotate(90deg)";
			}
		});
	});

	const resetForm = () => {
		formId.value = "";
		nameEl.value = "";
		dataEl.value = "";
		privateEl.value = "";
		privateEl.required = true;
		privateEl.placeholder = "-----BEGIN PRIVATE KEY-----";
		if (serverEl instanceof HTMLSelectElement) {
			serverEl.value = "nearzero";
		}
		formError.classList.add("hidden");
		formError.textContent = "";
		if (formTitle) formTitle.textContent = "Upload certificate";
		formSubmit.textContent = "Create";
		serverRow.classList.toggle("hidden", !showServerOnCreate);
	};

	const openEdit = async (certificateId: string) => {
		resetForm();
		formId.value = certificateId;
		if (formTitle) formTitle.textContent = "Update certificate";
		formSubmit.textContent = "Update";
		serverRow.classList.add("hidden");
		privateEl.required = false;
		privateEl.placeholder = "Leave blank to keep the stored private key";
		try {
			const cert = await trpcQuery<{
				name?: string;
				certificateData?: string;
			}>("certificates.one", { certificateId });
			nameEl.value = cert.name || "";
			dataEl.value = cert.certificateData || "";
			privateEl.value = "";
			openDialog("nz-cert-form-dialog");
		} catch {
			showToast("Could not load certificate", "error");
		}
	};

	root.querySelectorAll("[data-cert-edit]").forEach((el) => {
		el.addEventListener("click", () => {
			const id = el.getAttribute("data-cert-edit");
			if (id) void openEdit(id);
		});
	});

	root.querySelectorAll("[data-cert-delete]").forEach((el) => {
		el.addEventListener("click", () => {
			pendingDeleteId = el.getAttribute("data-cert-delete") || "";
			openDialog("nz-cert-delete-dialog");
		});
	});

	document.getElementById("nz-cert-delete-cancel")?.addEventListener("click", () =>
		closeDialog("nz-cert-delete-dialog"),
	);

	deleteConfirm.addEventListener("click", async () => {
		if (!pendingDeleteId) return;
		deleteConfirm.disabled = true;
		try {
			await trpcMutate("certificates.remove", { certificateId: pendingDeleteId });
			showToast("Certificate deleted successfully", "success");
			closeDialog("nz-cert-delete-dialog");
			window.location.reload();
		} catch {
			showToast("Error deleting certificate", "error");
		} finally {
			deleteConfirm.disabled = false;
		}
	});

	form.addEventListener("submit", async (e) => {
		e.preventDefault();
		formError.classList.add("hidden");
		formSubmit.disabled = true;
		const id = formId.value;
		const basePayload = {
			name: nameEl.value,
			certificateData: dataEl.value,
		};
		try {
			if (id) {
				await trpcMutate("certificates.update", {
					certificateId: id,
					...basePayload,
					...(privateEl.value.trim() ? { privateKey: privateEl.value } : {}),
				});
				showToast("Certificate updated", "success");
			} else {
				const serverId =
					serverEl instanceof HTMLSelectElement &&
					serverEl.value &&
					serverEl.value !== "nearzero"
						? serverEl.value
						: undefined;
				await trpcMutate("certificates.create", {
					...basePayload,
					privateKey: privateEl.value,
					serverId,
				});
				showToast("Certificate uploaded", "success");
			}
			closeDialog("nz-cert-form-dialog");
			window.location.reload();
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Error saving certificate";
			formError.textContent = msg;
			formError.classList.remove("hidden");
			showToast(id ? "Error updating certificate" : "Error uploading certificate", "error");
		} finally {
			formSubmit.disabled = false;
		}
	});
}
