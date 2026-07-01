const CLOSE_MS = 200;

function animatedClose(dialog: HTMLDialogElement) {
	if (!dialog.open || dialog.classList.contains("nz-modal--closing")) return;

	if (!dialog.classList.contains("nz-modal")) {
		dialog.close();
		return;
	}

	dialog.classList.remove("nz-modal--open");
	dialog.classList.add("nz-modal--closing");

	const finish = () => {
		dialog.classList.remove("nz-modal--closing");
		if (dialog.open) dialog.close();
	};

	window.setTimeout(finish, CLOSE_MS);
}

function animatedOpen(dialog: HTMLDialogElement) {
	dialog.classList.remove("nz-modal--closing");
	dialog.classList.add("nz-modal--open");
	if (!dialog.open) dialog.showModal();
}

function onModalCloseClick(event: Event) {
	const target = event.target;
	if (!(target instanceof Element)) return;

	const closeBtn = target.closest("[data-nz-modal-close], [data-env-dialog-close]");
	if (!closeBtn) return;

	const dialog = closeBtn.closest("dialog");
	if (!(dialog instanceof HTMLDialogElement)) return;
	if (!dialog.classList.contains("nz-modal") && !dialog.hasAttribute("data-env-dialog")) {
		return;
	}

	event.preventDefault();
	animatedClose(dialog);
}

function onModalBackdropClick(event: MouseEvent) {
	const dialog = event.currentTarget;
	if (!(dialog instanceof HTMLDialogElement)) return;
	if (!dialog.classList.contains("nz-modal")) return;
	if (dialog.dataset.nzModalBackdropClose !== "1") return;

	const panel = dialog.querySelector(".nz-modal__panel");
	if (!(panel instanceof HTMLElement)) return;
	if (event.target instanceof Node && panel.contains(event.target)) return;

	event.preventDefault();
	animatedClose(dialog);
}

export function refreshNzModalListeners() {
	document.querySelectorAll("dialog.nz-modal").forEach((node) => {
		if (!(node instanceof HTMLDialogElement)) return;
		if (node.dataset.nzModalBound === "1") return;
		node.dataset.nzModalBound = "1";

		node.addEventListener("click", onModalBackdropClick);

		node.addEventListener("cancel", (event) => {
			event.preventDefault();
			animatedClose(node);
		});
	});
}

export function mountNzModalGlobals() {
	if (typeof window === "undefined") return;
	window.nzOpenDialog = openNzDialog;
	window.nzCloseDialog = closeNzDialog;
	window.nzRefreshNzModals = refreshNzModalListeners;
}

export function initNzModals() {
	mountNzModalGlobals();

	if (document.documentElement.dataset.nzModalsInit === "1") {
		refreshNzModalListeners();
		return;
	}
	document.documentElement.dataset.nzModalsInit = "1";

	document.addEventListener("click", onModalCloseClick, true);
	refreshNzModalListeners();
}

export function openNzDialog(id: string) {
	const el = document.getElementById(id);
	if (el instanceof HTMLDialogElement && el.classList.contains("nz-modal")) {
		animatedOpen(el);
		return;
	}
	if (el instanceof HTMLDialogElement && !el.open) el.showModal();
}

export function closeNzDialog(id: string) {
	const el = document.getElementById(id);
	if (el instanceof HTMLDialogElement && el.classList.contains("nz-modal")) {
		animatedClose(el);
		return;
	}
	if (el instanceof HTMLDialogElement) el.close();
}

declare global {
	interface Window {
		nzOpenDialog?: (id: string) => void;
		nzCloseDialog?: (id: string) => void;
		nzRefreshNzModals?: () => void;
	}
}
