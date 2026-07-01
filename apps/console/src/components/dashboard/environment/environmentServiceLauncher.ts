import { setButtonLoadingVisuals } from "@/lib/auth-button-state";
import { APP_NAME_MESSAGE, isValidAppName } from "@/lib/app-name";
import { trpcMutate, trpcQuery } from "@/lib/client-api";
import {
	previewServiceDomain,
	provisionServiceDomain,
	validateDomainWithEdgeIp,
	type PreviewServiceDomainResult,
} from "@/lib/managed-domain-client";
import { NZ_TOAST_EVENT } from "@/lib/nzToast";
import {
	formatRuntimeServerLabel,
	formatRuntimeServerReadiness,
	listReadyRuntimeServers,
	runtimeServerPlaceholder,
	runtimeServerRequirementMessage,
	type RuntimeServerOption,
} from "@/lib/runtime-server-options";
import { slugify } from "@/lib/slug";
import { openAddHostnameDialog } from "@/scripts/domains-hub";
import { closeNzDialog } from "@/scripts/modal-animations";
import { closeDialog, openDialog } from "@/scripts/ui";

const TEMPLATE_BASE_URL_KEY = "nearzero_template_base_url";

/**
 * Maps the dialog's db type radio value to its tRPC router, id field, and the
 * URL path segment of its detail page. After creation we deploy the database and
 * redirect to this detail page, which hosts the full deploy/logs/terminal UI.
 */
const DB_DEPLOY_INFO: Record<
	string,
	{ router: string; idField: string; pathSegment: string }
> = {
	postgres: { router: "postgres", idField: "postgresId", pathSegment: "postgres" },
	mysql: { router: "mysql", idField: "mysqlId", pathSegment: "mysql" },
	mariadb: { router: "mariadb", idField: "mariadbId", pathSegment: "mariadb" },
	mongo: { router: "mongo", idField: "mongoId", pathSegment: "mongo" },
	redis: { router: "redis", idField: "redisId", pathSegment: "redis" },
	libsql: { router: "libsql", idField: "libsqlId", pathSegment: "libsql" },
};



let launcherAbort: AbortController | null = null;
let openTemplateDialog: (() => void) | null = null;

type ServerOption = RuntimeServerOption;

type ServiceOption = {
	id: string;
	name: string;
	type: "application" | "compose";
	serverId?: string | null;
};

type LauncherContext = {
	environmentId: string;
	projectId: string;
	projectSlug: string;
	isCommunity: boolean;
	servers: ServerOption[];
	services: ServiceOption[];
	dnsZoneId?: string;
	domainPrefix?: string;
	environmentName?: string;
	isProduction?: boolean;
	zoneName?: string;
};

type TemplateItem = {
	id: string;
	name: string;
	description?: string;
	version?: string;
	logo?: string;
	tags?: string[];
};

const DB_DOCKER_DEFAULTS: Record<string, string> = {
	mongo: "mongo:8",
	libsql: "ghcr.io/tursodatabase/libsql-server:v0.24.32",
	mariadb: "mariadb:11",
	mysql: "mysql:8",
	postgres: "postgres:18",
	redis: "redis:7",
};

const DB_USER_DEFAULTS: Record<string, string> = {
	libsql: "libsql",
	mariadb: "mariadb",
	mongo: "mongo",
	mysql: "mysql",
	postgres: "postgres",
};

function toast(message: string, variant?: "success" | "error") {
	document.dispatchEvent(
		new CustomEvent(NZ_TOAST_EVENT, {
			bubbles: true,
			detail: { message, variant },
		}),
	);
}

function readContext(root: HTMLElement): LauncherContext | null {
	const environmentId = root.getAttribute("data-environment-id")?.trim() ?? "";
	const projectId = root.getAttribute("data-project-id")?.trim() ?? "";
	const projectSlug = root.getAttribute("data-project-slug")?.trim() ?? "";
	if (!environmentId) return null;

	let servers: ServerOption[] = [];
	const serversEl = document.getElementById("nz-env-servers-json");
	if (serversEl?.textContent) {
		try {
			servers = JSON.parse(serversEl.textContent) as ServerOption[];
		} catch {
			servers = [];
		}
	}
	let services: ServiceOption[] = [];
	const servicesEl = document.getElementById("nz-env-services-json");
	if (servicesEl?.textContent) {
		try {
			services = JSON.parse(servicesEl.textContent) as ServiceOption[];
		} catch {
			services = [];
		}
	}

	return {
		environmentId,
		projectId,
		projectSlug,
		isCommunity: root.getAttribute("data-community") !== "0",
		servers,
		services,
		dnsZoneId: root.getAttribute("data-dns-zone-id")?.trim() || undefined,
		domainPrefix: root.getAttribute("data-domain-prefix")?.trim() || undefined,
		environmentName: root.getAttribute("data-environment-name")?.trim() || undefined,
		isProduction: root.getAttribute("data-is-production") === "1",
		zoneName: root.getAttribute("data-zone-name")?.trim() || undefined,
	};
}

