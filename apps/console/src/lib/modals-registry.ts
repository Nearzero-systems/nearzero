/**
 * Nearzero console — native `<dialog>` inventory.
 * Migrate each to `NzModal` + `nz-modal` classes for shared motion and styling.
 */

export type ModalRegistryEntry = {
	id: string;
	area: string;
	purpose: string;
	variant?: "form" | "confirm" | "viewer" | "terminal";
};

export const NZ_MODAL_REGISTRY: ModalRegistryEntry[] = [
	/* Shell */
	{ id: "nz-org-upsert-dialog", area: "Dashboard shell", purpose: "Create / update organization", variant: "form" },
	{ id: "nz-org-delete-dialog", area: "Dashboard shell", purpose: "Delete organization", variant: "confirm" },
	{ id: "nz-accept-invite-dialog", area: "Notifications", purpose: "Accept organization invite", variant: "confirm" },

	/* Projects */
	{ id: "create-project-dialog", area: "Projects", purpose: "Add project", variant: "form" },
	{ id: "edit-project-dialog", area: "Projects", purpose: "Edit project", variant: "form" },
	{ id: "delete-project-dialog", area: "Projects", purpose: "Delete project", variant: "confirm" },
	{ id: "project-env-dialog", area: "Projects", purpose: "Project environment variables", variant: "form" },
	{ id: "delete-service-dialog", area: "Environment / project workspace", purpose: "Delete service", variant: "confirm" },

	/* Environment services */
	{ id: "nz-env-db-dialog", area: "Environment", purpose: "Create database", variant: "form" },
	{ id: "nz-env-template-dialog", area: "Environment", purpose: "Deploy template", variant: "form" },
	{ id: "nz-env-template-confirm-dialog", area: "Environment", purpose: "Confirm template deploy", variant: "confirm" },

	/* Application / Compose */
	{ id: "nz-app-act-dialog", area: "Application", purpose: "Service action confirm", variant: "confirm" },
	{ id: "nz-app-terminal-dialog", area: "Application", purpose: "Terminal", variant: "terminal" },
	{ id: "nz-app-terminal-close-dialog", area: "Application", purpose: "Close terminal confirm", variant: "confirm" },
	{ id: "nz-compose-act-dialog", area: "Compose", purpose: "Compose action confirm", variant: "confirm" },
	{ id: "nz-compose-terminal-dialog", area: "Compose", purpose: "Terminal", variant: "terminal" },
	{ id: "nz-compose-terminal-close-dialog", area: "Compose", purpose: "Close terminal confirm", variant: "confirm" },
	{ id: "nz-compose-preview-dialog", area: "Compose", purpose: "Preview deployment", variant: "viewer" },

	/* Schedules */
	{ id: "nz-schedule-form-dialog", area: "Schedules", purpose: "Create / edit schedule", variant: "form" },
	{ id: "nz-schedule-delete-dialog", area: "Schedules", purpose: "Delete schedule", variant: "confirm" },

	/* Database panel */
	{ id: "nz-db-terminal-dialog", area: "Database", purpose: "Terminal", variant: "terminal" },
	{ id: "nz-db-terminal-close-dialog", area: "Database", purpose: "Close terminal confirm", variant: "confirm" },

	/* Settings — Users */
	{ id: "nz-user-role-dialog", area: "Settings / Users", purpose: "Change role", variant: "form" },
	{ id: "nz-user-perm-dialog", area: "Settings / Users", purpose: "Edit permissions", variant: "form" },
	{ id: "nz-user-remove-dialog", area: "Settings / Users", purpose: "Remove member", variant: "confirm" },

	/* Settings — SSH, certs, registry, tags */
	{ id: "nz-ssh-form-dialog", area: "Settings / SSH", purpose: "Add SSH key", variant: "form" },
	{ id: "nz-ssh-delete-dialog", area: "Settings / SSH", purpose: "Delete SSH key", variant: "confirm" },
	{ id: "nz-cert-form-dialog", area: "Settings / Certificates", purpose: "Add certificate", variant: "form" },
	{ id: "nz-cert-delete-dialog", area: "Settings / Certificates", purpose: "Delete certificate", variant: "confirm" },
	{ id: "nz-registry-form-dialog", area: "Settings / Registry", purpose: "Add registry", variant: "form" },
	{ id: "nz-registry-delete-dialog", area: "Settings / Registry", purpose: "Delete registry", variant: "confirm" },
	{ id: "nz-dns-create-dialog", area: "Infrastructure / Domains", purpose: "Add DNS zone", variant: "form" },
	{ id: "nz-dns-records-dialog", area: "Infrastructure / Domains", purpose: "View zone records", variant: "viewer" },
	{ id: "nz-add-hostname-dialog", area: "Infrastructure / Domains", purpose: "Add domain or subdomain", variant: "form" },
	{ id: "nz-connect-service-dialog", area: "Infrastructure / Domains", purpose: "Connect service", variant: "form" },
	{ id: "nz-bind-env-dialog", area: "Infrastructure / Domains", purpose: "Environment DNS binding", variant: "form" },

	/* Settings — Git, cluster, servers, notifications, profile, web server */
	{ id: "nz-git-github-dialog", area: "Settings / Git", purpose: "Connect GitHub", variant: "form" },
	{ id: "nz-git-gitlab-dialog", area: "Settings / Git", purpose: "Connect GitLab", variant: "form" },
	{ id: "nz-git-bitbucket-dialog", area: "Settings / Git", purpose: "Connect Bitbucket", variant: "form" },
	{ id: "nz-git-gitea-dialog", area: "Settings / Git", purpose: "Connect Gitea", variant: "form" },
	{ id: "nz-git-edit-github-dialog", area: "Settings / Git", purpose: "Edit GitHub", variant: "form" },
	{ id: "nz-git-edit-gitlab-dialog", area: "Settings / Git", purpose: "Edit GitLab", variant: "form" },
	{ id: "nz-git-edit-bitbucket-dialog", area: "Settings / Git", purpose: "Edit Bitbucket", variant: "form" },
	{ id: "nz-git-edit-gitea-dialog", area: "Settings / Git", purpose: "Edit Gitea", variant: "form" },
	{ id: "nz-git-delete-dialog", area: "Settings / Git", purpose: "Disconnect provider", variant: "confirm" },
	{ id: "nz-cluster-add-dialog", area: "Settings / Cluster", purpose: "Add cluster node", variant: "form" },
	{ id: "nz-cluster-config-dialog", area: "Settings / Cluster", purpose: "Cluster config", variant: "viewer" },
	{ id: "nz-cluster-delete-dialog", area: "Settings / Cluster", purpose: "Remove node", variant: "confirm" },
	{ id: "nz-server-form-dialog", area: "Settings / Servers", purpose: "Add / edit server", variant: "form" },
	{ id: "nz-server-delete-dialog", area: "Settings / Servers", purpose: "Delete server", variant: "confirm" },
	{ id: "nz-server-setup-dialog", area: "Settings / Servers", purpose: "Server setup", variant: "viewer" },
	{ id: "nz-server-view-dialog", area: "Settings / Servers", purpose: "View ready server details", variant: "viewer" },
	{ id: "nz-server-actions-dialog", area: "Settings / Servers", purpose: "Server actions", variant: "form" },
	{ id: "nz-server-advanced-dialog", area: "Settings / Servers", purpose: "Advanced server settings", variant: "form" },
	{ id: "nz-servers-welcome-dialog", area: "Settings / Servers", purpose: "Welcome / onboarding", variant: "viewer" },
	{ id: "nz-notifications-form-dialog", area: "Settings / Notifications", purpose: "Notification channel", variant: "form" },
	{ id: "nz-notifications-delete-dialog", area: "Settings / Notifications", purpose: "Delete channel", variant: "confirm" },
	{ id: "nz-2fa-enable-dialog", area: "Settings / Profile", purpose: "Enable 2FA", variant: "form" },
	{ id: "nz-2fa-manage-dialog", area: "Settings / Profile", purpose: "Manage 2FA", variant: "form" },
	{ id: "nz-2fa-disable-dialog", area: "Settings / Profile", purpose: "Disable 2FA", variant: "confirm" },
	{ id: "nz-audit-metadata-dialog", area: "Settings / Audit logs", purpose: "Event metadata", variant: "viewer" },
	{ id: "nz-ws-update-dialog", area: "Settings / Web server", purpose: "Update web server", variant: "form" },
	{ id: "nz-ws-update-confirm-dialog", area: "Settings / Web server", purpose: "Confirm update", variant: "confirm" },
	{ id: "nz-ws-terminal-dialog", area: "Web server (shared)", purpose: "Terminal", variant: "terminal" },
	{ id: "nz-ws-logs-dialog", area: "Web server (shared)", purpose: "Logs", variant: "viewer" },
	{ id: "nz-ws-update-ip-dialog", area: "Web server (shared)", purpose: "Update IP", variant: "form" },
	{ id: "nz-ws-traefik-env-dialog", area: "Web server (shared)", purpose: "Traefik env", variant: "form" },
	{ id: "nz-ws-traefik-ports-dialog", area: "Web server (shared)", purpose: "Traefik ports", variant: "form" },
	{ id: "nz-ws-traefik-dashboard-dialog", area: "Web server (shared)", purpose: "Traefik dashboard", variant: "form" },
	{ id: "nz-ws-gpu-dialog", area: "Web server (shared)", purpose: "GPU settings", variant: "form" },
];
