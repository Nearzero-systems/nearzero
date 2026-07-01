import { setButtonLoadingVisuals } from "@/lib/auth-button-state";
import { trpcMutate, trpcQuery } from "@/lib/client-api";
import { normalizeDashboardPath, scopeDashboardHref } from "@/lib/org-routes";
import { pickAccessibleEnvironment } from "@/lib/pick-accessible-environment";
import { bindDropdown, closeDialog, openDialog, showToast } from "@/scripts/ui";

const SORT_KEY = "projectsSort";

function escapeHtml(value: string) {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function highlightProjectName(name: string) {
	return `<span class="font-semibold text-foreground">${escapeHtml(name)}</span>`;
}

type ProjectPayload = {
	projectId: string;
	name: string;
	description: string | null;
	createdAt: string;
	href: string | null;
	hasNoEnvironments: boolean;
	emptyServices: boolean;
	totalServices: number;
};

type Bootstrap = {
	initialQ: string;
	projects: ProjectPayload[];
	permissions: {
		project: { create?: boolean; delete?: boolean };
	};
};

function bindElementEventOnce(
	el: HTMLElement | null,
	key: string,
	type: string,
	handler: EventListener,
) {
	if (!el) return;
	const datasetKey = `nzProjects${key}Bound`;
	if (el.dataset[datasetKey] === "1") return;
	el.dataset[datasetKey] = "1";
	el.addEventListener(type, handler);
}

function parseBootstrap(root?: HTMLElement | null): Bootstrap | null {
	if (root?.dataset.bootstrap) {
		try {
			return JSON.parse(root.dataset.bootstrap) as Bootstrap;
		} catch {
			/* fall through */
		}
	}
	type NzWin = Window & { __NZ_PROJECTS_BOOTSTRAP?: Bootstrap };
	if (typeof window !== "undefined") {
		const w = window as NzWin;
		if (w.__NZ_PROJECTS_BOOTSTRAP) return w.__NZ_PROJECTS_BOOTSTRAP;
	}
	const el = document.getElementById("nz-projects-data");
	if (!el?.textContent?.trim()) return null;
	try {
		return JSON.parse(el.textContent) as Bootstrap;
	} catch {
		return null;
	}
}

function debounce(fn: () => void, ms: number) {
	let t: ReturnType<typeof setTimeout> | null = null;
	return () => {
		if (t) clearTimeout(t);
		t = setTimeout(() => {
			t = null;
			fn();
		}, ms);
	};
}

function resetCreateProjectDialog() {
	const name = document.getElementById(
		"create-project-name",
	) as HTMLInputElement | null;
	const desc = document.getElementById(
		"create-project-desc",
	) as HTMLTextAreaElement | null;
	if (name) name.value = "";
	if (desc) desc.value = "";
}

function setCreateProjectBusy(busy: boolean) {
	const submitBtn = document.getElementById(
		"create-project-submit",
	) as HTMLButtonElement | null;
	const cancel = document.querySelector(
		"#create-project-dialog [data-nz-modal-close]",
	);
	const nameEl = document.getElementById("create-project-name");
	const descEl = document.getElementById("create-project-desc");

	if (submitBtn) {
		submitBtn.disabled = busy;
		submitBtn.setAttribute("aria-busy", busy ? "true" : "false");
		setButtonLoadingVisuals(submitBtn, busy);
	}
	if (cancel instanceof HTMLButtonElement) cancel.disabled = busy;
	for (const el of [nameEl, descEl]) {
		if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
			el.disabled = busy;
		}
	}
}