function bindEnvDialogOpenHandlers(signal: AbortSignal) {
	document.addEventListener(
		"nz-env-dialog-open",
		(event) => {
			const root = document.querySelector<HTMLElement>("[data-env-service-root]");
			if (!root) return;
			const ctx = readContext(root);
			if (!ctx) return;

			const id =
				event instanceof CustomEvent && typeof event.detail?.id === "string"
					? event.detail.id
					: "";

			if (id === "nz-env-db-dialog") openDatabaseDialog(ctx);
			else if (id === "nz-env-template-dialog") openTemplateDialog?.();
			else if (id === "nz-env-domain-dialog") openDomainDialog(ctx);
		},
		{ signal },
	);
}

function normalizeServerId(value: string | undefined) {
	if (!value || value === "nearzero") return undefined;
	return value;
}

function fillServerSelect(
	select: HTMLSelectElement,
	ctx: LauncherContext,
	includeEmpty = false,
) {
	select.replaceChildren();
	select.required = !ctx.isCommunity;
	if (!ctx.isCommunity) {
		const readyServers = listReadyRuntimeServers(ctx.servers);
		if (readyServers.length === 0) {
			const opt = document.createElement("option");
			opt.value = "";
			opt.textContent = runtimeServerPlaceholder(ctx.servers);
			opt.disabled = true;
			opt.selected = true;
			select.appendChild(opt);
			for (const server of ctx.servers) {
				const disabled = document.createElement("option");
				disabled.value = "";
				disabled.disabled = true;
				disabled.textContent = `${formatRuntimeServerLabel(server)} — ${formatRuntimeServerReadiness(server)}`;
				select.appendChild(disabled);
			}
			return;
		}
		for (const server of readyServers) {
			const opt = document.createElement("option");
			opt.value = server.serverId;
			opt.textContent = formatRuntimeServerLabel(server);
			select.appendChild(opt);
		}
		select.value = readyServers[0]?.serverId ?? "";
		return;
	}

	for (const server of ctx.servers) {
		const opt = document.createElement("option");
		opt.value = server.serverId;
		opt.textContent = formatRuntimeServerLabel(server);
		select.appendChild(opt);
	}

	if (includeEmpty) {
		const opt = document.createElement("option");
		opt.value = "";
		opt.textContent = "Nearzero (Default)";
		select.appendChild(opt);
	}

	if (ctx.servers.length === 0 || !includeEmpty) {
		const nearzero = document.createElement("option");
		nearzero.value = "nearzero";
		nearzero.textContent = "Nearzero (local)";
		select.appendChild(nearzero);
	}

	if (ctx.servers.length > 0) {
		select.value = ctx.servers[0]?.serverId ?? "";
	} else if (!includeEmpty) {
		select.value = "nearzero";
	}
}

function requireCloudServer(ctx: LauncherContext, serverId: string | undefined) {
	if (ctx.isCommunity) return null;
	if (serverId) return null;
	return runtimeServerRequirementMessage(ctx.servers);
}

function showServerField(container: HTMLElement | null, show: boolean) {
	if (!container) return;
	container.classList.toggle("hidden", !show);
}

function setDialogError(el: HTMLElement | null, message: string) {
	if (!el) return;
	if (message) {
		el.textContent = message;
		el.classList.remove("hidden");
	} else {
		el.textContent = "";
		el.classList.add("hidden");
	}
}

function bindNameToAppName(
	nameInput: HTMLInputElement,
	appNameInput: HTMLInputElement,
	projectSlug: string,
	signal: AbortSignal,
) {
	nameInput.addEventListener(
		"input",
		() => {
			const serviceName = slugify(nameInput.value.trim());
			appNameInput.value = serviceName ?
				`${projectSlug}-${serviceName}`
			:	`${projectSlug}-`;
		},
		{ signal },
	);
}

