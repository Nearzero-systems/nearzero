function isPrimaryOpen(workspace: HTMLElement): boolean {
	return workspace.classList.contains("nz-agent-workspace--primary-open");
}

function applyPrimaryOpen(workspace: HTMLElement, open: boolean) {
	workspace.classList.toggle("nz-agent-workspace--primary-open", open);
	workspace.classList.toggle("nz-agent-workspace--primary-collapsed", !open);
	workspace.dataset.primaryOpen = open ? "1" : "0";

	const sidebar = document.getElementById("nz-agent-primary-sidebar");
	if (sidebar instanceof HTMLElement) {
		sidebar.setAttribute("aria-hidden", "false");
	}

	const btn = workspace.querySelector("[data-nz-primary-toggle]");
	if (btn instanceof HTMLButtonElement) {
		btn.setAttribute("aria-expanded", open ? "true" : "false");
		btn.setAttribute(
			"aria-label",
			open ? "Close primary sidebar" : "Open primary sidebar",
		);
	}
}

function syncPrimarySidebarState() {
	const workspace = document.querySelector(".nz-agent-workspace");
	if (!(workspace instanceof HTMLElement)) return;

	applyPrimaryOpen(workspace, isPrimaryOpen(workspace));
}

let documentToggleBound = false;

export function bindAgentPrimarySidebarToggle() {
	syncPrimarySidebarState();

	if (documentToggleBound) return;
	documentToggleBound = true;

	document.addEventListener("click", (event) => {
		const target = event.target;
		if (!(target instanceof Element)) return;

		const btn = target.closest("[data-nz-primary-toggle]");
		if (!(btn instanceof HTMLButtonElement)) return;

		const workspace = btn.closest(".nz-agent-workspace");
		if (!(workspace instanceof HTMLElement)) return;

		event.preventDefault();
		event.stopPropagation();

		const open = !isPrimaryOpen(workspace);
		applyPrimaryOpen(workspace, open);
	});
}
