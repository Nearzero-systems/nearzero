function isSecondaryOpen(workspace: HTMLElement): boolean {
	const value = workspace.dataset.secondaryOpen;
	if (value === undefined || value === "") return true;
	return value === "1";
}

function applySecondaryOpen(workspace: HTMLElement, column: HTMLElement, open: boolean) {
	workspace.dataset.secondaryOpen = open ? "1" : "0";
	column.classList.toggle("nz-agent-secondary-column--collapsed", !open);

	const nav = document.getElementById("nz-project-secondary-nav");
	if (nav instanceof HTMLElement) {
		nav.setAttribute("aria-hidden", open ? "false" : "true");
	}

	const btn = workspace.querySelector("[data-nz-secondary-toggle]");
	if (btn instanceof HTMLButtonElement) {
		btn.setAttribute("aria-expanded", open ? "true" : "false");
		btn.setAttribute(
			"aria-label",
			open ? "Close project sidebar" : "Open project sidebar",
		);
	}
}

function syncSecondaryState() {
	const workspace = document.getElementById("nz-project-workspace");
	if (!(workspace instanceof HTMLElement)) return;

	const column = workspace.querySelector("[data-nz-project-secondary-column]");
	if (!(column instanceof HTMLElement)) return;

	applySecondaryOpen(workspace, column, isSecondaryOpen(workspace));
}

let documentToggleBound = false;

export function bindProjectWorkspaceSecondaryToggle() {
	syncSecondaryState();

	if (documentToggleBound) return;
	documentToggleBound = true;

	document.addEventListener("click", (event) => {
		const target = event.target;
		if (!(target instanceof Element)) return;

		const btn = target.closest("[data-nz-secondary-toggle]");
		if (!(btn instanceof HTMLButtonElement)) return;

		const workspace = document.getElementById("nz-project-workspace");
		if (!(workspace instanceof HTMLElement)) return;

		const column = workspace.querySelector("[data-nz-project-secondary-column]");
		if (!(column instanceof HTMLElement)) return;

		event.preventDefault();
		event.stopPropagation();

		const open = !isSecondaryOpen(workspace);
		applySecondaryOpen(workspace, column, open);
	});
}