function updateDatabaseFields(type: string) {
	const show = (id: string, visible: boolean) => {
		const el = document.getElementById(id);
		if (el) el.classList.toggle("hidden", !visible);
	};

	show("nz-env-db-database-name-wrap", ["postgres", "mysql", "mariadb"].includes(type));
	show("nz-env-db-database-user-wrap", type !== "redis");
	show("nz-env-db-root-password-wrap", ["mysql", "mariadb"].includes(type));
	show("nz-env-db-sqld-node-wrap", type === "libsql");
	show("nz-env-db-sqld-primary-wrap", type === "libsql");
	show("nz-env-db-namespaces-wrap", type === "libsql");
	show("nz-env-db-replica-wrap", type === "mongo");

	const sqldNode = (
		document.getElementById("nz-env-db-sqld-node") as HTMLSelectElement | null
	)?.value;
	show(
		"nz-env-db-sqld-primary-wrap",
		type === "libsql" && sqldNode === "replica",
	);

	const dockerImage = document.getElementById(
		"nz-env-db-docker-image",
	) as HTMLInputElement | null;
	if (dockerImage) {
		dockerImage.placeholder = `Default ${DB_DOCKER_DEFAULTS[type] ?? ""}`;
	}
}

function openDatabaseDialog(ctx: LauncherContext) {
	openDialog("nz-env-db-dialog");
	const form = document.getElementById("nz-env-db-form");
	const errEl = document.getElementById("nz-env-db-error");
	const appNameInput = document.getElementById(
		"nz-env-db-appname",
	) as HTMLInputElement | null;
	if (form instanceof HTMLFormElement) {
		form.reset();
		const postgresRadio = form.querySelector<HTMLInputElement>(
			"input[name='dbType'][value='postgres']",
		);
		if (postgresRadio) postgresRadio.checked = true;
	}
	if (appNameInput) appNameInput.value = `${ctx.projectSlug}-`;

	// Populate the server select on open (after form.reset, which clears the
	// JS-set selection) so the options are always present and visible. The field
	// is shown whenever we are in cloud mode or at least one server exists.
	const serverWrap = document.getElementById("nz-env-db-server-wrap");
	const serverSelect = document.getElementById(
		"nz-env-db-server",
	) as HTMLSelectElement | null;
	const showServer = !ctx.isCommunity || ctx.servers.length > 0;
	showServerField(serverWrap, showServer);
	if (serverSelect && showServer) {
		fillServerSelect(serverSelect, ctx);
	}

	updateDatabaseFields("postgres");
	setDialogError(errEl, "");
	setDbSubmitBusy(false);
}

function setDbSubmitBusy(busy: boolean) {
	const submitBtn = document.getElementById(
		"nz-env-db-submit-btn",
	) as HTMLButtonElement | null;
	const cancelBtn = document.querySelector<HTMLButtonElement>(
		"#nz-env-db-dialog [data-nz-modal-close]",
	);
	const form = document.getElementById("nz-env-db-form") as HTMLFormElement | null;

	if (submitBtn) {
		submitBtn.disabled = busy;
		submitBtn.setAttribute("aria-busy", busy ? "true" : "false");
		setButtonLoadingVisuals(submitBtn, busy);
	}
	if (cancelBtn) cancelBtn.disabled = busy;
	if (form) {
		for (const el of form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>(
			"input, textarea, select, button",
		)) {
			if (el.id === "nz-env-db-submit-btn") continue;
			el.disabled = busy;
		}
	}
}