export function mountProjectsDashboard() {
	const root = document.getElementById("nz-projects-root");
	if (!root) return;

	const bootstrap = parseBootstrap(root);
	if (!bootstrap) return;

	const b = bootstrap;
	const orgSlug = normalizeDashboardPath(window.location.pathname).orgSlug;
	const dash = (path: string) => scopeDashboardHref(path, orgSlug);

	const grid = document.getElementById("projects-grid");
	const emptyFiltered = document.getElementById("projects-empty-filtered");
	const emptyState = document.getElementById("projects-empty-state");
	const totalEl = document.getElementById("projects-total");
	const searchInput = document.getElementById(
		"projects-search",
	) as HTMLInputElement | null;
	const sortSelect = document.getElementById(
		"projects-sort",
	) as HTMLSelectElement | null;
	const syncUrlDebounced = debounce(() => {
		const base = `${window.location.pathname}`;
		const q = searchInput?.value.trim() ?? "";
		const next = q ? `${base}?${new URLSearchParams({ q }).toString()}` : base;
		if (next !== `${window.location.pathname}${window.location.search}`) {
			window.history.replaceState({}, "", next);
		}
	}, 500);

	let sortBy =
		sortSelect?.value ||
		window.localStorage.getItem(SORT_KEY) ||
		"createdAt-desc";

	function saveSort() {
		window.localStorage.setItem(SORT_KEY, sortBy);
	}

	function cardMatchesFilters(card: HTMLElement): boolean {
		const q = (searchInput?.value ?? "").trim().toLowerCase();
		const name = (card.dataset.name ?? "").toLowerCase();
		const desc = (card.dataset.description ?? "").toLowerCase();
		return !q || name.includes(q) || (desc.length > 0 && desc.includes(q));
	}

	function sortCompare(a: HTMLElement, b: HTMLElement): number {
		const [field, direction] = sortBy.split("-");
		let comparison = 0;
		switch (field) {
			case "name":
				comparison = (a.dataset.sortName ?? "").localeCompare(
					b.dataset.sortName ?? "",
				);
				break;
			case "createdAt":
				comparison =
					Number(a.dataset.sortCreated ?? 0) -
					Number(b.dataset.sortCreated ?? 0);
				break;
			case "services":
				comparison =
					Number(a.dataset.sortServices ?? 0) -
					Number(b.dataset.sortServices ?? 0);
				break;
			default:
				comparison = 0;
		}
		return direction === "asc" ? comparison : -comparison;
	}

	function applyFiltersAndSort() {
		if (!grid) return;
		const cards = [
			...grid.querySelectorAll<HTMLElement>("[data-project-card]"),
		];
		const total = cards.length;

		if (total === 0) {
			if (emptyFiltered) emptyFiltered.classList.add("hidden");
			if (emptyState) emptyState.classList.remove("hidden");
			if (totalEl) totalEl.textContent = "0 total";
			syncUrlDebounced();
			return;
		}

		for (const c of cards) {
			if (cardMatchesFilters(c)) c.classList.remove("hidden");
			else c.classList.add("hidden");
		}
		const visible = cards.filter((c) => !c.classList.contains("hidden"));
		visible.sort(sortCompare);
		for (const c of visible) grid.appendChild(c);

		const anyVisible = visible.length > 0;
		if (emptyState) emptyState.classList.add("hidden");
		if (emptyFiltered) {
			emptyFiltered.classList.toggle("hidden", anyVisible);
		}
		if (totalEl) {
			totalEl.textContent =
				visible.length === total
					? `${total} total`
					: `${visible.length} of ${total} total`;
		}
		syncUrlDebounced();
	}

	if (document.documentElement.dataset.nzProjectsShortcutBound !== "1") {
		document.documentElement.dataset.nzProjectsShortcutBound = "1";
		window.addEventListener("keydown", (e) => {
			const isMod = e.metaKey || e.ctrlKey;
			if (!isMod || e.code !== "KeyK") return;
			const target = e.target as HTMLElement | null;
			if (target) {
				const tag = target.tagName;
				if (
					target.isContentEditable ||
					tag === "INPUT" ||
					tag === "TEXTAREA" ||
					tag === "SELECT" ||
					target.getAttribute("role") === "textbox"
				)
					return;
			}
			e.preventDefault();
			document.getElementById("projects-search")?.focus();
		});
	}

	if (sortSelect) {
		sortSelect.value = sortBy;
		bindElementEventOnce(sortSelect, "Sort", "change", () => {
			sortBy = sortSelect.value;
			saveSort();
			applyFiltersAndSort();
		});
	}

	if (searchInput) {
		bindElementEventOnce(searchInput, "Search", "input", () =>
			applyFiltersAndSort(),
		);
	}

	applyFiltersAndSort();

	for (const p of b.projects) {
		bindDropdown(
			`proj-menu-trigger-${p.projectId}`,
			`proj-menu-${p.projectId}`,
		);
	}

	bindElementEventOnce(
		document.getElementById("create-project-open"),
		"CreateOpen",
		"click",
		() => {
			window.nzRefreshNzModals?.();
			resetCreateProjectDialog();
			openDialog("create-project-dialog");
		},
	);

	async function submitCreateProject() {
		const nameEl = document.getElementById(
			"create-project-name",
		) as HTMLInputElement | null;
		const descEl = document.getElementById(
			"create-project-desc",
		) as HTMLTextAreaElement | null;
		const name = nameEl?.value.trim() ?? "";
		const description = descEl?.value ?? "";
		if (!name) {
			showToast("Project name is required", "error");
			return;
		}
		setCreateProjectBusy(true);
		try {
			const data = await trpcMutate<{
				project: { projectId: string };
				environment?: { environmentId: string; name?: string };
			}>("project.create", { name, description });
			const projectIdToUse = data.project.projectId;
			showToast("Project Created", "success");
			closeDialog("create-project-dialog");

			let envId = data.environment?.environmentId;
			const createdName = data.environment?.name?.trim().toLowerCase();
			if (!envId || createdName !== "development") {
				try {
					const project = await trpcQuery<{
						environments: Array<{
							environmentId: string;
							name: string;
							isDefault?: boolean | null;
						}>;
					}>("project.one", { projectId: projectIdToUse });
					envId = pickAccessibleEnvironment(
						project.environments,
					)?.environmentId;
				} catch {
					/* use API response env id if refetch fails */
				}
			}

			if (envId) {
				window.location.href = dash(
					`/dashboard/project/${projectIdToUse}/environment/${envId}/overview`,
				);
				return;
			}
			window.location.reload();
		} catch (err) {
			showToast(
				err instanceof Error ? err.message : "Error creating a project",
				"error",
			);
		} finally {
			setCreateProjectBusy(false);
		}
	}

	function bindProjectForm(
		formId: string,
		handler: () => void | Promise<void>,
	) {
		const form = document.getElementById(formId);
		if (!(form instanceof HTMLFormElement) || form.dataset.bound === "1")
			return;
		form.dataset.bound = "1";
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			void handler();
		});
	}

	bindProjectForm("create-project-form", submitCreateProject);
	bindProjectForm("edit-project-form", submitEditProject);

	async function submitEditProject() {
		const id =
			(document.getElementById("edit-project-id") as HTMLInputElement | null)
				?.value ?? "";
		const nameEl = document.getElementById(
			"edit-project-name",
		) as HTMLInputElement | null;
		const descEl = document.getElementById(
			"edit-project-desc",
		) as HTMLTextAreaElement | null;
		const name = nameEl?.value.trim() ?? "";
		const description = descEl?.value ?? "";
		if (!id || !name) {
			showToast("Project name is required", "error");
			return;
		}
		try {
			await trpcMutate("project.update", { projectId: id, name, description });
			showToast("Project Updated", "success");
			closeDialog("edit-project-dialog");
			window.location.reload();
		} catch (err) {
			showToast(
				err instanceof Error ? err.message : "Error updating a project",
				"error",
			);
		}
	}

	document
		.querySelectorAll<HTMLButtonElement>("[data-edit-project]")
		.forEach((btn) => {
			bindElementEventOnce(btn, "Edit", "click", () => {
				const id = btn.dataset.editProject ?? "";
				const card = document.querySelector(`[data-project-card="${id}"]`);
				const name = card?.getAttribute("data-project-name") ?? "";
				const desc = card?.getAttribute("data-project-desc") ?? "";
				const hid = document.getElementById(
					"edit-project-id",
				) as HTMLInputElement | null;
				if (hid) hid.value = id;
				const nameEl = document.getElementById(
					"edit-project-name",
				) as HTMLInputElement | null;
				const descEl = document.getElementById(
					"edit-project-desc",
				) as HTMLTextAreaElement | null;
				if (nameEl) nameEl.value = name;
				if (descEl) descEl.value = desc;
				openDialog("edit-project-dialog");
			});
		});

	let deleteTargetId: string | null = null;
	let deleteTargetName = "";
	let deleteCanProceed = false;

	function syncDeleteProjectConfirm() {
		const input = document.getElementById(
			"delete-project-input",
		) as HTMLInputElement | null;
		const inputWrap = document.getElementById("delete-project-input-wrap");
		const actionBtn = document.getElementById(
			"delete-project-confirm",
		) as HTMLButtonElement | null;
		if (inputWrap) inputWrap.classList.toggle("hidden", !deleteCanProceed);
		if (input && !deleteCanProceed) input.value = "";
		const nameMatches =
			deleteCanProceed && input?.value.trim() === deleteTargetName;
		if (actionBtn) actionBtn.disabled = !nameMatches;
	}

	bindElementEventOnce(
		document.getElementById("delete-project-input"),
		"DeleteInput",
		"input",
		() => {
			syncDeleteProjectConfirm();
		},
	);

	document
		.querySelectorAll<HTMLButtonElement>("[data-open-delete]")
		.forEach((btn) => {
			bindElementEventOnce(btn, "DeleteOpen", "click", () => {
				deleteTargetId = btn.dataset.openDelete ?? null;
				const emptyOk = btn.dataset.emptyServices === "1";
				deleteCanProceed = emptyOk;
				const card = document.querySelector(
					`[data-project-card="${deleteTargetId}"]`,
				);
				const projectName =
					card?.getAttribute("data-project-name") ?? "this project";
				deleteTargetName = projectName;
				const warn = document.getElementById("delete-project-warn");
				const confirmText = document.getElementById(
					"delete-project-confirm-text",
				);
				const inputLabel = document.getElementById(
					"delete-project-input-label",
				);
				const input = document.getElementById(
					"delete-project-input",
				) as HTMLInputElement | null;
				if (confirmText) {
					confirmText.innerHTML = emptyOk
						? `Are you sure you want to delete ${highlightProjectName(projectName)}?`
						: `${highlightProjectName(projectName)} still has active services.`;
				}
				if (inputLabel) {
					inputLabel.innerHTML = highlightProjectName(projectName);
				}
				if (input) {
					input.value = "";
					input.placeholder = projectName;
				}
				if (warn) warn.classList.toggle("hidden", emptyOk);
				syncDeleteProjectConfirm();
				openDialog("delete-project-dialog");
			});
		});

	bindElementEventOnce(
		document.getElementById("delete-project-confirm"),
		"DeleteConfirm",
		"click",
		async () => {
			if (!deleteTargetId || !deleteCanProceed) return;
			const input = document.getElementById(
				"delete-project-input",
			) as HTMLInputElement | null;
			if (input?.value.trim() !== deleteTargetName) return;
			try {
				await trpcMutate("project.remove", { projectId: deleteTargetId });
				showToast("Project deleted successfully", "success");
				closeDialog("delete-project-dialog");
				window.location.reload();
			} catch {
				showToast("Error deleting this project", "error");
			}
		},
	);
}
