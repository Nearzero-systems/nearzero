import { trpcMutate, trpcQuery } from "@/lib/client-api";
import {
	bindDropdown,
	bindElementEventOnce,
	closeDialog,
	openDialog,
	showToast,
} from "@/scripts/ui";

const FREE_ROLES = ["owner", "admin", "member"];
let pendingRemoveUserId = "";

type MemberRow = {
	memberId: string;
	userId: string;
	email: string;
	role: string;
	twoFactorEnabled: boolean;
	createdAt: string;
	isSelf: boolean;
	canChangeRole: boolean;
	canEditPermissions: boolean;
	canDelete: boolean;
	canUnlink: boolean;
	hasAnyAction: boolean;
};

type Bootstrap = {
	members: MemberRow[];
	pendingInvitations: Array<{
		invitationId: string;
		email: string;
		role: string;
		status: string;
		createdAt: string;
		expiresAt: string;
		canCancel: boolean;
		hasAnyAction: boolean;
	}>;
	canInvite: boolean;
};

function parseBootstrap(): Bootstrap | null {
	type W = Window & { __NZ_USERS_BOOTSTRAP?: Bootstrap };
	const w = window as W;
	if (w.__NZ_USERS_BOOTSTRAP) return w.__NZ_USERS_BOOTSTRAP;
	const el = document.getElementById("nz-users-data");
	if (!el?.textContent?.trim()) return null;
	try {
		return JSON.parse(el.textContent) as Bootstrap;
	} catch {
		return null;
	}
}

type Service = { id: string; name: string; type: string; createdAt: string };