function bindDatabaseDialog(
	root: HTMLElement,
	ctx: LauncherContext,
	signal: AbortSignal,
) {
	const dlg = document.getElementById("nz-env-db-dialog");
	const form = document.getElementById("nz-env-db-form");
	const errEl = document.getElementById("nz-env-db-error");
	const serverWrap = document.getElementById("nz-env-db-server-wrap");
	const serverSelect = document.getElementById(
		"nz-env-db-server",
	) as HTMLSelectElement | null;
	const nameInput = document.getElementById(
		"nz-env-db-name",
	) as HTMLInputElement | null;
	const appNameInput = document.getElementById(
		"nz-env-db-appname",
	) as HTMLInputElement | null;

	if (
		!(dlg instanceof HTMLDialogElement) ||
		!(form instanceof HTMLFormElement) ||
		!nameInput ||
		!appNameInput
	) {
		return;
	}

	showServerField(serverWrap, !ctx.isCommunity || ctx.servers.length > 0);
	if (serverSelect && (!ctx.isCommunity || ctx.servers.length > 0)) {
		fillServerSelect(serverSelect, ctx);
	}

	for (const radio of form.querySelectorAll<HTMLInputElement>(
		"input[name='dbType']",
	)) {
		radio.addEventListener("change", () => updateDatabaseFields(radio.value), {
			signal,
		});
	}

	const sqldNode = document.getElementById("nz-env-db-sqld-node");
	sqldNode?.addEventListener(
		"change",
		() => {
			const type =
				form.querySelector<HTMLInputElement>("input[name='dbType']:checked")
					?.value ?? "postgres";
			updateDatabaseFields(type);
		},
		{ signal },
	);

	bindNameToAppName(nameInput, appNameInput, ctx.projectSlug, signal);

	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		setDialogError(errEl, "");

		const type =
			form.querySelector<HTMLInputElement>("input[name='dbType']:checked")?.value ??
			"postgres";
		const name = nameInput.value.trim();
		const appName = appNameInput.value.trim();
		const description =
			(document.getElementById("nz-env-db-description") as HTMLTextAreaElement | null)
				?.value ?? "";
		const databasePassword =
			(document.getElementById("nz-env-db-password") as HTMLInputElement | null)
				?.value ?? "";
		const dockerImage =
			(document.getElementById("nz-env-db-docker-image") as HTMLInputElement | null)
				?.value.trim() ||
			DB_DOCKER_DEFAULTS[type] ||
			"";

		if (!name) {
			setDialogError(errEl, "Name is required");
			return;
		}
		if (!appName || !isValidAppName(appName)) {
			setDialogError(errEl, APP_NAME_MESSAGE);
			return;
		}

		const serverId = normalizeServerId(serverSelect?.value);
		const serverErr = requireCloudServer(ctx, serverId);
		if (serverErr) {
			setDialogError(errEl, serverErr);
			return;
		}

		const commonParams = {
			name,
			appName,
			dockerImage,
			serverId,
			environmentId: ctx.environmentId,
			description,
		};

		const submitBtn = document.getElementById(
			"nz-env-db-submit-btn",
		) as HTMLButtonElement | null;
		if (submitBtn?.getAttribute("aria-busy") === "true") return;

		setDbSubmitBusy(true);
		let keepLocked = false;
		let created: unknown = null;
		try {
			if (type === "libsql") {
				const sqldNodeVal =
					(document.getElementById("nz-env-db-sqld-node") as HTMLSelectElement | null)
						?.value ?? "primary";
				created = await trpcMutate("libsql.create", {
					...commonParams,
					sqldNode: sqldNodeVal,
					sqldPrimaryUrl:
						sqldNodeVal === "replica" ?
							(
								document.getElementById(
									"nz-env-db-sqld-primary",
								) as HTMLInputElement | null
							)?.value ?? null
						:	null,
					enableNamespaces:
						(
							document.getElementById(
								"nz-env-db-namespaces",
							) as HTMLSelectElement | null
						)?.value === "true",
					databasePassword,
					databaseUser:
						(document.getElementById("nz-env-db-database-user") as HTMLInputElement | null)
							?.value.trim() || DB_USER_DEFAULTS.libsql,
				});
			} else if (type === "mariadb") {
				created = await trpcMutate("mariadb.create", {
					...commonParams,
					databasePassword,
					databaseRootPassword:
						(document.getElementById("nz-env-db-root-password") as HTMLInputElement | null)
							?.value ?? "",
					databaseName:
						(document.getElementById("nz-env-db-database-name") as HTMLInputElement | null)
							?.value.trim() || "mariadb",
					databaseUser:
						(document.getElementById("nz-env-db-database-user") as HTMLInputElement | null)
							?.value.trim() || DB_USER_DEFAULTS.mariadb,
				});
			} else if (type === "mongo") {
				created = await trpcMutate("mongo.create", {
					...commonParams,
					databasePassword,
					databaseUser:
						(document.getElementById("nz-env-db-database-user") as HTMLInputElement | null)
							?.value.trim() || DB_USER_DEFAULTS.mongo,
					replicaSets:
						(
							document.getElementById(
								"nz-env-db-replica",
							) as HTMLInputElement | null
						)?.checked ?? false,
				});
			} else if (type === "mysql") {
				created = await trpcMutate("mysql.create", {
					...commonParams,
					databasePassword,
					databaseRootPassword:
						(document.getElementById("nz-env-db-root-password") as HTMLInputElement | null)
							?.value ?? "",
					databaseName:
						(document.getElementById("nz-env-db-database-name") as HTMLInputElement | null)
							?.value.trim() || "mysql",
					databaseUser:
						(document.getElementById("nz-env-db-database-user") as HTMLInputElement | null)
							?.value.trim() || DB_USER_DEFAULTS.mysql,
				});
			} else if (type === "postgres") {
				created = await trpcMutate("postgres.create", {
					...commonParams,
					databasePassword,
					databaseName:
						(document.getElementById("nz-env-db-database-name") as HTMLInputElement | null)
							?.value.trim() || "postgres",
					databaseUser:
						(document.getElementById("nz-env-db-database-user") as HTMLInputElement | null)
							?.value.trim() || DB_USER_DEFAULTS.postgres,
				});
			} else if (type === "redis") {
				created = await trpcMutate("redis.create", {
					...commonParams,
					databasePassword,
				});
			}

			toast("Database Created", "success");

			const deployInfo = DB_DEPLOY_INFO[type];
			const newId =
				deployInfo && created && typeof created === "object"
					? (created as Record<string, unknown>)[deployInfo.idField]
					: undefined;

			keepLocked = true;
			if (deployInfo && typeof newId === "string" && newId) {
				// Kick off the deployment so the database starts running, then send
				// the user to its detail page where the full deploy/logs/terminal UI
				// lives. We fire the deploy without awaiting so navigation is instant;
				// the detail page surfaces the live status and logs.
				void trpcMutate(`${deployInfo.router}.deploy`, {
					[deployInfo.idField]: newId,
				}).catch(() => {});
				closeDialog("nz-env-db-dialog");
				window.location.assign(
					`/dashboard/project/${ctx.projectId}/environment/${ctx.environmentId}/services/${deployInfo.pathSegment}/${newId}`,
				);
			} else {
				// No deploy target resolved; fall back to the prior close + refresh.
				closeDialog("nz-env-db-dialog");
				window.location.reload();
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Error creating a database";
			setDialogError(errEl, msg);
			toast("Error creating a database", "error");
		} finally {
			if (!keepLocked) setDbSubmitBusy(false);
		}
	}, { signal });
}

