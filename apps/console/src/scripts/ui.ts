import { closeNzDialog, openNzDialog } from "./modal-animations";

export type ToastVariant = "default" | "success" | "error";

export function showToast(
	message: string,
	variant: ToastVariant = "default",
	options?: { description?: string; persistent?: boolean },
) {
	if (
		typeof window !== "undefined" &&
		typeof window.nzShowToast === "function"
	) {
		window.nzShowToast({
			message,
			variant,
			...(options?.description ? { description: options.description } : {}),
			...(options?.persistent ? { persistent: true } : {}),
		});
		return;
	}
	const root = document.getElementById("toast-root");
	if (!root) return;
	const el = document.createElement("div");
	el.className =
		variant === "error"
			? "nz-toast nz-toast--error pointer-events-auto w-full"
			: variant === "success"
				? "nz-toast nz-toast--success pointer-events-auto w-full"
				: "nz-toast pointer-events-auto w-full";
	const title = document.createElement("p");
	title.className = "nz-toast__title";
	title.textContent = message;
	el.appendChild(title);
	if (options?.description) {
		const desc = document.createElement("p");
		desc.className = "nz-toast__desc";
		desc.textContent = options.description;
		el.appendChild(desc);
	}
	root.appendChild(el);
	if (!options?.persistent) {
		window.setTimeout(() => el.remove(), 4000);
	}
}

type DropdownTrigger = HTMLButtonElement & {
	_nzDropdownAbort?: AbortController;
};

export function bindDropdownEl(trigger: HTMLButtonElement, menu: HTMLElement) {
	const triggerEl = trigger as DropdownTrigger;
	triggerEl._nzDropdownAbort?.abort();
	const ac = new AbortController();
	triggerEl._nzDropdownAbort = ac;
	trigger.dataset.nzDropdownBound = "1";

	const close = () => {
		menu.classList.add("hidden");
		trigger.setAttribute("aria-expanded", "false");
		menu.style.position = "";
		menu.style.top = "";
		menu.style.right = "";
		menu.style.left = "";
		menu.style.minWidth = "";
		menu.style.zIndex = "";
	};

	window.addEventListener(
		"nz-dropdown-open",
		(event) => {
			const openedMenu =
				event instanceof CustomEvent ? event.detail?.menu : null;
			if (openedMenu !== menu) close();
		},
		{ signal: ac.signal },
	);

	const positionMenu = () => {
		const rect = trigger.getBoundingClientRect();
		menu.style.position = "fixed";
		menu.style.top = `${rect.bottom + 4}px`;
		menu.style.right = `${window.innerWidth - rect.right}px`;
		menu.style.left = "auto";
		menu.style.minWidth = "10.5rem";
		menu.style.zIndex = "200";
	};

	trigger.addEventListener(
		"click",
		(e) => {
			e.stopImmediatePropagation();
			e.stopPropagation();
			const open = menu.classList.contains("hidden");
			if (open) {
				window.dispatchEvent(
					new CustomEvent("nz-dropdown-open", { detail: { menu } }),
				);
				positionMenu();
				menu.classList.remove("hidden");
				trigger.setAttribute("aria-expanded", "true");
			} else {
				close();
			}
		},
		{ capture: true, signal: ac.signal },
	);

	document.addEventListener(
		"click",
		(e) => {
			if (!(e.target instanceof Node)) return;
			if (!menu.contains(e.target) && !trigger.contains(e.target)) close();
		},
		{ signal: ac.signal },
	);

	document.addEventListener(
		"keydown",
		(e) => {
			if (e.key === "Escape") close();
		},
		{ signal: ac.signal },
	);
}

export function bindDropdown(triggerId: string, menuId: string) {
	const trigger = document.getElementById(triggerId);
	const menu = document.getElementById(menuId);
	if (!(trigger instanceof HTMLButtonElement) || !(menu instanceof HTMLElement))
		return;
	bindDropdownEl(trigger, menu);
}

export function bindElementEventOnce(
	el: EventTarget | null | undefined,
	key: string,
	type: string,
	listener: EventListenerOrEventListenerObject,
) {
	if (!(el instanceof HTMLElement)) return;
	if (el.dataset[key] === "1") return;
	el.dataset[key] = "1";
	el.addEventListener(type, listener);
}

export function openDialog(id: string) {
	window.nzRefreshNzModals?.();
	const el = document.getElementById(id);
	if (!(el instanceof HTMLDialogElement)) return;
	if (el.classList.contains("nz-modal")) {
		openNzDialog(id);
		return;
	}
	if (!el.open) el.showModal();
}

export function closeDialog(id: string) {
	const el = document.getElementById(id);
	if (!(el instanceof HTMLDialogElement)) return;
	if (el.classList.contains("nz-modal")) {
		closeNzDialog(id);
		return;
	}
	el.close();
}

declare global {
	interface Window {
		nzRefreshNzModals?: () => void;
		nzShowToast?: (input: { message: string; variant?: ToastVariant }) => void;
	}
}