function extractServices(env: any): Service[] {
	const apps: Service[] = [];
	const push = (items: any[] | undefined, type: string, idKey: string) => {
		for (const item of items ?? []) {
			apps.push({
				id: item[idKey],
				name: item.name,
				type,
				createdAt: item.createdAt,
			});
		}
	};
	push(env?.applications, "application", "applicationId");
	push(env?.mysql, "mysql", "mysqlId");
	push(env?.redis, "redis", "redisId");
	push(env?.mongo, "mongo", "mongoId");
	push(env?.postgres, "postgres", "postgresId");
	push(env?.mariadb, "mariadb", "mariadbId");
	push(env?.compose, "compose", "composeId");
	push(env?.libsql, "libsql", "libsqlId");
	apps.sort(
		(a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
	);
	return apps;
}

function serviceDotClass(type: string) {
	if (type === "application") return "bg-green-500";
	if (type === "compose") return "bg-purple-500";
	return "bg-orange-500";
}

function bindUserRemoveDialogActions() {
	bindElementEventOnce(
		document.getElementById("nz-user-remove-confirm"),
		"usersRemoveConfirmBound",
		"click",
		async () => {
			if (!pendingRemoveUserId) return;
			try {
				await trpcMutate("user.remove", { userId: pendingRemoveUserId });
				showToast("Member removed", "success");
				closeDialog("nz-user-remove-dialog");
				window.location.reload();
			} catch (err) {
				showToast(
					err instanceof Error ? err.message : "Error removing member",
					"error",
				);
			} finally {
				pendingRemoveUserId = "";
			}
		},
	);

	bindElementEventOnce(
		document.getElementById("nz-user-remove-cancel"),
		"usersRemoveCancelBound",
		"click",
		() => {
			pendingRemoveUserId = "";
			closeDialog("nz-user-remove-dialog");
		},
	);
}

export function mountUsersDashboard() {
	const root = document.getElementById("nz-users-root");
	if (!root) return;
	const bootstrap = parseBootstrap();
	if (!bootstrap) return;

	const { members, pendingInvitations, canInvite } = bootstrap;

	const inviteForm = document.getElementById("nz-user-invite-form");
	const inviteEmail = document.getElementById("nz-user-invite-email");
	const inviteRole = document.getElementById("nz-user-invite-role");
	const inviteError = document.getElementById("nz-user-invite-error");
	const inviteSubmit = document.getElementById("nz-user-invite-submit");

	if (canInvite) {
		for (const btn of document.querySelectorAll<HTMLButtonElement>(
			"#nz-users-invite-open",
		)) {
			bindElementEventOnce(btn, "usersInviteOpenBound", "click", () => {
				if (inviteEmail instanceof HTMLInputElement) inviteEmail.value = "";
				if (inviteRole instanceof HTMLSelectElement)
					inviteRole.value = "member";
				if (inviteError instanceof HTMLElement)
					inviteError.classList.add("hidden");
				openDialog("nz-user-invite-dialog");
			});
		}

		bindElementEventOnce(
			inviteForm,
			"usersInviteSubmitBound",
			"submit",
			async (event) => {
				event.preventDefault();
				if (
					!(inviteEmail instanceof HTMLInputElement) ||
					!(inviteRole instanceof HTMLSelectElement)
				) {
					return;
				}
				const email = inviteEmail.value.trim();
				const role = inviteRole.value.trim();
				if (!email) return;
				if (inviteError instanceof HTMLElement)
					inviteError.classList.add("hidden");
				if (inviteSubmit instanceof HTMLButtonElement)
					inviteSubmit.disabled = true;
				try {
					await trpcMutate("organization.inviteMember", { email, role });
					showToast("Invitation sent", "success");
					closeDialog("nz-user-invite-dialog");
					window.location.reload();
				} catch (err) {
					const msg =
						err instanceof Error ? err.message : "Could not send invitation";
					if (inviteError instanceof HTMLElement) {
						inviteError.textContent = msg;
						inviteError.classList.remove("hidden");
					}
					showToast(msg, "error");
				} finally {
					if (inviteSubmit instanceof HTMLButtonElement)
						inviteSubmit.disabled = false;
				}
			},
		);
	}

	for (const m of members) {
		if (m.hasAnyAction) {
			bindDropdown(
				`nz-user-menu-trigger-${m.memberId}`,
				`nz-user-menu-${m.memberId}`,
			);
		}
	}
	for (const invite of pendingInvitations) {
		if (invite.hasAnyAction) {
			bindDropdown(
				`nz-user-menu-trigger-${invite.invitationId}`,
				`nz-user-menu-${invite.invitationId}`,
			);
		}
	}
	bindUserRemoveDialogActions();

	if (root.dataset.bound === "1") return;
	root.dataset.bound = "1";

	let permissionsUserId = "";

	const roleDlg = document.getElementById("nz-user-role-dialog");
	const roleForm = document.getElementById("nz-user-role-form");
	const roleMemberId = document.getElementById("nz-user-role-member-id");
	const roleSelect = document.getElementById("nz-user-role-select");
	const roleEmail = document.getElementById("nz-user-role-email");
	const roleError = document.getElementById("nz-user-role-error");
	const roleSubmit = document.getElementById("nz-user-role-submit");

	const permDlg = document.getElementById("nz-user-perm-dialog");
	const permForm = document.getElementById("nz-user-perm-form");
	const permBody = document.getElementById("nz-user-perm-body");
	const permError = document.getElementById("nz-user-perm-error");
	const permSubmit = document.getElementById("nz-user-perm-submit");

	const removeDlg = document.getElementById("nz-user-remove-dialog");

	const openChangeRole = async (
		memberId: string,
		currentRole: string,
		email: string,
	) => {
		if (
			!(roleDlg instanceof HTMLDialogElement) ||
			!(roleMemberId instanceof HTMLInputElement) ||
			!(roleSelect instanceof HTMLSelectElement) ||
			!(roleEmail instanceof HTMLElement) ||
			!(roleError instanceof HTMLElement)
		)
			return;
		roleMemberId.value = memberId;
		roleEmail.textContent = email;
		roleError.classList.add("hidden");
		roleSelect.innerHTML = `
			<option value="admin">Admin</option>
			<option value="member">Member</option>
		`;
		roleSelect.value = currentRole;
		roleDlg.showModal();
	};

	let permState: Record<string, unknown> = {};

	const renderPermissionsForm = (
		data: any,
		projects: any[],
		gitProviders: any[],
		servers: any[],
		isCustomRole: boolean,
	) => {
		if (!(permBody instanceof HTMLElement)) return;
		const boolFields = [
			[
				"canCreateProjects",
				"Create Projects",
				"Allow the user to create projects",
			],
			[
				"canDeleteProjects",
				"Delete Projects",
				"Allow the user to delete projects",
			],
			[
				"canCreateServices",
				"Create Services",
				"Allow the user to create services",
			],
			[
				"canDeleteServices",
				"Delete Services",
				"Allow the user to delete services",
			],
			[
				"canCreateEnvironments",
				"Create Environments",
				"Allow the user to create environments",
			],
			[
				"canDeleteEnvironments",
				"Delete Environments",
				"Allow the user to delete environments",
			],
			[
				"canAccessToTraefikFiles",
				"Access to Traefik Files",
				"Allow the user to access to the Traefik Tab Files",
			],
			[
				"canAccessToDocker",
				"Access to Docker",
				"Allow the user to access to the Docker Tab",
			],
			[
				"canAccessToAPI",
				"Access to API/CLI",
				"Allow the user to access to the API/CLI",
			],
			[
				"canAccessToSSHKeys",
				"Access to SSH Keys",
				"Allow to users to access to the SSH Keys section",
			],
			[
				"canAccessToGitProviders",
				"Access to Git Providers",
				"Allow to users to access to the Git Providers section",
			],
		];

		const state = {
			accessedProjects: [...(data.accessedProjects || [])],
			accessedEnvironments: [...(data.accessedEnvironments || [])],
			accessedServices: [...(data.accessedServices || [])],
			accessedGitProviders: [...(data.accessedGitProviders || [])],
			accessedServers: [...(data.accessedServers || [])],
			...(Object.fromEntries(
				boolFields.map(([key]) => [key, Boolean(data[key])]),
			) as Record<string, boolean>),
		};
		permState = state;

		const toggleArr = (
			key: keyof typeof state,
			id: string,
			checked: boolean,
		) => {
			const arr = state[key] as string[];
			if (checked) {
				if (!arr.includes(id)) arr.push(id);
			} else {
				const i = arr.indexOf(id);
				if (i >= 0) arr.splice(i, 1);
			}
		};

		let html = `<div class="grid grid-cols-1 md:grid-cols-2 w-full gap-4">`;
		if (isCustomRole) {
			html += `<div class="md:col-span-2 rounded-lg border p-3 bg-muted/50 text-sm text-muted-foreground">This user has a custom role assigned. Capabilities are defined by the role. You can still manage which projects, environments, and services they can access below.</div>`;
		} else {
			for (const [key, label, desc] of boolFields) {
				html += `
					<label class="flex flex-row items-center justify-between rounded-lg border p-3 shadow-sm">
						<div class="space-y-0.5">
							<span class="text-sm font-medium">${label}</span>
							<p class="text-xs text-muted-foreground">${desc}</p>
						</div>
						<input type="checkbox" class="h-4 w-4 rounded border" data-perm-bool="${key}" ${state[key as keyof typeof state] ? "checked" : ""} />
					</label>`;
			}
		}

		html += `<div class="md:col-span-2"><div class="mb-4"><span class="text-base font-medium">Projects</span><p class="text-xs text-muted-foreground">Select the Projects that the user can access</p></div>`;
		if (!projects.length) {
			html += `<p class="text-sm text-muted-foreground">No projects found</p>`;
		}
		for (const project of projects) {
			html += `<div class="flex flex-col items-start rounded-lg p-4 border mb-4">`;
			html += `<div class="flex flex-row gap-4 items-center w-full">
				<input type="checkbox" class="h-4 w-4 rounded border" data-perm-project="${project.projectId}" ${state.accessedProjects.includes(project.projectId) ? "checked" : ""} />
				<span class="text-base font-semibold text-primary">${project.name}</span>
			</div><div class="ml-6 w-full space-y-3">`;
			for (const env of project.environments ?? []) {
				const services = extractServices(env);
				html += `<div class="border-l-2 border-muted pl-4">
					<label class="flex flex-row items-center space-x-3 mb-2">
						<input type="checkbox" class="h-4 w-4 rounded border" data-perm-env="${env.environmentId}" data-perm-env-project="${project.projectId}" ${state.accessedEnvironments.includes(env.environmentId) ? "checked" : ""} />
						<div class="flex items-center gap-2">
							<div class="w-2 h-2 bg-blue-500 rounded-full"></div>
							<span class="text-sm font-medium">${env.name}</span>
							<span class="text-xs text-muted-foreground">(${services.length} services)</span>
						</div>
					</label>
					<div class="ml-4 space-y-2">`;
				for (const svc of services) {
					html += `<label class="flex flex-row items-center space-x-3">
						<input type="checkbox" class="h-4 w-4 rounded border" data-perm-service="${svc.id}" data-perm-service-env="${env.environmentId}" data-perm-service-project="${project.projectId}" ${state.accessedServices.includes(svc.id) ? "checked" : ""} />
						<div class="flex items-center gap-2">
							<div class="w-1.5 h-1.5 rounded-full ${serviceDotClass(svc.type)}"></div>
							<span class="text-sm text-muted-foreground">${svc.name}</span>
							<span class="text-xs text-muted-foreground/70 capitalize">(${svc.type})</span>
						</div>
					</label>`;
				}
				html += "</div></div>";
			}
			html += "</div></div>";
		}
		html += "</div>";

		html += `<div class="md:col-span-2"><div class="mb-4"><span class="text-base font-medium">Git Providers</span></div>`;
		for (const gp of gitProviders) {
			html += `<label class="flex flex-row items-center space-x-3 rounded-lg border p-3 mb-2">
				<input type="checkbox" class="h-4 w-4 rounded border" data-perm-git="${gp.gitProviderId}" ${state.accessedGitProviders.includes(gp.gitProviderId) ? "checked" : ""} />
				<span class="text-sm">${gp.name}</span>
				<span class="text-xs text-muted-foreground capitalize">(${gp.providerType})</span>
			</label>`;
		}
		html += `</div><div class="md:col-span-2"><div class="mb-4"><span class="text-base font-medium">Servers</span></div>`;
		for (const s of servers) {
			html += `<label class="flex flex-row items-center space-x-3 rounded-lg border p-3 mb-2">
				<input type="checkbox" class="h-4 w-4 rounded border" data-perm-server="${s.serverId}" ${state.accessedServers.includes(s.serverId) ? "checked" : ""} />
				<span class="text-sm">${s.name}</span>
				<span class="text-xs text-muted-foreground">(${s.ipAddress})</span>
			</label>`;
		}
		html += "</div>";
		html += "</div>";
		permBody.innerHTML = html;

		permBody.querySelectorAll("[data-perm-project]").forEach((el) => {
			el.addEventListener("change", () => {
				if (!(el instanceof HTMLInputElement)) return;
				const pid = el.dataset.permProject!;
				toggleArr("accessedProjects", pid, el.checked);
				if (!el.checked) {
					permBody
						.querySelectorAll(`[data-perm-env-project="${pid}"]`)
						.forEach((e) => {
							if (e instanceof HTMLInputElement) {
								e.checked = false;
								toggleArr("accessedEnvironments", e.dataset.permEnv!, false);
							}
						});
					permBody
						.querySelectorAll(`[data-perm-service-project="${pid}"]`)
						.forEach((e) => {
							if (e instanceof HTMLInputElement) {
								e.checked = false;
								toggleArr("accessedServices", e.dataset.permService!, false);
							}
						});
				}
			});
		});

		permBody.querySelectorAll("[data-perm-env]").forEach((el) => {
			el.addEventListener("change", () => {
				if (!(el instanceof HTMLInputElement)) return;
				const eid = el.dataset.permEnv!;
				const pid = el.dataset.permEnvProject!;
				toggleArr("accessedEnvironments", eid, el.checked);
				if (el.checked && !state.accessedProjects.includes(pid)) {
					toggleArr("accessedProjects", pid, true);
					const pEl = permBody.querySelector(`[data-perm-project="${pid}"]`);
					if (pEl instanceof HTMLInputElement) pEl.checked = true;
				}
				if (!el.checked) {
					permBody
						.querySelectorAll(`[data-perm-service-env="${eid}"]`)
						.forEach((e) => {
							if (e instanceof HTMLInputElement) {
								e.checked = false;
								toggleArr("accessedServices", e.dataset.permService!, false);
							}
						});
				}
			});
		});

		permBody.querySelectorAll("[data-perm-service]").forEach((el) => {
			el.addEventListener("change", () => {
				if (!(el instanceof HTMLInputElement)) return;
				const sid = el.dataset.permService!;
				const eid = el.dataset.permServiceEnv!;
				const pid = el.dataset.permServiceProject!;
				toggleArr("accessedServices", sid, el.checked);
				if (el.checked) {
					if (!state.accessedEnvironments.includes(eid)) {
						toggleArr("accessedEnvironments", eid, true);
						const eEl = permBody.querySelector(`[data-perm-env="${eid}"]`);
						if (eEl instanceof HTMLInputElement) eEl.checked = true;
					}
					if (!state.accessedProjects.includes(pid)) {
						toggleArr("accessedProjects", pid, true);
						const pEl = permBody.querySelector(`[data-perm-project="${pid}"]`);
						if (pEl instanceof HTMLInputElement) pEl.checked = true;
					}
				}
			});
		});

		permBody.querySelectorAll("[data-perm-git]").forEach((el) => {
			el.addEventListener("change", () => {
				if (!(el instanceof HTMLInputElement)) return;
				toggleArr("accessedGitProviders", el.dataset.permGit!, el.checked);
			});
		});

		permBody.querySelectorAll("[data-perm-server]").forEach((el) => {
			el.addEventListener("change", () => {
				if (!(el instanceof HTMLInputElement)) return;
				toggleArr("accessedServers", el.dataset.permServer!, el.checked);
			});
		});
	};

	permForm?.addEventListener("submit", async (e) => {
		e.preventDefault();
		if (!(permBody instanceof HTMLElement)) return;
		if (permError instanceof HTMLElement) permError.classList.add("hidden");
		if (permSubmit instanceof HTMLButtonElement) permSubmit.disabled = true;
		permBody.querySelectorAll("[data-perm-bool]").forEach((el) => {
			if (el instanceof HTMLInputElement) {
				permState[el.dataset.permBool!] = el.checked;
			}
		});
		try {
			await trpcMutate("user.assignPermissions", {
				id: permissionsUserId,
				canCreateServices: permState.canCreateServices,
				canCreateProjects: permState.canCreateProjects,
				canDeleteServices: permState.canDeleteServices,
				canDeleteProjects: permState.canDeleteProjects,
				canDeleteEnvironments: permState.canDeleteEnvironments,
				canAccessToTraefikFiles: permState.canAccessToTraefikFiles,
				accessedProjects: permState.accessedProjects,
				accessedEnvironments: permState.accessedEnvironments,
				accessedServices: permState.accessedServices,
				accessedGitProviders: permState.accessedGitProviders,
				accessedServers: permState.accessedServers,
				canAccessToDocker: permState.canAccessToDocker,
				canAccessToAPI: permState.canAccessToAPI,
				canAccessToSSHKeys: permState.canAccessToSSHKeys,
				canAccessToGitProviders: permState.canAccessToGitProviders,
				canCreateEnvironments: permState.canCreateEnvironments,
			});
			showToast("Permissions updated", "success");
			if (permDlg instanceof HTMLDialogElement) permDlg.close();
			window.location.reload();
		} catch {
			if (permError instanceof HTMLElement) {
				permError.textContent = "Error updating the permissions";
				permError.classList.remove("hidden");
			}
			showToast("Error updating the permissions", "error");
		} finally {
			if (permSubmit instanceof HTMLButtonElement) permSubmit.disabled = false;
		}
	});

	const openPermissions = async (userId: string, role: string) => {
		if (
			!(permDlg instanceof HTMLDialogElement) ||
			!(permBody instanceof HTMLElement)
		)
			return;
		permissionsUserId = userId;
		if (permError instanceof HTMLElement) permError.classList.add("hidden");
		permBody.innerHTML = `<div class="flex items-center justify-center py-8 text-sm text-muted-foreground">Loading...</div>`;
		permDlg.showModal();
		try {
			const [data, projects, gitProviders, servers] =
				await Promise.all([
					trpcQuery("user.one", { userId }),
					trpcQuery("project.allForPermissions"),
					trpcQuery("gitProvider.allForPermissions").catch(() => []),
					trpcQuery("server.allForPermissions").catch(() => []),
				]);
			const isCustomRole = !!role && !FREE_ROLES.includes(role);
			renderPermissionsForm(
				data,
				projects as any[],
				gitProviders as any[],
				servers as any[],
				isCustomRole,
			);
		} catch {
			permBody.innerHTML = `<p class="text-sm text-red-600">Failed to load permissions.</p>`;
		}
	};

	root.addEventListener("click", (e) => {
		const t =
			e.target instanceof Element
				? e.target.closest("[data-user-action]")
				: null;
		if (!(t instanceof HTMLElement)) return;
		const action = t.dataset.userAction;
		const memberId = t.dataset.memberId ?? "";
		const userId = t.dataset.userId ?? "";
		const role = t.dataset.role ?? "";
		const email = t.dataset.email ?? "";

		if (action === "change-role") {
			e.preventDefault();
			void openChangeRole(memberId, role, email);
		} else if (action === "permissions") {
			e.preventDefault();
			void openPermissions(userId, role);
		} else if (action === "remove-member") {
			e.preventDefault();
			pendingRemoveUserId = userId;
			openDialog("nz-user-remove-dialog");
		} else if (action === "cancel-invitation") {
			e.preventDefault();
			const invitationId = t.dataset.invitationId ?? "";
			if (!invitationId) return;
			void (async () => {
				try {
					await trpcMutate("organization.removeInvitation", { invitationId });
					showToast("Invitation canceled", "success");
					window.location.reload();
				} catch (err) {
					showToast(
						err instanceof Error ? err.message : "Could not cancel invitation",
						"error",
					);
				}
			})();
		}
	});

	roleForm?.addEventListener("submit", async (e) => {
		e.preventDefault();
		if (
			!(roleMemberId instanceof HTMLInputElement) ||
			!(roleSelect instanceof HTMLSelectElement)
		)
			return;
		if (roleError instanceof HTMLElement) roleError.classList.add("hidden");
		if (roleSubmit instanceof HTMLButtonElement) roleSubmit.disabled = true;
		try {
			await trpcMutate("organization.updateMemberRole", {
				memberId: roleMemberId.value,
				role: roleSelect.value,
			});
			showToast("Role updated successfully", "success");
			if (roleDlg instanceof HTMLDialogElement) roleDlg.close();
			window.location.reload();
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Error updating role";
			if (roleError instanceof HTMLElement) {
				roleError.textContent = msg;
				roleError.classList.remove("hidden");
			}
			showToast(msg, "error");
		} finally {
			if (roleSubmit instanceof HTMLButtonElement) roleSubmit.disabled = false;
		}
	});

	for (const dlg of [roleDlg, permDlg, removeDlg]) {
		dlg?.querySelectorAll("[data-close-dialog]").forEach((btn) => {
			btn.addEventListener("click", () => {
				if (dlg instanceof HTMLDialogElement) dlg.close();
			});
		});
	}
}