function renderTemplates(
	grid: HTMLElement,
	templates: TemplateItem[],
	baseUrl: string,
	onCreate: (template: TemplateItem) => void,
) {
	grid.replaceChildren();
	for (const template of templates) {
		const card = document.createElement("article");
		card.className =
			"flex flex-col rounded-lg border overflow-hidden h-[320px]";

		const logoUrl = `${baseUrl || "https://templates.nearzero.dev/"}/blueprints/${template.id}/${template.logo ?? ""}`;
		card.innerHTML = `
			<div class="flex flex-none flex-col items-center gap-3 border-b bg-muted/30 p-4">
				<img src="${logoUrl}" alt="" class="size-16 object-contain" loading="lazy" />
				<div class="text-center">
					<p class="text-sm font-medium line-clamp-1">${template.name}</p>
					${
						template.version ?
							`<span class="mt-1 inline-flex rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium">${template.version}</span>`
						:	""
					}
				</div>
			</div>
			<div class="flex-1 overflow-y-auto p-4 text-sm text-muted-foreground">${template.description ?? ""}</div>
			<div class="flex-none border-t bg-muted/30 p-3">
				<button type="button" class="w-full rounded-md bg-secondary px-3 py-2 text-xs font-medium" data-template-create>Create</button>
			</div>
		`;

		card.querySelector("[data-template-create]")?.addEventListener("click", () => {
			onCreate(template);
		});
		grid.appendChild(card);
	}
}

function bindTemplateDialog(
	root: HTMLElement,
	ctx: LauncherContext,
	signal: AbortSignal,
) {
	const dlg = document.getElementById("nz-env-template-dialog");
	const confirmDlg = document.getElementById("nz-env-template-confirm-dialog");
	const searchInput = document.getElementById(
		"nz-env-template-search",
	) as HTMLInputElement | null;
	const baseUrlInput = document.getElementById(
		"nz-env-template-base-url",
	) as HTMLInputElement | null;
	const grid = document.getElementById("nz-env-template-grid");
	const loadingEl = document.getElementById("nz-env-template-loading");
	const emptyEl = document.getElementById("nz-env-template-empty");
	const errEl = document.getElementById("nz-env-template-error");
	const confirmTitle = document.getElementById("nz-env-template-confirm-title");
	const confirmDesc = document.getElementById("nz-env-template-confirm-desc");
	const confirmErr = document.getElementById("nz-env-template-confirm-error");
	const confirmRun = document.getElementById("nz-env-template-confirm-run");
	const serverWrap = document.getElementById("nz-env-template-server-wrap");
	const serverSelect = document.getElementById(
		"nz-env-template-server",
	) as HTMLSelectElement | null;

	if (
		!(dlg instanceof HTMLDialogElement) ||
		!(confirmDlg instanceof HTMLDialogElement) ||
		!grid ||
		!confirmRun
	) {
		return;
	}

	showServerField(serverWrap, !ctx.isCommunity || ctx.servers.length > 0);
	if (serverSelect && (!ctx.isCommunity || ctx.servers.length > 0)) {
		fillServerSelect(serverSelect, ctx);
	}

	let allTemplates: TemplateItem[] = [];
	let pendingTemplate: TemplateItem | null = null;

	const getBaseUrl = () => {
		const fromInput = baseUrlInput?.value.trim();
		if (fromInput) return fromInput;
		return localStorage.getItem(TEMPLATE_BASE_URL_KEY) ?? undefined;
	};

	const applyFilter = () => {
		const query = searchInput?.value.trim().toLowerCase() ?? "";
		const filtered = allTemplates.filter((template) => {
			if (!query) return true;
			return (
				template.name.toLowerCase().includes(query) ||
				(template.description ?? "").toLowerCase().includes(query)
			);
		});

		loadingEl?.classList.add("hidden");
		if (filtered.length === 0) {
			grid.classList.add("hidden");
			emptyEl?.classList.remove("hidden");
			return;
		}
		emptyEl?.classList.add("hidden");
		grid.classList.remove("hidden");
		renderTemplates(grid, filtered, getBaseUrl() ?? "", (template) => {
			pendingTemplate = template;
			if (confirmTitle) {
				confirmTitle.textContent = `Create ${template.name}?`;
			}
			if (confirmDesc) {
				confirmDesc.textContent = `This will create an application from the ${template.name} template and add it to your project.`;
			}
			setDialogError(confirmErr, "");
			openDialog("nz-env-template-confirm-dialog");
		});
	};

	const loadTemplates = async () => {
		setDialogError(errEl, "");
		loadingEl?.classList.remove("hidden");
		grid.classList.add("hidden");
		emptyEl?.classList.add("hidden");

		const baseUrl = getBaseUrl();
		if (baseUrl) {
			localStorage.setItem(TEMPLATE_BASE_URL_KEY, baseUrl);
		} else {
			localStorage.removeItem(TEMPLATE_BASE_URL_KEY);
		}

		try {
			allTemplates = await trpcQuery<TemplateItem[]>("compose.templates", {
				baseUrl,
			});
			applyFilter();
		} catch (err) {
			loadingEl?.classList.add("hidden");
			const msg =
				err instanceof Error ? err.message : "Failed to load templates";
			setDialogError(errEl, msg);
		}
	};

	openTemplateDialog = () => {
		if (baseUrlInput && !baseUrlInput.value) {
			baseUrlInput.value = localStorage.getItem(TEMPLATE_BASE_URL_KEY) ?? "";
		}
		openDialog("nz-env-template-dialog");
		void loadTemplates();
	};

	searchInput?.addEventListener("input", applyFilter, { signal });
	baseUrlInput?.addEventListener("change", () => void loadTemplates(), { signal });

	confirmRun.addEventListener("click", async () => {
		if (!pendingTemplate) return;
		setDialogError(confirmErr, "");
		(confirmRun as HTMLButtonElement).disabled = true;
		try {
			const serverId = normalizeServerId(serverSelect?.value);
			const serverErr = requireCloudServer(ctx, serverId);
			if (serverErr) {
				setDialogError(confirmErr, serverErr);
				return;
			}
			await trpcMutate("compose.deployTemplate", {
				serverId,
				environmentId: ctx.environmentId,
				id: pendingTemplate.id,
				baseUrl: getBaseUrl(),
			});
			toast(`${pendingTemplate.name} template created successfully`, "success");
			closeDialog("nz-env-template-confirm-dialog");
			closeDialog("nz-env-template-dialog");
			window.location.reload();
		} catch (err) {
			const msg =
				err instanceof Error ?
					err.message
				:	`An error occurred deploying ${pendingTemplate.name} template`;
			setDialogError(confirmErr, msg);
			toast(`An error occurred deploying ${pendingTemplate.name} template`, "error");
		} finally {
			(confirmRun as HTMLButtonElement).disabled = false;
		}
	}, { signal });
}

function openDomainDialog(ctx: LauncherContext) {
	if (document.getElementById("nz-add-hostname-dialog")) {
		openAddHostnameDialog();
		const connectToggle = document.getElementById(
			"nz-add-hostname-connect",
		) as HTMLInputElement | null;
		const connectFields = document.getElementById("nz-add-hostname-connect-fields");
		if (connectToggle) {
			connectToggle.checked = true;
			connectFields?.classList.remove("hidden");
		}
		return;
	}
	openDialog("nz-env-domain-dialog");
	const form = document.getElementById("nz-env-domain-form");
	const errEl = document.getElementById("nz-env-domain-error");
	if (form instanceof HTMLFormElement) {
		form.reset();
	}
	const portInput = document.getElementById(
		"nz-env-domain-port",
	) as HTMLInputElement | null;
	const pathInput = document.getElementById(
		"nz-env-domain-path",
	) as HTMLInputElement | null;
	const httpsInput = document.getElementById(
		"nz-env-domain-https",
	) as HTMLInputElement | null;
	const certSelect = document.getElementById(
		"nz-env-domain-certificate",
	) as HTMLSelectElement | null;
	if (portInput) portInput.value = "3000";
	if (pathInput) pathInput.value = "/";
	if (httpsInput) httpsInput.checked = true;
	if (certSelect) certSelect.value = "letsencrypt";
	setDialogError(
		errEl,
		ctx.services.length === 0
			? "Create an application or compose service before adding a domain."
			: "",
	);
}

function bindDomainDialog(
	root: HTMLElement,
	ctx: LauncherContext,
	signal: AbortSignal,
) {
	const form = document.getElementById("nz-env-domain-form");
	const errEl = document.getElementById("nz-env-domain-error");
	const serviceSelect = document.getElementById(
		"nz-env-domain-service",
	) as HTMLSelectElement | null;
	const hostInput = document.getElementById(
		"nz-env-domain-host",
	) as HTMLInputElement | null;
	const portInput = document.getElementById(
		"nz-env-domain-port",
	) as HTMLInputElement | null;
	const pathInput = document.getElementById(
		"nz-env-domain-path",
	) as HTMLInputElement | null;
	const httpsInput = document.getElementById(
		"nz-env-domain-https",
	) as HTMLInputElement | null;
	const certificateSelect = document.getElementById(
		"nz-env-domain-certificate",
	) as HTMLSelectElement | null;
	const autoWrap = document.getElementById("nz-env-domain-auto-wrap");
	const autoInput = document.getElementById(
		"nz-env-domain-auto",
	) as HTMLInputElement | null;
	const previewEl = document.getElementById("nz-env-domain-managed-preview");
	const edgeIpEl = document.getElementById("nz-env-domain-edge-ip");

	let domainPreview: PreviewServiceDomainResult | null = null;
	let previewTimer: ReturnType<typeof setTimeout> | null = null;

	async function refreshDomainPreview() {
		const [domainType, serviceId] = serviceSelect?.value.split(":") ?? [];
		const service = ctx.services.find(
			(item) => item.id === serviceId && item.type === domainType,
		);
		if (!service) {
			domainPreview = null;
			if (previewEl) {
				previewEl.classList.add("hidden");
				previewEl.textContent = "";
			}
			autoWrap?.classList.add("hidden");
			return;
		}
		try {
			domainPreview = await previewServiceDomain({
				environmentId: ctx.environmentId,
				serviceName: service.name,
				serverId: service.serverId ?? undefined,
			});
		} catch {
			domainPreview = null;
		}
		if (previewEl) {
			if (domainPreview?.enabled && domainPreview.host) {
				previewEl.classList.remove("hidden");
				previewEl.textContent = `Suggested hostname: ${domainPreview.host}`;
				autoWrap?.classList.remove("hidden");
				if (autoInput?.checked && hostInput) {
					hostInput.value = domainPreview.host;
					hostInput.readOnly = true;
				}
			} else {
				previewEl.classList.add("hidden");
				previewEl.textContent = "";
				autoWrap?.classList.add("hidden");
				if (hostInput) hostInput.readOnly = false;
			}
		}
	}

	function scheduleDomainPreview() {
		if (previewTimer) clearTimeout(previewTimer);
		previewTimer = setTimeout(() => {
			void refreshDomainPreview();
		}, 250);
	}

	if (
		!(form instanceof HTMLFormElement) ||
		!serviceSelect ||
		!hostInput ||
		!portInput
	) {
		return;
	}

	serviceSelect.addEventListener("change", scheduleDomainPreview, { signal });
	autoInput?.addEventListener(
		"change",
		() => {
			if (autoInput.checked && domainPreview?.host && hostInput) {
				hostInput.value = domainPreview.host;
				hostInput.readOnly = true;
			} else if (hostInput) {
				hostInput.readOnly = false;
			}
		},
		{ signal },
	);

	hostInput.addEventListener(
		"input",
		async () => {
			if (autoInput?.checked) return;
			const host = hostInput.value.trim();
			if (!host || !edgeIpEl) return;
			try {
				const [domainType, serviceId] = serviceSelect?.value.split(":") ?? [];
				const service = ctx.services.find(
					(item) => item.id === serviceId && item.type === domainType,
				);
				const ip = await trpcQuery<string>("domain.canGenerateTraefikMeDomains", {
					serverId: service?.serverId ?? undefined,
				});
				edgeIpEl.classList.remove("hidden");
				edgeIpEl.textContent = ip
					? "DNS validation target is available for this service."
					: "DNS validation target is not configured yet.";
			} catch {
				edgeIpEl.classList.add("hidden");
			}
		},
		{ signal },
	);

	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		setDialogError(errEl, "");

		const [domainType, serviceId] = serviceSelect.value.split(":");
		const host = hostInput.value.trim();
		const port = Number.parseInt(portInput.value, 10);
		const path = pathInput?.value.trim() || "/";
		if (
			(domainType !== "application" && domainType !== "compose") ||
			!serviceId
		) {
			setDialogError(errEl, "Select a service.");
			return;
		}
		if (!host) {
			setDialogError(errEl, "Host is required.");
			return;
		}
		if (!Number.isFinite(port) || port < 1 || port > 65535) {
			setDialogError(errEl, "Enter a valid port.");
			return;
		}

		const submitBtn = form.querySelector(
			"button[type='submit']",
		) as HTMLButtonElement | null;
		if (submitBtn) submitBtn.disabled = true;

		try {
			const service = ctx.services.find(
				(item) => item.id === serviceId && item.type === domainType,
			);
			const useAuto = autoInput?.checked && domainPreview?.enabled;

			if (useAuto && service) {
				await provisionServiceDomain({
					environmentId: ctx.environmentId,
					serviceName: service.name,
					port,
					path,
					serverId: service.serverId ?? undefined,
					domainType,
					...(domainType === "application"
						? { applicationId: serviceId }
						: { composeId: serviceId }),
				});
			} else {
				const check = await validateDomainWithEdgeIp({
					domain: host,
					serverId: service?.serverId ?? undefined,
				});
				if (!check.isValid) {
					setDialogError(
						errEl,
						check.error ??
							"Domain does not resolve to the configured routing target.",
					);
					return;
				}
				await trpcMutate("domain.create", {
					host,
					port,
					path,
					https: httpsInput?.checked ?? true,
					certificateType: certificateSelect?.value ?? "letsencrypt",
					domainType,
					...(domainType === "application"
						? { applicationId: serviceId }
						: { composeId: serviceId }),
				});
			}
			toast("Domain added", "success");
			closeDialog("nz-env-domain-dialog");
			window.location.reload();
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Error adding domain";
			setDialogError(errEl, msg);
			toast(msg, "error");
		} finally {
			if (submitBtn) submitBtn.disabled = false;
		}
	}, { signal });
}

function bindDialogClosers(signal: AbortSignal) {
	for (const dlg of document.querySelectorAll<HTMLDialogElement>(
		"dialog[data-env-dialog]",
	)) {
		dlg.addEventListener(
			"cancel",
			(event) => {
				event.preventDefault();
				closeNzDialog(dlg.id);
			},
			{ signal },
		);
		dlg.addEventListener(
			"click",
			(event) => {
				const target = event.target instanceof Element ? event.target : null;
				if (target?.closest("[data-env-dialog-close], [data-nz-modal-close]")) {
					event.preventDefault();
					closeNzDialog(dlg.id);
				}
			},
			{ signal },
		);
	}
}

export function bindEnvironmentServiceLauncher() {
	launcherAbort?.abort();
	launcherAbort = new AbortController();
	const { signal } = launcherAbort;

	bindEnvDialogOpenHandlers(signal);
	bindDialogClosers(signal);

	const root = document.querySelector<HTMLElement>("[data-env-service-root]");
	if (!root) return;

	const ctx = readContext(root);
	if (!ctx) return;

	bindDatabaseDialog(root, ctx, signal);
	bindTemplateDialog(root, ctx, signal);
	bindDomainDialog(root, ctx, signal);
}
