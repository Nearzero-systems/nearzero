import { APP_NAME_MESSAGE, isValidAppName } from "@/lib/app-name";
import { setButtonLoadingVisuals } from "@/lib/auth-button-state";
import { trpcMutate, trpcQuery } from "@/lib/client-api";
import {
	buildSaveProviderInput,
	fetchBitbucketBranches,
	fetchBitbucketRepositories,
	fetchGithubBranches,
	fetchGithubDetectedApps,
	fetchGithubRepositories,
	fetchGitlabBranches,
	fetchGitlabRepositories,
	fetchGiteaBranches,
	fetchGiteaRepositories,
	formatEnvBlock,
	parseEnvBlock,
	resolvePublicGitDefaultBranch,
	type BitbucketRepoOption,
	type DetectedRepositoryApp,
	type GiteaRepoOption,
	type GitProviderKind,
	type GithubRepoOption,
	type GitlabRepoOption,
	type RepoOptionJson,
} from "@/lib/git-application-source";
import { environmentApplicationHref } from "@/lib/project-workspace-nav";
import {
	previewServiceDomain,
	provisionServiceDomain,
	type PreviewServiceDomainResult,
} from "@/lib/managed-domain-client";
import { slugify } from "@/lib/slug";
import { NZ_TOAST_EVENT } from "@/lib/nzToast";
import type { ProviderOption } from "@/components/dashboard/projects/shared";
import {
	formatRuntimeServerLabel,
	formatRuntimeServerReadiness,
	listReadyRuntimeServers,
	runtimeServerPlaceholder,
	runtimeServerRequirementMessage,
	type RuntimeServerOption,
} from "@/lib/runtime-server-options";

type ServerOption = RuntimeServerOption;

type GitAccounts = {
	github: Array<{ id: string; label: string }>;
	gitlab: Array<{ id: string; label: string }>;
	bitbucket: Array<{ id: string; label: string }>;
	gitea: Array<{ id: string; label: string }>;
};

type WizardStep = "provider" | "repos" | "configure";

const WIZARD_STEPS: WizardStep[] = ["provider", "repos", "configure"];

type RepoListItem = {
	key: string;
	label: string;
	subtitle: string;
	isPrivate: boolean;
	payload: RepoOptionJson;
};

type WizardSourceMode = "provider" | "public";

type WizardState = {
	step: WizardStep;
	sourceMode: WizardSourceMode;
	provider: GitProviderKind | null;
	accountId: string | null;
	publicGitUrl: string;
	publicGitBranch: string;
	repos: RepoListItem[];
	repoPayload: RepoOptionJson | null;
	repoLabel: string;
	branch: string;
	buildPath: string;
	buildPathSource: "manual" | "detected" | "other";
	customInstallCommand: string;
	customBuildCommand: string;
	customStartCommand: string;
	detectedApps: DetectedRepositoryApp[];
	displayName: string;
	appName: string;
	description: string;
	serverId: string | undefined;
	managedDomain: boolean;
	domainPort: number;
	domainPreview: PreviewServiceDomainResult | null;
	envRows: { key: string; value: string }[];
};

type ImportPageContext = {
	projectId: string;
	environmentId: string;
	projectSlug: string;
	canDeploy: boolean;
	isCommunity: boolean;
	servers: ServerOption[];
	dnsZoneId?: string;
	domainPrefix?: string;
	environmentName?: string;
	isProduction: boolean;
	zoneName?: string;
	pageHref: string;
};

type ImportDeploymentFollow = {
	state: "queued" | "running" | "done" | "error" | "cancelled" | string;
	message?: string | null;
	applicationStatus?: string | null;
	queue?: {
		id?: string;
		state?: string;
		failedReason?: string;
	} | null;
	deployment?: {
		deploymentId?: string | null;
		status?: string | null;
		title?: string | null;
		description?: string | null;
		errorMessage?: string | null;
	} | null;
	logsAvailable?: boolean;
	retryAfterMs?: number | null;
};

let mountAbort: AbortController | null = null;

// Astro <ViewTransitions /> swaps the DOM without a full page unload, so the
// deployment-progress poll loop must be aborted on navigation. Otherwise it
// keeps hitting deployment.followApplication after you leave the
// import page (boot() only re-runs on pages that still have the import root).
if (typeof document !== "undefined") {
	document.addEventListener("astro:before-swap", () => {
		mountAbort?.abort();
		mountAbort = null;
	});
}

function toast(message: string, variant?: "success" | "error") {
	document.dispatchEvent(
		new CustomEvent(NZ_TOAST_EVENT, {
			bubbles: true,
			detail: { message, variant },
		}),
	);
}

function parseJson<T>(id: string, fallback: T): T {
	const el = document.getElementById(id);
	if (!el?.textContent) return fallback;
	try {
		return JSON.parse(el.textContent) as T;
	} catch {
		return fallback;
	}
}

function readContext(root: HTMLElement): ImportPageContext | null {
	const projectId = root.dataset.projectId?.trim() ?? "";
	const environmentId = root.dataset.environmentId?.trim() ?? "";
	const projectSlug = root.dataset.projectSlug?.trim() ?? "";
	if (!projectId || !environmentId) return null;

	return {
		projectId,
		environmentId,
		projectSlug,
		canDeploy: root.dataset.canDeploy === "1",
		isCommunity: root.dataset.community !== "0",
		servers: parseJson<ServerOption[]>("nz-app-import-servers-json", []),
		dnsZoneId: root.dataset.dnsZoneId?.trim() || undefined,
		domainPrefix: root.dataset.domainPrefix?.trim() || undefined,
		environmentName: root.dataset.environmentName?.trim() || undefined,
		isProduction: root.dataset.isProduction === "1",
		zoneName: root.dataset.zoneName?.trim() || undefined,
		pageHref: root.dataset.pageHref?.trim() ?? window.location.pathname,
	};
}

function normalizeServerId(value: string | undefined) {
	if (!value || value === "nearzero") return undefined;
	return value;
}

function setError(el: HTMLElement | null, message: string) {
	if (!el) return;
	if (message) {
		el.textContent = message;
		el.classList.remove("hidden");
	} else {
		el.textContent = "";
		el.classList.add("hidden");
	}
}

function oauthStartUrl(provider: GitProviderKind, callbackUrl: string) {
	const url = new URL("/dashboard/settings/git-providers", window.location.origin);
	url.searchParams.set("connect", provider);
	url.searchParams.set("returnTo", callbackUrl);
	return `${url.pathname}${url.search}`;
}

function accountsForProvider(
	accounts: GitAccounts,
	provider: GitProviderKind,
): Array<{ id: string; label: string }> {
	return accounts[provider] ?? [];
}

function defaultAppName(projectSlug: string, repoName: string) {
	const slug = slugify(repoName);
	return slug ? `${projectSlug}-${slug}` : `${projectSlug}-`;
}

function parsePublicGitUrl(raw: string): { url: string; repoName: string } | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;

	const ssh = /^git@([^:]+):(.+)$/i.exec(trimmed);
	if (ssh) {
		const path = ssh[2].replace(/\.git$/i, "");
		const segments = path.split("/").filter(Boolean);
		const repoName = segments[segments.length - 1];
		if (!repoName) return null;
		return { url: trimmed, repoName };
	}

	try {
		const withScheme = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
		const parsed = new URL(withScheme);
		const segments = parsed.pathname.split("/").filter(Boolean);
		if (segments.length < 2) return null;
		const repoName = segments[segments.length - 1].replace(/\.git$/i, "");
		if (!repoName) return null;
		return { url: trimmed, repoName };
	} catch {
		return null;
	}
}

function createInitialState(ctx: ImportPageContext): WizardState {
	return {
		step: "provider",
		sourceMode: "provider",
		provider: null,
		publicGitUrl: "",
		publicGitBranch: "main",
		accountId: null,
		repos: [],
		repoPayload: null,
		repoLabel: "",
		branch: "",
		buildPath: "/",
		buildPathSource: "manual",
		customInstallCommand: "",
		customBuildCommand: "",
		customStartCommand: "",
		detectedApps: [],
		displayName: "",
		appName: `${ctx.projectSlug}-`,
		description: "",
		serverId: undefined,
		managedDomain: Boolean(ctx.dnsZoneId && ctx.zoneName),
		domainPort: 3000,
		domainPreview: null as PreviewServiceDomainResult | null,
		envRows: [{ key: "", value: "" }],
	};
}

export function mountApplicationImportPage(root: HTMLElement) {
	mountAbort?.abort();
	mountAbort = new AbortController();
	const { signal } = mountAbort;

	const pageCtx = readContext(root);
	if (!pageCtx) return;
	const ctx = pageCtx;

	const accounts = parseJson<GitAccounts>("nz-app-import-providers-json", {
		github: [],
		gitlab: [],
		bitbucket: [],
		gitea: [],
	});
	const providerOptions = parseJson<ProviderOption[]>(
		"nz-app-import-provider-options-json",
		[],
	);

	let state = createInitialState(ctx);
	let repoFetchGen = 0;
	let detectionGen = 0;

	const errEl = document.getElementById("nz-app-import-error");
	const titleEl = document.getElementById("nz-app-import-title");
	const emptyToggleBtn = root.querySelector<HTMLButtonElement>(
		"[data-app-import-empty-toggle]",
	);
	const gitPanel = root.querySelector<HTMLElement>("[data-app-import-git-panel]");
	const emptyPanel = root.querySelector<HTMLElement>("[data-app-import-empty-panel]");
	const progressRoot = root.querySelector<HTMLElement>("[data-app-import-progress]");
	const buildPanel = root.querySelector<HTMLElement>("[data-app-import-build-panel]");
	const buildStatus = root.querySelector<HTMLElement>("[data-app-import-build-status]");
	const buildMessage = root.querySelector<HTMLElement>("[data-app-import-build-message]");
	const buildLogs = root.querySelector<HTMLElement>("[data-app-import-build-logs]");
	const buildServiceLink = root.querySelector<HTMLAnchorElement>(
		"[data-app-import-build-service]",
	);
	const stepIndicators = root.querySelectorAll<HTMLElement>("[data-step-indicator]");
	const connectCta = document.getElementById("nz-app-import-connect-cta");
	const connectMsg = connectCta?.querySelector("[data-app-import-connect-msg]");
	const accountSelect = document.getElementById(
		"nz-app-import-account",
	) as HTMLSelectElement | null;
	const repoSearch = document.getElementById(
		"nz-app-import-repo-search",
	) as HTMLInputElement | null;
	const reposStatus = document.getElementById("nz-app-import-repos-status");
	const reposLoading = document.getElementById("nz-app-import-repos-loading");
	const repoList = document.getElementById("nz-app-import-repo-list");
	const selectedRepoWrap = root.querySelector<HTMLElement>("[data-app-import-selected-repo-wrap]");
	const selectedRepoName = root.querySelector<HTMLElement>("[data-app-import-selected-repo-name]");
	const selectedRepoMeta = root.querySelector<HTMLElement>("[data-app-import-selected-repo-meta]");
	const publicUrlInput = document.getElementById(
		"nz-app-import-public-url",
	) as HTMLInputElement | null;
	const branchWrap = document.getElementById("nz-app-import-branch-wrap");
	const branchSelect = document.getElementById(
		"nz-app-import-branch",
	) as HTMLSelectElement | null;
	const branchTextInput = document.getElementById(
		"nz-app-import-branch-text",
	) as HTMLInputElement | null;
	const nameInput = document.getElementById("nz-app-import-name") as HTMLInputElement | null;
	const appNameInput = document.getElementById(
		"nz-app-import-appname",
	) as HTMLInputElement | null;
	const buildPathInput = document.getElementById(
		"nz-app-import-build-path",
	) as HTMLInputElement | null;
	const buildPathManualWrap = document.getElementById(
		"nz-app-import-build-path-manual-wrap",
	);
	const buildPathPickerWrap = document.getElementById(
		"nz-app-import-build-path-picker-wrap",
	);
	const buildPathPickerButton = document.getElementById(
		"nz-app-import-build-path-picker",
	) as HTMLButtonElement | null;
	const buildPathPickerLabel = buildPathPickerButton?.querySelector<HTMLElement>(
		"[data-build-path-picker-label]",
	) ?? null;
	const buildPathMenu = document.getElementById("nz-app-import-build-path-menu");
	const buildPathOtherWrap = document.getElementById(
		"nz-app-import-build-path-other-wrap",
	);
	const buildPathOtherInput = document.getElementById(
		"nz-app-import-build-path-other",
	) as HTMLInputElement | null;
	const buildPathOptions = document.getElementById(
		"nz-app-import-build-path-options",
	) as HTMLDataListElement | null;
	const detectedAppsEl = document.getElementById("nz-app-import-detected-apps");
	const customInstallCommandInput = document.getElementById(
		"nz-app-import-install-command",
	) as HTMLInputElement | null;
	const customBuildCommandInput = document.getElementById(
		"nz-app-import-build-command",
	) as HTMLInputElement | null;
	const customStartCommandInput = document.getElementById(
		"nz-app-import-start-command",
	) as HTMLInputElement | null;
	const descriptionInput = document.getElementById(
		"nz-app-import-description",
	) as HTMLTextAreaElement | null;
	const serverWrap = document.getElementById("nz-app-import-server-wrap");
	const serverSelect = document.getElementById(
		"nz-app-import-server",
	) as HTMLSelectElement | null;
	const domainPreviewEl = document.getElementById("nz-app-import-domain-preview");
	const managedPortWrap = document.getElementById("nz-app-import-managed-port-wrap");
	const managedPortInput = document.getElementById(
		"nz-app-import-managed-port",
	) as HTMLInputElement | null;
	const managedDomainWrap = document.getElementById("nz-app-import-managed-domain-wrap");
	const managedToggle = document.getElementById(
		"nz-app-import-managed-domain",
	) as HTMLInputElement | null;
	let domainPreviewTimer: ReturnType<typeof setTimeout> | null = null;
	const envRowsEl = document.getElementById("nz-app-import-env-rows");
	const envPaste = document.getElementById(
		"nz-app-import-env-paste",
	) as HTMLTextAreaElement | null;

	const emptyName = document.getElementById("nz-app-import-empty-name") as HTMLInputElement | null;
	const emptyAppName = document.getElementById(
		"nz-app-import-empty-appname",
	) as HTMLInputElement | null;
	const emptyDescription = document.getElementById(
		"nz-app-import-empty-description",
	) as HTMLTextAreaElement | null;
	const emptyServerWrap = document.getElementById("nz-app-import-empty-server-wrap");
	const emptyServerSelect = document.getElementById(
		"nz-app-import-empty-server",
	) as HTMLSelectElement | null;
	let importBuildLogs = "";
	const readyServers = listReadyRuntimeServers(ctx.servers);
	const cloudNeedsReadyServer = !ctx.isCommunity && readyServers.length === 0;
	const cloudServerRequiredMessage = runtimeServerRequirementMessage(ctx.servers);
	const configureSubmitButtons = root.querySelectorAll<HTMLButtonElement>(
		"[data-app-import-submit]",
	);
	const emptySubmitButton = root.querySelector<HTMLButtonElement>(
		"[data-app-import-empty-submit]",
	);

	function setImportSubmitBusy(button: HTMLButtonElement | null, busy: boolean) {
		if (!button) return;
		button.disabled = busy;
		button.setAttribute("aria-busy", busy ? "true" : "false");
		setButtonLoadingVisuals(button, busy);
	}

	function setCloudServerBlockedActions() {
		for (const btn of [...configureSubmitButtons, emptySubmitButton]) {
			if (!btn) continue;
			if (btn.getAttribute("aria-busy") === "true") continue;
			btn.disabled = cloudNeedsReadyServer;
			btn.setAttribute("aria-disabled", cloudNeedsReadyServer ? "true" : "false");
			if (cloudNeedsReadyServer) {
				btn.title = cloudServerRequiredMessage;
			} else {
				btn.removeAttribute("title");
			}
		}
	}

	function fillServerSelect(select: HTMLSelectElement, includeEmpty: boolean) {
		// Preserve any choice the user already made so re-rendering the select
		// (e.g. switching wizard panels) never silently reverts their server.
		const previous = select.value;
		select.replaceChildren();
		select.required = !ctx.isCommunity;
		if (!ctx.isCommunity) {
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
			// With more than one ready server, force a conscious choice via a
			// placeholder so a deploy never silently lands on an unintended
			// server. A single ready server is unambiguous, so preselect it.
			if (readyServers.length > 1) {
				const placeholder = document.createElement("option");
				placeholder.value = "";
				placeholder.textContent = "Select a server…";
				placeholder.disabled = true;
				select.appendChild(placeholder);
			}
			for (const server of readyServers) {
				const opt = document.createElement("option");
				opt.value = server.serverId;
				opt.textContent = formatRuntimeServerLabel(server);
				select.appendChild(opt);
			}
			const previousIsReady = readyServers.some(
				(server) => server.serverId === previous,
			);
			if (previousIsReady) {
				select.value = previous;
			} else if (readyServers.length === 1) {
				select.value = readyServers[0]?.serverId ?? "";
			} else {
				select.value = "";
			}
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
		const available = new Set(
			Array.from(select.options).map((option) => option.value),
		);
		if (previous && available.has(previous)) {
			select.value = previous;
		} else if (ctx.servers.length > 0) {
			select.value = ctx.servers[0]?.serverId ?? "";
		} else if (!includeEmpty) {
			select.value = "nearzero";
		}
	}

	function requireCloudServer(serverId: string | undefined) {
		if (ctx.isCommunity) return null;
		if (serverId) return null;
		return cloudServerRequiredMessage;
	}

	function showServerFields() {
		if (serverWrap && serverSelect) {
			serverWrap.classList.remove("hidden");
			fillServerSelect(serverSelect, false);
		}
		if (emptyServerWrap && emptyServerSelect) {
			emptyServerWrap.classList.remove("hidden");
			fillServerSelect(emptyServerSelect, false);
		}
	}

	showServerFields();
	setCloudServerBlockedActions();

	function setStep(step: WizardStep) {
		state.step = step;
		root.querySelectorAll<HTMLElement>("[data-app-import-step]").forEach((panel) => {
			const panelStep = panel.dataset.appImportStep as WizardStep | undefined;
			const isActive = panelStep === step;
			panel.classList.toggle("hidden", !isActive);
			panel.hidden = !isActive;
		});

		const stepIndex = WIZARD_STEPS.indexOf(step);
		stepIndicators.forEach((item) => {
			const key = item.dataset.stepIndicator as WizardStep | undefined;
			if (!key) return;
			const idx = WIZARD_STEPS.indexOf(key);
			item.dataset.active = idx === stepIndex ? "true" : "false";
			item.dataset.complete = idx < stepIndex ? "true" : "false";
			const isCurrent = idx === stepIndex;
			item.setAttribute("aria-current", isCurrent ? "step" : "false");
		});

		progressRoot?.classList.remove("hidden");
		setError(errEl, "");
	}

	function serviceHref(applicationId: string) {
		return environmentApplicationHref(ctx.projectId, ctx.environmentId, applicationId);
	}

	function setBuildStatus(status: string, message?: string) {
		const normalized = status.trim().toLowerCase() || "queued";
		const label =
			normalized === "done"
				? "Deployed"
				: normalized === "error"
					? "Failed"
					: normalized === "running"
						? "Building"
						: "Queued";
		if (buildStatus) {
			buildStatus.textContent = label;
			buildStatus.dataset.state =
				normalized === "done" ? "done" : normalized === "error" ? "error" : "running";
		}
		if (buildMessage && message) {
			buildMessage.textContent = message;
		}
	}

	function showBuildPanel(applicationId: string, liveHost: string | null) {
		root.dataset.appImportMode = "building";
		gitPanel?.classList.add("hidden");
		if (gitPanel) gitPanel.hidden = true;
		emptyPanel?.classList.add("hidden");
		if (emptyPanel) emptyPanel.hidden = true;
		progressRoot?.classList.add("hidden");
		buildPanel?.classList.remove("hidden");
		if (buildPanel) buildPanel.hidden = false;
		if (emptyToggleBtn) emptyToggleBtn.classList.add("hidden");
		if (buildServiceLink) {
			buildServiceLink.href = serviceHref(applicationId);
			buildServiceLink.classList.remove("hidden");
		}
		setBuildStatus("queued", "Deployment queued. Waiting for the build worker to start.");
		if (buildLogs) buildLogs.textContent = "Waiting for deployment worker...";
		scrollBuildLogsToEnd();
	}

	function normalizeBuildLogs(value: string) {
		return value
			.replace(/\r/g, "\n")
			.replace(/\/Users\/[^\s'"`]+\/Desktop\/[^\s'"`]+/g, "<workspace>")
			.replace(/\/private\/var\/folders\/[^\s'"`]+/g, "<temp>")
			.trim();
	}

	function scrollBuildLogsToEnd() {
		const viewport =
			root.querySelector<HTMLElement>("[data-app-import-build-logs-viewport]") ??
			buildLogs;
		if (!viewport) return;
		requestAnimationFrame(() => {
			viewport.scrollTop = viewport.scrollHeight;
		});
	}

	function renderBuildLogs(value: string) {
		importBuildLogs = normalizeBuildLogs(value);
		if (!buildLogs) return;
		buildLogs.textContent =
			importBuildLogs || "Build logs are not available yet. Still waiting...";
		scrollBuildLogsToEnd();
	}

	function sleep(ms: number) {
		return new Promise((resolve) => window.setTimeout(resolve, ms));
	}

	async function pollDeploymentProgress(
		applicationId: string,
		liveHost: string | null,
		jobId?: string | null,
	) {
		let currentDeploymentId = "";
		let statusFailures = 0;
		let missingQueueChecks = 0;
		for (let attempt = 0; attempt < 240 && !signal.aborted; attempt++) {
			try {
				const follow = await trpcQuery<ImportDeploymentFollow>("deployment.followApplication", {
					applicationId,
					jobId: jobId || undefined,
					deploymentId: currentDeploymentId || undefined,
				});
				statusFailures = 0;
				const latest = follow.deployment;
				if (!latest?.deploymentId) {
					missingQueueChecks = follow.queue ? 0 : missingQueueChecks + 1;
					const queueMessage =
						!follow.queue && missingQueueChecks >= 4
							? "No deployment worker job is visible yet. Try redeploying if logs do not start."
							: follow.message ||
								"Deployment queued. Waiting for the build worker to create logs.";
					setBuildStatus(follow.state || "queued", queueMessage);
					if (follow.state === "error") {
						renderBuildLogs(queueMessage);
						toast("Deployment failed before build logs were created.", "error");
						return;
					}
					await sleep(follow.retryAfterMs ?? 2500);
					continue;
				}

				currentDeploymentId = latest.deploymentId;
				const status = follow.state || latest.status || "running";
				const isDone = status === "done";
				const isError = status === "error";
				const isCancelled = status === "cancelled";
				setBuildStatus(
					status,
					isDone
						? liveHost
							? `Deployment complete. Live at https://${liveHost}.`
							: "Deployment complete."
						: follow.message ||
							(isError
								? "Deployment failed. Check the build logs for the failing step."
								: isCancelled
									? "Deployment was cancelled."
									: "Building application. This can take a few minutes on a fresh server."),
				);

				if (follow.logsAvailable) {
					try {
						const logs = await trpcQuery<string>("deployment.readLogs", {
							deploymentId: currentDeploymentId,
							tail: 1000,
						});
						renderBuildLogs(String(logs ?? ""));
					} catch (err) {
						if (!importBuildLogs) {
							renderBuildLogs(
								err instanceof Error
									? `Unable to read deployment logs: ${err.message}`
									: "Unable to read deployment logs.",
							);
						}
					}
				}

				if (isDone) {
					toast("Deployment completed", "success");
					return;
				}
				if (isError || isCancelled) {
					toast(
						isCancelled ? "Deployment cancelled." : "Deployment failed. Check the logs.",
						"error",
					);
					return;
				}
			} catch (err) {
				statusFailures += 1;
				const msg =
					err instanceof Error
						? `Deployment status could not be loaded: ${err.message}`
						: "Deployment status could not be loaded.";
				if (statusFailures >= 5 && currentDeploymentId) {
					try {
						const logs = await trpcQuery<string>("deployment.readLogs", {
							deploymentId: currentDeploymentId,
							tail: 1000,
						});
						renderBuildLogs(String(logs ?? ""));
					} catch {
						// Keep the existing logs visible; the status poll will retry.
					}
					statusFailures = 0;
					setBuildStatus(
						"running",
						`${msg} Logs are still available; retrying status in the background.`,
					);
					await sleep(5000);
					continue;
				}
				if (statusFailures >= 5) {
					setBuildStatus("error", `${msg} Refresh the service page or redeploy.`);
					if (!importBuildLogs) renderBuildLogs(msg);
					toast("Deployment status failed to load.", "error");
					return;
				}
				setBuildStatus(
					currentDeploymentId ? "running" : "queued",
					`${msg} Retrying...`,
				);
			}
			await sleep(3000);
		}

		if (!signal.aborted) {
			setBuildStatus(
				"running",
				currentDeploymentId
					? "Still building. Open the service to continue watching logs."
					: "Deployment was queued, but no build logs appeared yet.",
			);
		}
	}

	function showGitWizard() {
		root.dataset.appImportMode = "git";
		gitPanel?.classList.remove("hidden");
		if (gitPanel) gitPanel.hidden = false;
		emptyPanel?.classList.add("hidden");
		if (emptyPanel) emptyPanel.hidden = true;
		if (titleEl) titleEl.textContent = "Create a new application";
		if (emptyToggleBtn) emptyToggleBtn.textContent = "Create without Git";
		progressRoot?.classList.remove("hidden");
		setStep(state.step);
	}

	function showEmptyPanel() {
		root.dataset.appImportMode = "empty";
		gitPanel?.classList.add("hidden");
		if (gitPanel) gitPanel.hidden = true;
		emptyPanel?.classList.remove("hidden");
		if (emptyPanel) emptyPanel.hidden = false;
		if (titleEl) titleEl.textContent = "Create without Git";
		if (emptyToggleBtn) emptyToggleBtn.textContent = "Back to Git import";
		progressRoot?.classList.add("hidden");
		showServerFields();
		setError(errEl, "");
		emptyName?.focus();
	}

	const ENV_REMOVE_ICON = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" class="nz-app-import-env-remove__icon" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M2.5 4.5h11M5.5 4.5V3.75A.75.75 0 0 1 6.25 3h3.5a.75.75 0 0 1 .75.75V4.5M6.25 7v4.75M9.75 7v4.75M4 4.5l.45 8.1a.75.75 0 0 0 .75.7h6.6a.75.75 0 0 0 .75-.7L12.5 4.5" /></svg>`;

	function renderEnvRows() {
		if (!envRowsEl) return;
		envRowsEl.innerHTML = "";
		for (let i = 0; i < state.envRows.length; i++) {
			const row = state.envRows[i];
			const wrap = document.createElement("div");
			wrap.className = "nz-app-import-env-row";
			wrap.innerHTML = `
				<input type="text" class="nz-app-import-input" placeholder="KEY" data-env-key value="${escapeAttr(row.key)}" />
				<input type="text" class="nz-app-import-input" placeholder="value" data-env-val value="${escapeAttr(row.value)}" />
				<button type="button" class="nz-app-import-env-remove" data-env-remove="${i}" aria-label="Remove variable">${ENV_REMOVE_ICON}</button>
			`;
			envRowsEl.appendChild(wrap);
		}
	}

	function escapeAttr(value: string) {
		return value
			.replace(/&/g, "&amp;")
			.replace(/"/g, "&quot;")
			.replace(/</g, "&lt;");
	}

	const FRAMEWORK_ICONS: Record<
		string,
		{ title: string; color: string; path: string } | undefined
	> = {
		astro: {
			title: "Astro",
			color: "#BC52EE",
			path: "M8.358 20.162c-1.186-1.07-1.532-3.316-1.038-4.944.856 1.026 2.043 1.352 3.272 1.535 1.897.283 3.76.177 5.522-.678.202-.098.388-.229.608-.36.166.473.209.95.151 1.437-.14 1.185-.738 2.1-1.688 2.794-.38.277-.782.525-1.175.787-1.205.804-1.531 1.747-1.078 3.119l.044.148a3.158 3.158 0 0 1-1.407-1.188 3.31 3.31 0 0 1-.544-1.815c-.004-.32-.004-.642-.048-.958-.106-.769-.472-1.113-1.161-1.133-.707-.02-1.267.411-1.415 1.09-.012.053-.028.104-.045.165h.002zm-5.961-4.445s3.24-1.575 6.49-1.575l2.451-7.565c.092-.366.36-.614.662-.614.302 0 .57.248.662.614l2.45 7.565c3.85 0 6.491 1.575 6.491 1.575L16.088.727C15.93.285 15.663 0 15.303 0H8.697c-.36 0-.615.285-.784.727l-5.516 14.99z",
		},
		angular: {
			title: "Angular",
			color: "#0F0F11",
			path: "M16.712 17.711H7.288l-1.204 2.916L12 24l5.916-3.373-1.204-2.916ZM14.692 0l7.832 16.855.814-12.856L14.692 0ZM9.308 0 .662 3.999l.814 12.856L9.308 0Zm-.405 13.93h6.198L12 6.396 8.903 13.93Z",
		},
		nextjs: {
			title: "Next.js",
			color: "#000000",
			path: "M18.665 21.978C16.758 23.255 14.465 24 12 24 5.377 24 0 18.623 0 12S5.377 0 12 0s12 5.377 12 12c0 3.583-1.574 6.801-4.067 9.001L9.219 7.2H7.2v9.596h1.615V9.251l9.85 12.727Zm-3.332-8.533 1.6 2.061V7.2h-1.6v6.245Z",
		},
		nodejs: {
			title: "Node.js",
			color: "#5FA04E",
			path: "M11.998,24c-0.321,0-0.641-0.084-0.922-0.247l-2.936-1.737c-0.438-0.245-0.224-0.332-0.08-0.383 c0.585-0.203,0.703-0.25,1.328-0.604c0.065-0.037,0.151-0.023,0.218,0.017l2.256,1.339c0.082,0.045,0.197,0.045,0.272,0l8.795-5.076 c0.082-0.047,0.134-0.141,0.134-0.238V6.921c0-0.099-0.053-0.192-0.137-0.242l-8.791-5.072c-0.081-0.047-0.189-0.047-0.271,0 L3.075,6.68C2.99,6.729,2.936,6.825,2.936,6.921v10.15c0,0.097,0.054,0.189,0.139,0.235l2.409,1.392 c1.307,0.654,2.108-0.116,2.108-0.89V7.787c0-0.142,0.114-0.253,0.256-0.253h1.115c0.139,0,0.255,0.112,0.255,0.253v10.021 c0,1.745-0.95,2.745-2.604,2.745c-0.508,0-0.909,0-2.026-0.551L2.28,18.675c-0.57-0.329-0.922-0.945-0.922-1.604V6.921 c0-0.659,0.353-1.275,0.922-1.603l8.795-5.082c0.557-0.315,1.296-0.315,1.848,0l8.794,5.082c0.57,0.329,0.924,0.944,0.924,1.603 v10.15c0,0.659-0.354,1.273-0.924,1.604l-8.794,5.078C12.643,23.916,12.324,24,11.998,24z M19.099,13.993 c0-1.9-1.284-2.406-3.987-2.763c-2.731-0.361-3.009-0.548-3.009-1.187c0-0.528,0.235-1.233,2.258-1.233 c1.807,0,2.473,0.389,2.747,1.607c0.024,0.115,0.129,0.199,0.247,0.199h1.141c0.071,0,0.138-0.031,0.186-0.081 c0.048-0.054,0.074-0.123,0.067-0.196c-0.177-2.098-1.571-3.076-4.388-3.076c-2.508,0-4.004,1.058-4.004,2.833 c0,1.925,1.488,2.457,3.895,2.695c2.88,0.282,3.103,0.703,3.103,1.269c0,0.983-0.789,1.402-2.642,1.402 c-2.327,0-2.839-0.584-3.011-1.742c-0.02-0.124-0.126-0.215-0.253-0.215h-1.137c-0.141,0-0.254,0.112-0.254,0.253 c0,1.482,0.806,3.248,4.655,3.248C17.501,17.007,19.099,15.91,19.099,13.993z",
		},
		nuxt: {
			title: "Nuxt",
			color: "#00DC82",
			path: "M13.4642 19.8295h8.9218c.2834 0 .5618-.0723.8072-.2098a1.5899 1.5899 0 0 0 .5908-.5732 1.5293 1.5293 0 0 0 .216-.783 1.529 1.529 0 0 0-.2167-.7828L17.7916 7.4142a1.5904 1.5904 0 0 0-.5907-.573 1.6524 1.6524 0 0 0-.807-.2099c-.2833 0-.5616.0724-.807.2098a1.5904 1.5904 0 0 0-.5907.5731L13.4642 9.99l-2.9954-5.0366a1.5913 1.5913 0 0 0-.591-.573 1.6533 1.6533 0 0 0-.8071-.2098c-.2834 0-.5617.0723-.8072.2097a1.5913 1.5913 0 0 0-.591.573L.2168 17.4808A1.5292 1.5292 0 0 0 0 18.2635c-.0001.2749.0744.545.216.783a1.59 1.59 0 0 0 .5908.5732c.2454.1375.5238.2098.8072.2098h5.6003c2.219 0 3.8554-.9454 4.9813-2.7899l2.7337-4.5922L16.3935 9.99l4.3944 7.382h-5.8586ZM7.123 17.3694l-3.9083-.0009 5.8586-9.8421 2.9232 4.921-1.9572 3.2892c-.7478 1.1967-1.5972 1.6328-2.9163 1.6328z",
		},
		react: {
			title: "React",
			color: "#61DAFB",
			path: "M14.23 12.004a2.236 2.236 0 0 1-2.235 2.236 2.236 2.236 0 0 1-2.236-2.236 2.236 2.236 0 0 1 2.235-2.236 2.236 2.236 0 0 1 2.236 2.236zm2.648-10.69c-1.346 0-3.107.96-4.888 2.622-1.78-1.653-3.542-2.602-4.887-2.602-.41 0-.783.093-1.106.278-1.375.793-1.683 3.264-.973 6.365C1.98 8.917 0 10.42 0 12.004c0 1.59 1.99 3.097 5.043 4.03-.704 3.113-.39 5.588.988 6.38.32.187.69.275 1.102.275 1.345 0 3.107-.96 4.888-2.624 1.78 1.654 3.542 2.603 4.887 2.603.41 0 .783-.09 1.106-.275 1.374-.792 1.683-3.263.973-6.365C22.02 15.096 24 13.59 24 12.004c0-1.59-1.99-3.097-5.043-4.032.704-3.11.39-5.587-.988-6.38-.318-.184-.688-.277-1.092-.278zm-.005 1.09v.006c.225 0 .406.044.558.127.666.382.955 1.835.73 3.704-.054.46-.142.945-.25 1.44-.96-.236-2.006-.417-3.107-.534-.66-.905-1.345-1.727-2.035-2.447 1.592-1.48 3.087-2.292 4.105-2.295zm-9.77.02c1.012 0 2.514.808 4.11 2.28-.686.72-1.37 1.537-2.02 2.442-1.107.117-2.154.298-3.113.538-.112-.49-.195-.964-.254-1.42-.23-1.868.054-3.32.714-3.707.19-.09.4-.127.563-.132zm4.882 3.05c.455.468.91.992 1.36 1.564-.44-.02-.89-.034-1.345-.034-.46 0-.915.01-1.36.034.44-.572.895-1.096 1.345-1.565zM12 8.1c.74 0 1.477.034 2.202.093.406.582.802 1.203 1.183 1.86.372.64.71 1.29 1.018 1.946-.308.655-.646 1.31-1.013 1.95-.38.66-.773 1.288-1.18 1.87-.728.063-1.466.098-2.21.098-.74 0-1.477-.035-2.202-.093-.406-.582-.802-1.204-1.183-1.86-.372-.64-.71-1.29-1.018-1.946.303-.657.646-1.313 1.013-1.954.38-.66.773-1.286 1.18-1.868.728-.064 1.466-.098 2.21-.098zm-3.635.254c-.24.377-.48.763-.704 1.16-.225.39-.435.782-.635 1.174-.265-.656-.49-1.31-.676-1.947.64-.15 1.315-.283 2.015-.386zm7.26 0c.695.103 1.365.23 2.006.387-.18.632-.405 1.282-.66 1.933-.2-.39-.41-.783-.64-1.174-.225-.392-.465-.774-.705-1.146zm3.063.675c.484.15.944.317 1.375.498 1.732.74 2.852 1.708 2.852 2.476-.005.768-1.125 1.74-2.857 2.475-.42.18-.88.342-1.355.493-.28-.958-.646-1.956-1.1-2.98.45-1.017.81-2.01 1.085-2.964zm-13.395.004c.278.96.645 1.957 1.1 2.98-.45 1.017-.812 2.01-1.086 2.964-.484-.15-.944-.318-1.37-.5-1.732-.737-2.852-1.706-2.852-2.474 0-.768 1.12-1.742 2.852-2.476.42-.18.88-.342 1.356-.494zm11.678 4.28c.265.657.49 1.312.676 1.948-.64.157-1.316.29-2.016.39.24-.375.48-.762.705-1.158.225-.39.435-.788.636-1.18zm-9.945.02c.2.392.41.783.64 1.175.23.39.465.772.705 1.143-.695-.102-1.365-.23-2.006-.386.18-.63.406-1.282.66-1.933zM17.92 16.32c.112.493.2.968.254 1.423.23 1.868-.054 3.32-.714 3.708-.147.09-.338.128-.563.128-1.012 0-2.514-.807-4.11-2.28.686-.72 1.37-1.536 2.02-2.44 1.107-.118 2.154-.3 3.113-.54zm-11.83.01c.96.234 2.006.415 3.107.532.66.905 1.345 1.727 2.035 2.446-1.595 1.483-3.092 2.295-4.11 2.295-.22-.005-.406-.05-.553-.132-.666-.38-.955-1.834-.73-3.703.054-.46.142-.944.25-1.438zm4.56.64c.44.02.89.034 1.345.034.46 0 .915-.01 1.36-.034-.44.572-.895 1.095-1.345 1.565-.455-.47-.91-.993-1.36-1.565z",
		},
		remix: {
			title: "Remix",
			color: "#000000",
			path: "M21.511 18.508c.216 2.773.216 4.073.216 5.492H15.31c0-.309.006-.592.011-.878.018-.892.036-1.821-.109-3.698-.19-2.747-1.374-3.358-3.55-3.358H1.574v-5h10.396c2.748 0 4.122-.835 4.122-3.049 0-1.946-1.374-3.125-4.122-3.125H1.573V0h11.541c6.221 0 9.313 2.938 9.313 7.632 0 3.511-2.176 5.8-5.114 6.182 2.48.497 3.93 1.909 4.198 4.694ZM1.573 24v-3.727h6.784c1.133 0 1.379.84 1.379 1.342V24Z",
		},
		sveltekit: {
			title: "SvelteKit",
			color: "#FF3E00",
			path: "M10.354 21.125a4.44 4.44 0 0 1-4.765-1.767 4.109 4.109 0 0 1-.703-3.107 3.898 3.898 0 0 1 .134-.522l.105-.321.287.21a7.21 7.21 0 0 0 2.186 1.092l.208.063-.02.208a1.253 1.253 0 0 0 .226.83 1.337 1.337 0 0 0 1.435.533 1.231 1.231 0 0 0 .343-.15l5.59-3.562a1.164 1.164 0 0 0 .524-.778 1.242 1.242 0 0 0-.211-.937 1.338 1.338 0 0 0-1.435-.533 1.23 1.23 0 0 0-.343.15l-2.133 1.36a4.078 4.078 0 0 1-1.135.499 4.44 4.44 0 0 1-4.765-1.766 4.108 4.108 0 0 1-.702-3.108 3.855 3.855 0 0 1 1.742-2.582l5.589-3.563a4.072 4.072 0 0 1 1.135-.499 4.44 4.44 0 0 1 4.765 1.767 4.109 4.109 0 0 1 .703 3.107 3.943 3.943 0 0 1-.134.522l-.105.321-.286-.21a7.204 7.204 0 0 0-2.187-1.093l-.208-.063.02-.207a1.255 1.255 0 0 0-.226-.831 1.337 1.337 0 0 0-1.435-.532 1.231 1.231 0 0 0-.343.15L8.62 9.368a1.162 1.162 0 0 0-.524.778 1.24 1.24 0 0 0 .211.937 1.338 1.338 0 0 0 1.435.533 1.235 1.235 0 0 0 .344-.151l2.132-1.36a4.067 4.067 0 0 1 1.135-.498 4.44 4.44 0 0 1 4.765 1.766 4.108 4.108 0 0 1 .702 3.108 3.857 3.857 0 0 1-1.742 2.583l-5.589 3.562a4.072 4.072 0 0 1-1.135.499m10.358-17.95C18.484-.015 14.082-.96 10.9 1.068L5.31 4.63a6.412 6.412 0 0 0-2.896 4.295 6.753 6.753 0 0 0 .666 4.336 6.43 6.43 0 0 0-.96 2.396 6.833 6.833 0 0 0 1.168 5.167c2.229 3.19 6.63 4.135 9.812 2.108l5.59-3.562a6.41 6.41 0 0 0 2.896-4.295 6.756 6.756 0 0 0-.665-4.336 6.429 6.429 0 0 0 .958-2.396 6.831 6.831 0 0 0-1.167-5.168Z",
		},
		vite: {
			title: "Vite",
			color: "#9135FF",
			path: "M13.056 23.238a.57.57 0 0 1-1.02-.355v-5.202c0-.63-.512-1.143-1.144-1.143H5.148a.57.57 0 0 1-.464-.903l3.777-5.29c.54-.753 0-1.804-.93-1.804H.57a.574.574 0 0 1-.543-.746.6.6 0 0 1 .08-.157L5.008.78a.57.57 0 0 1 .467-.24h14.589a.57.57 0 0 1 .466.903l-3.778 5.29c-.54.755 0 1.806.93 1.806h5.745c.238 0 .424.138.513.322a.56.56 0 0 1-.063.603z",
		},
		vue: {
			title: "Vue.js",
			color: "#4FC08D",
			path: "M24,1.61H14.06L12,5.16,9.94,1.61H0L12,22.39ZM12,14.08,5.16,2.23H9.59L12,6.41l2.41-4.18h4.43Z",
		},
	};

	function normalizeFrameworkId(framework: string | null | undefined) {
		const value = (framework ?? "").trim().toLowerCase();
		if (value === "next" || value === "nextjs") return "nextjs";
		if (value === "@sveltejs/kit" || value === "svelte") return "sveltekit";
		if (value === "@remix-run/react" || value === "remix") return "remix";
		if (value === "@angular/core" || value === "angular") return "angular";
		if (value === "node") return "nodejs";
		return value || "other";
	}

	function frameworkLabel(framework: string | null | undefined) {
		const id = normalizeFrameworkId(framework);
		const labels: Record<string, string> = {
			nextjs: "next",
			sveltekit: "sveltekit",
			nodejs: "node",
			other: "app",
		};
		return labels[id] ?? id;
	}

	function frameworkIconHtml(framework: string | null | undefined) {
		const id = normalizeFrameworkId(framework);
		const icon = FRAMEWORK_ICONS[id];
		if (!icon) {
			return `<span class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded bg-[var(--nz-bg-muted,#f3f4f6)] text-[var(--nz-text-muted,#6b7280)]" aria-hidden="true"><svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.5h5l2 2H20v9H4z"></path></svg></span>`;
		}
		return `<span class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded" style="color:${escapeAttr(icon.color)};background-color:${escapeAttr(icon.color)}1f" title="${escapeAttr(icon.title)}" aria-label="${escapeAttr(icon.title)}"><svg viewBox="0 0 24 24" class="h-3.5 w-3.5" aria-hidden="true"><path fill="currentColor" d="${escapeAttr(icon.path)}"></path></svg></span>`;
	}

	function detectedAppMeta(app: DetectedRepositoryApp) {
		return [
			app.framework ? frameworkLabel(app.framework) : null,
			app.packageManager,
			app.hasWorkspaceDependencies ? "workspace deps" : null,
		]
			.filter(Boolean)
			.join(" · ");
	}

	function isNextApp(app: DetectedRepositoryApp) {
		return normalizeFrameworkId(app.framework) === "nextjs";
	}

	function lastPathSegment(path: string) {
		return path.split("/").filter(Boolean).pop()?.toLowerCase() ?? "";
	}

	function detectedAppRank(app: DetectedRepositoryApp, apps: DetectedRepositoryApp[]) {
		const nextApps = apps.filter(isNextApp);
		if (isNextApp(app)) {
			if (nextApps.length === 1) return 0;
			const segment = lastPathSegment(app.path);
			if (segment === "web") return 1;
			if (segment === "app") return 2;
			return 3;
		}
		if (app.framework) return 20;
		if (app.path === "/") return 40;
		return 30;
	}

	function sortDetectedApps(apps: DetectedRepositoryApp[]) {
		return [...apps].sort((a, b) => {
			const rank = detectedAppRank(a, apps) - detectedAppRank(b, apps);
			if (rank !== 0) return rank;
			return a.path.localeCompare(b.path);
		});
	}

	function chooseDefaultDetectedApp(apps: DetectedRepositoryApp[]) {
		return sortDetectedApps(apps)[0] ?? null;
	}

	function setBuildPathPickerOpen(open: boolean) {
		if (!buildPathPickerButton || !buildPathMenu) return;
		buildPathPickerButton.setAttribute("aria-expanded", open ? "true" : "false");
		buildPathMenu.classList.toggle("hidden", !open);
	}

	function syncBuildPathInputs() {
		if (buildPathInput) buildPathInput.value = state.buildPath || "/";
		if (buildPathOtherInput) buildPathOtherInput.value = state.buildPath || "/";
	}

	function applyBuildCommandPlaceholders(app: DetectedRepositoryApp) {
		if (customInstallCommandInput && !customInstallCommandInput.value.trim()) {
			customInstallCommandInput.placeholder = app.recommendedCommands.install;
		}
		if (customBuildCommandInput && app.recommendedCommands.build && !customBuildCommandInput.value.trim()) {
			customBuildCommandInput.placeholder = app.recommendedCommands.build;
		}
		if (customStartCommandInput && app.recommendedCommands.start && !customStartCommandInput.value.trim()) {
			customStartCommandInput.placeholder = app.recommendedCommands.start;
		}
	}

	function applyDetectedApp(app: DetectedRepositoryApp) {
		state.buildPathSource = "detected";
		state.buildPath = app.path;
		syncBuildPathInputs();
		applyBuildCommandPlaceholders(app);
		renderDetectedApps();
		setBuildPathPickerOpen(false);
	}

	function applyOtherBuildPath(value?: string) {
		const wasOther = state.buildPathSource === "other";
		state.buildPathSource = "other";
		state.buildPath = value?.trim() || (wasOther ? state.buildPath : "") || "/";
		syncBuildPathInputs();
		renderDetectedApps();
		setBuildPathPickerOpen(false);
		buildPathOtherInput?.focus();
	}

	function renderDetectedApps(status?: "loading" | "unsupported" | "empty" | "error") {
		if (buildPathOptions) {
			buildPathOptions.replaceChildren();
			for (const app of state.detectedApps) {
				const opt = document.createElement("option");
				opt.value = app.path;
				opt.label = `${frameworkLabel(app.framework)} ${app.path}`;
				buildPathOptions.appendChild(opt);
			}
		}
		detectedAppsEl?.classList.add("hidden");
		if (detectedAppsEl) detectedAppsEl.textContent = "";

		const shouldUseManualInput =
			status === "unsupported" ||
			status === "error" ||
			status === "empty" ||
			status === "loading" ||
			(state.detectedApps.length === 0 && status !== "loading");

		if (
			!buildPathManualWrap ||
			!buildPathPickerWrap ||
			!buildPathPickerButton ||
			!buildPathPickerLabel ||
			!buildPathMenu
		) {
			return;
		}

		if (shouldUseManualInput) {
			state.buildPathSource = "manual";
			buildPathManualWrap.classList.remove("hidden");
			buildPathPickerWrap.classList.add("hidden");
			buildPathOtherWrap?.classList.add("hidden");
			setBuildPathPickerOpen(false);
			return;
		}

		buildPathManualWrap.classList.add("hidden");
		buildPathPickerWrap.classList.remove("hidden");

		let selectedApp = state.detectedApps.find((app) => app.path === state.buildPath) ?? null;
		if (state.buildPathSource !== "other" && !selectedApp) {
			selectedApp = chooseDefaultDetectedApp(state.detectedApps);
			if (selectedApp) {
				state.buildPathSource = "detected";
				state.buildPath = selectedApp.path;
				syncBuildPathInputs();
				applyBuildCommandPlaceholders(selectedApp);
			}
		}

		const isOtherPath = state.buildPathSource === "other";
		const selectedTitle = isOtherPath ? "Other" : state.buildPath || "/";
		const selectedMeta = isOtherPath
			? `Custom path: ${state.buildPath || "/"}`
			: selectedApp
				? detectedAppMeta(selectedApp)
				: "custom path";
		buildPathPickerLabel.innerHTML = `
			${frameworkIconHtml(isOtherPath ? null : selectedApp?.framework)}
			<span class="min-w-0">
				<span class="block truncate text-[var(--nz-text,#111827)]">${escapeAttr(selectedTitle)}</span>
				<span class="block truncate text-xs text-[var(--nz-text-muted,#6b7280)]">${escapeAttr(selectedMeta || "package.json")}</span>
			</span>
		`;
		buildPathOtherWrap?.classList.toggle("hidden", state.buildPathSource !== "other");

		buildPathMenu.innerHTML = `
			${state.detectedApps
				.map((app, index) => {
					const active = state.buildPathSource !== "other" && app.path === state.buildPath;
					return `<button type="button" role="option" aria-selected="${active ? "true" : "false"}" class="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm ${active ? "bg-[var(--nz-bg-hover,#f3f4f6)]" : "hover:bg-[var(--nz-bg-hover,#f3f4f6)]"}" data-build-path-detected-index="${index}">
						${frameworkIconHtml(app.framework)}
						<span class="min-w-0">
							<span class="block truncate font-medium text-[var(--nz-text,#111827)]">${escapeAttr(app.path)}</span>
							<span class="block truncate text-xs text-[var(--nz-text-muted,#6b7280)]">${escapeAttr(detectedAppMeta(app) || "package.json")}</span>
						</span>
					</button>`;
				})
				.join("")}
			<button type="button" role="option" aria-selected="${state.buildPathSource === "other" ? "true" : "false"}" class="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm ${state.buildPathSource === "other" ? "bg-[var(--nz-bg-hover,#f3f4f6)]" : "hover:bg-[var(--nz-bg-hover,#f3f4f6)]"}" data-build-path-other>
				${frameworkIconHtml(null)}
				<span class="min-w-0">
					<span class="block truncate font-medium text-[var(--nz-text,#111827)]">Other</span>
					<span class="block truncate text-xs text-[var(--nz-text-muted,#6b7280)]">Enter a custom build path</span>
				</span>
			</button>
		`;
	}

	async function detectAppsForSelectedRepository() {
		const gen = ++detectionGen;
		state.detectedApps = [];
		renderDetectedApps(state.provider === "github" ? "loading" : "unsupported");
		if (
			state.provider !== "github" ||
			!state.accountId ||
			!state.repoPayload ||
			!state.branch
		) {
			return;
		}
		try {
			const repo = state.repoPayload as GithubRepoOption;
			const apps = await fetchGithubDetectedApps(
				state.accountId,
				repo.owner,
				repo.repo,
				state.branch,
			);
			if (gen !== detectionGen || signal.aborted) return;
			state.detectedApps = sortDetectedApps(apps ?? []);
			if (state.detectedApps.length > 0) {
				const currentPath = buildPathInput?.value.trim() || state.buildPath || "/";
				const matchingApp =
					state.detectedApps.find((app) => app.path === currentPath) ?? null;
				if (matchingApp) {
					applyDetectedApp(matchingApp);
				} else if (currentPath && currentPath !== "/") {
					state.buildPathSource = "other";
					state.buildPath = currentPath;
					syncBuildPathInputs();
				} else {
					const defaultApp = chooseDefaultDetectedApp(state.detectedApps);
					if (defaultApp) applyDetectedApp(defaultApp);
				}
			}
			renderDetectedApps(state.detectedApps.length > 0 ? undefined : "empty");
		} catch {
			if (gen !== detectionGen || signal.aborted) return;
			state.detectedApps = [];
			renderDetectedApps("error");
		}
	}

	function syncEnvRowsFromDom() {
		if (!envRowsEl) return;
		const rows: { key: string; value: string }[] = [];
		envRowsEl.querySelectorAll<HTMLElement>(".nz-app-import-env-row").forEach((row) => {
			const key =
				(row.querySelector("[data-env-key]") as HTMLInputElement | null)?.value ?? "";
			const value =
				(row.querySelector("[data-env-val]") as HTMLInputElement | null)?.value ?? "";
			rows.push({ key, value });
		});
		state.envRows = rows.length ? rows : [{ key: "", value: "" }];
	}

	function setSelectedRepoSummary(name: string, meta: string) {
		if (selectedRepoName) selectedRepoName.textContent = name;
		if (selectedRepoMeta) selectedRepoMeta.textContent = meta;
		selectedRepoWrap?.classList.toggle("hidden", !name);
	}

	function setReposLoading(loading: boolean) {
		reposLoading?.classList.toggle("hidden", !loading);
		reposLoading?.setAttribute("aria-hidden", loading ? "false" : "true");
		reposStatus?.classList.toggle("hidden", loading);
		repoList?.classList.toggle("hidden", loading);
	}

	function renderRepoList(filter: string) {
		if (!repoList || !reposStatus) return;
		setReposLoading(false);
		const q = filter.trim().toLowerCase();
		const filtered = state.repos.filter(
			(r) =>
				!q ||
				r.label.toLowerCase().includes(q) ||
				r.subtitle.toLowerCase().includes(q),
		);
		repoList.replaceChildren();
		if (!state.provider || !state.accountId) {
			reposStatus.textContent = "Select a provider to load repositories.";
			return;
		}
		if (filtered.length === 0) {
			reposStatus.textContent = q ? "No repositories match your search." : "No repositories found.";
			return;
		}
		reposStatus.textContent = `${filtered.length} repositor${filtered.length === 1 ? "y" : "ies"}`;
		for (const repo of filtered) {
			const li = document.createElement("li");
			li.className = "nz-app-import-repo-item";
			li.innerHTML = `
				<div class="nz-app-import-repo-item__main">
					<span class="nz-app-import-repo-item__name">${escapeAttr(repo.label)}</span>
					<span class="nz-app-import-repo-item__meta">${escapeAttr(repo.subtitle)}${repo.isPrivate ? " · private" : ""}</span>
				</div>
				<button type="button" class="nz-app-import-btn nz-app-import-btn--primary nz-app-import-repo-item__import" data-import-repo="${escapeAttr(repo.key)}">Import</button>
			`;
			repoList.appendChild(li);
		}
	}

	async function loadReposForAccount() {
		if (!state.provider || !state.accountId) return;
		const gen = ++repoFetchGen;
		setReposLoading(true);
		if (repoList) repoList.replaceChildren();

		try {
			let items: RepoListItem[] = [];
			if (state.provider === "github") {
				const repos = await fetchGithubRepositories(state.accountId);
				if (gen !== repoFetchGen || signal.aborted) return;
				items = repos.map((r) => ({
					key: JSON.stringify({ owner: r.owner, repo: r.repo }),
					label: r.repo,
					subtitle: r.owner,
					isPrivate: r.isPrivate,
					payload: { owner: r.owner, repo: r.repo },
				}));
			} else if (state.provider === "gitlab") {
				const repos = await fetchGitlabRepositories(state.accountId);
				if (gen !== repoFetchGen || signal.aborted) return;
				items = repos.map((r) => ({
					key: JSON.stringify({
						owner: r.owner,
						repo: r.repo,
						gitlabPathNamespace: r.gitlabPathNamespace,
						id: r.id,
					}),
					label: r.repo,
					subtitle: r.gitlabPathNamespace,
					isPrivate: r.isPrivate,
					payload: {
						owner: r.owner,
						repo: r.repo,
						gitlabPathNamespace: r.gitlabPathNamespace,
						id: r.id,
					},
				}));
			} else if (state.provider === "bitbucket") {
				const repos = await fetchBitbucketRepositories(state.accountId);
				if (gen !== repoFetchGen || signal.aborted) return;
				items = repos.map((r) => ({
					key: JSON.stringify({ owner: r.owner, repo: r.repo, slug: r.slug }),
					label: r.repo,
					subtitle: r.owner,
					isPrivate: r.isPrivate,
					payload: { owner: r.owner, repo: r.repo, slug: r.slug },
				}));
			} else {
				const repos = await fetchGiteaRepositories(state.accountId);
				if (gen !== repoFetchGen || signal.aborted) return;
				items = repos.map((r) => ({
					key: JSON.stringify({ owner: r.owner, repo: r.repo }),
					label: r.repo,
					subtitle: r.owner,
					isPrivate: r.isPrivate,
					payload: { owner: r.owner, repo: r.repo },
				}));
			}
			state.repos = items.reverse();
			renderRepoList(repoSearch?.value ?? "");
		} catch (err) {
			if (gen !== repoFetchGen) return;
			state.repos = [];
			setReposLoading(false);
			if (reposStatus) {
				reposStatus.textContent =
					err instanceof Error ? err.message : "Failed to load repositories.";
			}
		}
	}

	function populateAccountSelect(provider: GitProviderKind) {
		if (!accountSelect) return;
		const list = accountsForProvider(accounts, provider);
		accountSelect.replaceChildren();
		for (const acc of list) {
			const opt = document.createElement("option");
			opt.value = acc.id;
			opt.textContent = acc.label;
			accountSelect.appendChild(opt);
		}
		if (list[0]) {
			state.accountId = list[0].id;
			accountSelect.value = list[0].id;
		}
	}

	function updateConnectCta(provider: GitProviderKind) {
		const list = accountsForProvider(accounts, provider);
		const opt = providerOptions.find((p) => p.key === provider);
		if (!connectCta || !connectMsg) return;
		if (list.length > 0) {
			connectCta.classList.add("hidden");
			return;
		}
		connectCta.classList.remove("hidden");
		connectMsg.textContent = `No ${opt?.label ?? provider} accounts connected. Connect one to import repositories.`;
	}

	function setBranchFieldMode(mode: WizardSourceMode) {
		const isPublic = mode === "public";
		branchWrap?.classList.toggle("hidden", isPublic);
		branchSelect?.classList.toggle("hidden", isPublic);
		if (branchSelect) branchSelect.required = !isPublic;
		branchTextInput?.classList.add("hidden");
		if (branchTextInput) branchTextInput.required = false;
	}

	async function selectProvider(provider: GitProviderKind) {
		state.sourceMode = "provider";
		state.provider = provider;
		state.accountId = null;
		state.repos = [];
		updateConnectCta(provider);
		const list = accountsForProvider(accounts, provider);
		if (list.length === 0) {
			setStep("provider");
			return;
		}
		populateAccountSelect(provider);
		setStep("repos");
		await loadReposForAccount();
	}

	async function loadBranches() {
		if (!branchSelect || !state.provider || !state.accountId || !state.repoPayload) return;
		branchSelect.innerHTML = `<option value="">Loading…</option>`;
		try {
			let branches: string[] = [];
			if (state.provider === "github") {
				const repo = state.repoPayload as GithubRepoOption;
				branches = await fetchGithubBranches(state.accountId, repo.owner, repo.repo);
			} else if (state.provider === "gitlab") {
				branches = await fetchGitlabBranches(
					state.accountId,
					state.repoPayload as GitlabRepoOption,
				);
			} else if (state.provider === "bitbucket") {
				branches = await fetchBitbucketBranches(
					state.accountId,
					state.repoPayload as BitbucketRepoOption,
				);
			} else {
				branches = await fetchGiteaBranches(
					state.accountId,
					state.repoPayload as GiteaRepoOption,
				);
			}
			branchSelect.replaceChildren();
			const placeholder = document.createElement("option");
			placeholder.value = "";
			placeholder.textContent = "Select branch";
			branchSelect.appendChild(placeholder);
			for (const name of branches) {
				const opt = document.createElement("option");
				opt.value = name;
				opt.textContent = name;
				if (name === "main" || name === "master") opt.selected = true;
				branchSelect.appendChild(opt);
			}
			state.branch = branchSelect.value;
			await detectAppsForSelectedRepository();
		} catch (err) {
			branchSelect.innerHTML = `<option value="">Failed to load branches</option>`;
			setError(
				errEl,
				err instanceof Error ? err.message : "Failed to load branches",
			);
		}
	}

	async function beginPublicRepo() {
		const rawUrl = publicUrlInput?.value.trim() ?? "";
		const parsed = parsePublicGitUrl(rawUrl);
		if (!parsed) {
			setError(errEl, "Enter a valid public Git URL (HTTPS or git@host:owner/repo).");
			publicUrlInput?.focus();
			return;
		}

		const continueBtn = root.querySelector<HTMLButtonElement>(
			"[data-app-import-public-continue]",
		);
		if (continueBtn?.getAttribute("aria-busy") === "true") return;

		setError(errEl, "");
		if (continueBtn) {
			continueBtn.disabled = true;
			continueBtn.setAttribute("aria-busy", "true");
			setButtonLoadingVisuals(continueBtn, true);
		}

		try {
			const branch = await resolvePublicGitDefaultBranch(rawUrl);
			state.sourceMode = "public";
			state.provider = null;
			state.accountId = null;
			state.repoPayload = null;
			state.publicGitUrl = parsed.url;
			state.publicGitBranch = branch;
			state.repoLabel = `${parsed.repoName} (public)`;
			state.displayName = parsed.repoName;
			state.appName = defaultAppName(ctx.projectSlug, parsed.repoName);
			state.branch = branch;
			state.buildPath = "/";
			state.buildPathSource = "manual";
			state.detectedApps = [];
			if (nameInput) nameInput.value = state.displayName;
			if (appNameInput) appNameInput.value = state.appName;
			if (buildPathInput) buildPathInput.value = "/";
			if (buildPathOtherInput) buildPathOtherInput.value = "/";
			renderDetectedApps("unsupported");
			setSelectedRepoSummary(parsed.repoName, `${parsed.url} · ${branch}`);
			setBranchFieldMode("public");
			setStep("configure");
			void refreshDomainPreview();
		} catch (err) {
			setError(
				errEl,
				err instanceof Error ? err.message : "Could not resolve repository branch.",
			);
		} finally {
			if (continueBtn) {
				continueBtn.disabled = false;
				continueBtn.removeAttribute("aria-busy");
				setButtonLoadingVisuals(continueBtn, false);
			}
		}
	}

	async function beginImportRepo(key: string) {
		const repo = state.repos.find((r) => r.key === key);
		if (!repo || !state.provider) return;
		state.sourceMode = "provider";
		state.repoPayload = repo.payload;
		state.repoLabel = repo.label;
		state.displayName = repo.label;
		state.appName = defaultAppName(ctx.projectSlug, repo.label);
		state.buildPath = "/";
		state.buildPathSource = "manual";
		state.detectedApps = [];
		if (nameInput) nameInput.value = state.displayName;
		if (appNameInput) appNameInput.value = state.appName;
		if (buildPathInput) buildPathInput.value = "/";
		if (buildPathOtherInput) buildPathOtherInput.value = "/";
		renderDetectedApps(state.provider === "github" ? "loading" : "unsupported");
		if (descriptionInput) descriptionInput.value = "";
		setSelectedRepoSummary(repo.label, repo.subtitle);
		setBranchFieldMode("provider");
		setStep("configure");
		await loadBranches();
		void refreshDomainPreview();
	}

	function renderDomainPreview() {
		const preview = state.domainPreview;
		if (!domainPreviewEl) return;
		if (!preview?.enabled) {
			domainPreviewEl.classList.add("hidden");
			domainPreviewEl.textContent = "";
			managedDomainWrap?.classList.add("hidden");
			managedPortWrap?.classList.add("hidden");
			return;
		}
		domainPreviewEl.classList.remove("hidden");
		managedPortWrap?.classList.remove("hidden");
		const modeLabel =
			preview.mode === "org-zone"
				? "Managed DNS hostname"
				: preview.mode === "platform"
					? "Nearzero platform hostname"
					: preview.mode === "preview"
						? "Nearzero preview hostname"
						: "Suggested hostname";
		const warn =
			preview.warnings.length > 0 ?
				`<br /><span class="text-amber-700">${preview.warnings.map((w) => escapeAttr(w)).join(" ")}</span>`
			:	"";
		domainPreviewEl.innerHTML = `<strong>${escapeAttr(preview.host ?? "")}</strong><br />${escapeAttr(modeLabel)}${warn}`;

		if (preview.mode === "org-zone") {
			managedDomainWrap?.classList.remove("hidden");
		} else {
			managedDomainWrap?.classList.add("hidden");
			state.managedDomain = preview.mode === "platform";
		}
	}

	function scheduleDomainPreview() {
		if (domainPreviewTimer) clearTimeout(domainPreviewTimer);
		domainPreviewTimer = setTimeout(() => {
			void refreshDomainPreview();
		}, 300);
	}

	async function refreshDomainPreview() {
		const serviceName = nameInput?.value.trim() ?? "";
		if (!serviceName) {
			state.domainPreview = null;
			renderDomainPreview();
			return;
		}
		try {
			state.domainPreview = await previewServiceDomain({
				environmentId: ctx.environmentId,
				serviceName,
				serverId: normalizeServerId(serverSelect?.value),
			});
		} catch {
			state.domainPreview = null;
		}
		renderDomainPreview();
	}

	function shouldProvisionAutoDomain() {
		const preview = state.domainPreview;
		if (!preview?.enabled || !preview.host) return false;
		if (preview.mode === "platform") return true;
		if (preview.mode === "preview") return true;
		if (preview.mode === "org-zone") return state.managedDomain;
		return false;
	}

	function validateConfigure(): string | null {
		const name = nameInput?.value.trim() ?? "";
		const appName = appNameInput?.value.trim() ?? "";
		const branch =
			state.sourceMode === "public"
				? state.branch?.trim() ?? ""
				: branchSelect?.value ?? "";
		if (!branch) return "Select a branch.";
		state.branch = branch;
		if (state.sourceMode === "public") {
			state.publicGitBranch = branch;
		}
		if (!name) return "Name is required.";
		if (!appName || !isValidAppName(appName)) return APP_NAME_MESSAGE;
		const serverId = normalizeServerId(serverSelect?.value);
		const serverErr = requireCloudServer(serverId);
		if (serverErr) return serverErr;
		state.displayName = name;
		state.appName = appName;
		state.buildPath = buildPathInput?.value.trim() || "/";
		state.customInstallCommand = customInstallCommandInput?.value.trim() || "";
		state.customBuildCommand = customBuildCommandInput?.value.trim() || "";
		state.customStartCommand = customStartCommandInput?.value.trim() || "";
		state.description = descriptionInput?.value ?? "";
		state.serverId = serverId;
		state.managedDomain = managedToggle?.checked ?? false;
		const port = Number.parseInt(managedPortInput?.value ?? "3000", 10);
		if (!Number.isFinite(port) || port < 1 || port > 65535) {
			return "Enter a valid service port (1–65535).";
		}
		state.domainPort = port;
		return null;
	}

	async function runSubmit(
		mode: "deploy" | "create_only",
		activeButton: HTMLButtonElement,
	) {
		syncEnvRowsFromDom();
		const configErr = validateConfigure();
		if (configErr) {
			setError(errEl, configErr);
			setStep("configure");
			return;
		}
		if (state.sourceMode === "public") {
			if (!state.publicGitUrl.trim()) {
				setError(errEl, "Enter a public repository URL.");
				return;
			}
		} else if (!state.provider || !state.accountId || !state.repoPayload) {
			setError(errEl, "Select a repository first.");
			return;
		}

		setError(errEl, "");
		const buttons = root.querySelectorAll<HTMLButtonElement>("[data-app-import-submit]");
		const backButton = root.querySelector<HTMLButtonElement>(
			'[data-app-import-back="repos"]',
		);
		for (const btn of buttons) btn.disabled = true;
		if (backButton) backButton.disabled = true;
		setImportSubmitBusy(activeButton, true);

		let applicationId: string | undefined;
		let keepLocked = false;

		try {
			const created = await trpcMutate<{ applicationId: string }>("application.create", {
				name: state.displayName,
				appName: state.appName,
				description: state.description,
				serverId: state.serverId,
				environmentId: ctx.environmentId,
			});
			applicationId = created.applicationId;

			if (state.sourceMode === "public") {
				await trpcMutate("application.saveGitProvider", {
					applicationId,
					customGitUrl: state.publicGitUrl,
					customGitBranch: state.branch,
					customGitBuildPath: state.buildPath || "/",
					customGitSSHKeyId: null,
					watchPaths: [],
					enableSubmodules: false,
				});
			} else {
				const saveInput = buildSaveProviderInput(
					{
						provider: state.provider!,
						accountId: state.accountId!,
						repoPayload: state.repoPayload!,
						branch: state.branch,
						buildPath: state.buildPath,
					},
					applicationId,
				);
				await trpcMutate(saveInput.procedure, saveInput.input);
			}

			const envBlock = formatEnvBlock(state.envRows);
			await trpcMutate("application.saveEnvironment", {
				applicationId,
				env: envBlock,
				createEnvFile: true,
				buildArgs: "",
				buildSecrets: "",
				customInstallCommand: state.customInstallCommand,
				customBuildCommand: state.customBuildCommand,
				customStartCommand: state.customStartCommand,
			});

			let liveHost: string | null = null;
			if (shouldProvisionAutoDomain()) {
				try {
					const domain = await provisionServiceDomain({
						environmentId: ctx.environmentId,
						serviceName: state.displayName,
						port: state.domainPort,
						serverId: state.serverId,
						applicationId,
						domainType: "application",
					});
					liveHost = domain.host;
				} catch (err) {
					const msg =
						err instanceof Error ? err.message : "Domain assignment failed";
					toast(`${msg}. Application was created without a managed domain.`, "error");
				}
			}

			if (mode === "deploy" && ctx.canDeploy) {
				keepLocked = true;
				showBuildPanel(applicationId, liveHost);
				let deployJobId: string | null = null;
				try {
					const deployResult = await trpcMutate<{
						success?: boolean;
						message?: string;
						jobId?: string;
						applicationId?: string;
					}>("application.deploy", {
						applicationId,
						title: "Import deploy",
						description: `Deploy ${state.displayName}`,
					});
					deployJobId = deployResult.jobId ?? null;
				} catch (err) {
					keepLocked = false;
					const msg = err instanceof Error ? err.message : "Deploy failed";
					setBuildStatus("error", msg);
					renderBuildLogs(msg);
					toast(msg, "error");
					return;
				}
				toast("Deployment queued", "success");
				await pollDeploymentProgress(applicationId, liveHost, deployJobId);
				return;
			}

			keepLocked = true;
			toast(
				liveHost ? `Application created — https://${liveHost}` : "Application created",
				"success",
			);
			const params = new URLSearchParams();
			if (mode === "deploy" && ctx.canDeploy) params.set("tab", "deployments");
			if (liveHost) params.set("liveUrl", `https://${liveHost}`);
			const query = params.size > 0 ? params.toString() : undefined;
			window.location.href = environmentApplicationHref(
				ctx.projectId,
				ctx.environmentId,
				applicationId,
				query,
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Setup failed";
			if (applicationId) {
				keepLocked = true;
				setError(
					errEl,
					`${msg}. The application was created, but setup did not finish. Open the service to repair it.`,
				);
				toast("Application created; setup needs attention.", "error");
				window.location.href = environmentApplicationHref(
					ctx.projectId,
					ctx.environmentId,
					applicationId,
				);
			} else {
				setError(errEl, msg);
				toast(msg, "error");
			}
		} finally {
			if (!keepLocked) {
				setImportSubmitBusy(activeButton, false);
				for (const btn of buttons) btn.disabled = false;
				if (backButton) backButton.disabled = false;
				setCloudServerBlockedActions();
			}
		}
	}

	async function submitEmpty() {
		const name = emptyName?.value.trim() ?? "";
		const appName = emptyAppName?.value.trim() ?? "";
		const description = emptyDescription?.value ?? "";
		if (!name) {
			setError(errEl, "Name is required");
			return;
		}
		if (!appName || !isValidAppName(appName)) {
			setError(errEl, APP_NAME_MESSAGE);
			return;
		}
		const serverId = normalizeServerId(emptyServerSelect?.value);
		const serverErr = requireCloudServer(serverId);
		if (serverErr) {
			setError(errEl, serverErr);
			return;
		}

		setError(errEl, "");
		const btn = root.querySelector<HTMLButtonElement>("[data-app-import-empty-submit]");
		if (btn) btn.disabled = true;

		try {
			const created = await trpcMutate<{ applicationId: string }>("application.create", {
				name,
				appName,
				description,
				serverId,
				environmentId: ctx.environmentId,
			});
			toast("Application created", "success");
			window.location.href = environmentApplicationHref(
				ctx.projectId,
				ctx.environmentId,
				created.applicationId,
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Error creating application";
			setError(errEl, msg);
			toast(msg, "error");
		} finally {
			if (btn) btn.disabled = false;
			setCloudServerBlockedActions();
		}
	}

	function activateEmptyMode() {
		showEmptyPanel();
		const url = new URL(window.location.href);
		url.searchParams.set("mode", "empty");
		window.history.replaceState({}, "", url);
	}

	function activateGitMode() {
		showGitWizard();
		const url = new URL(window.location.href);
		url.searchParams.delete("mode");
		window.history.replaceState({}, "", url);
	}

	emptyToggleBtn?.addEventListener(
		"click",
		(event) => {
			event.preventDefault();
			if (root.dataset.appImportMode === "empty") {
				activateGitMode();
			} else {
				activateEmptyMode();
			}
		},
		{ signal },
	);

	// URL ?mode=empty
	if (new URLSearchParams(window.location.search).get("mode") === "empty") {
		showEmptyPanel();
	} else {
		showGitWizard();
		setStep("provider");
	}

	renderEnvRows();

	nameInput?.addEventListener("input", scheduleDomainPreview, { signal });
	serverSelect?.addEventListener("change", scheduleDomainPreview, { signal });

	publicUrlInput?.addEventListener(
		"keydown",
		(event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				void beginPublicRepo();
			}
		},
		{ signal },
	);
	managedToggle?.addEventListener(
		"change",
		() => {
			state.managedDomain = managedToggle.checked;
		},
		{ signal },
	);

	root.addEventListener(
		"click",
		(event) => {
			const target = event.target instanceof Element ? event.target : null;
			if (!target) return;

			const buildPathToggle = target.closest("#nz-app-import-build-path-picker");
			if (buildPathToggle) {
				event.preventDefault();
				setBuildPathPickerOpen(
					buildPathPickerButton?.getAttribute("aria-expanded") !== "true",
				);
				return;
			}

			const buildPathDetectedBtn = target.closest<HTMLButtonElement>(
				"[data-build-path-detected-index]",
			);
			if (buildPathDetectedBtn?.dataset.buildPathDetectedIndex) {
				const app =
					state.detectedApps[
						Number(buildPathDetectedBtn.dataset.buildPathDetectedIndex)
					];
				if (app) applyDetectedApp(app);
				return;
			}

			const buildPathOtherBtn = target.closest("[data-build-path-other]");
			if (buildPathOtherBtn) {
				applyOtherBuildPath(
					state.buildPathSource === "other"
						? buildPathOtherInput?.value.trim()
						: undefined,
				);
				return;
			}

			if (!target.closest("#nz-app-import-build-path-picker-wrap")) {
				setBuildPathPickerOpen(false);
			}

			const copyBuildLogs = target.closest("[data-app-import-build-copy]");
			if (copyBuildLogs) {
				void navigator.clipboard.writeText(importBuildLogs).then(
					() => toast("Build logs copied", "success"),
					() => toast("Could not copy build logs", "error"),
				);
				return;
			}

			const publicContinue = target.closest("[data-app-import-public-continue]");
			if (publicContinue) {
				void beginPublicRepo();
				return;
			}

			const providerBtn = target.closest<HTMLButtonElement>("[data-app-import-provider]");
			if (providerBtn) {
				const provider = providerBtn.dataset.appImportProvider as GitProviderKind;
				void selectProvider(provider);
				return;
			}

			const oauthBtn = target.closest("[data-app-import-oauth-connect]");
			if (oauthBtn && state.provider) {
				window.location.href = oauthStartUrl(state.provider, ctx.pageHref);
				return;
			}

			const importBtn = target.closest<HTMLButtonElement>("[data-import-repo]");
			if (importBtn?.dataset.importRepo) {
				void beginImportRepo(importBtn.dataset.importRepo);
				return;
			}

			const detectedAppBtn = target.closest<HTMLButtonElement>("[data-app-detected-index]");
			if (detectedAppBtn?.dataset.appDetectedIndex) {
				const app = state.detectedApps[Number(detectedAppBtn.dataset.appDetectedIndex)];
				if (app) applyDetectedApp(app);
				return;
			}

			const back = target.closest<HTMLElement>("[data-app-import-back]");
			if (back) {
				let step = back.getAttribute("data-app-import-back") as WizardStep;
				if (state.sourceMode === "public" && step === "repos") {
					step = "provider";
				}
				setStep(step);
				return;
			}

			const submit = target.closest<HTMLButtonElement>("[data-app-import-submit]");
			if (submit) {
				if (submit.getAttribute("aria-busy") === "true") return;
				const mode = submit.dataset.appImportSubmit as "deploy" | "create_only";
				void runSubmit(mode === "deploy" ? "deploy" : "create_only", submit);
				return;
			}

			const addEnv = target.closest("[data-app-import-add-env]");
			if (addEnv) {
				syncEnvRowsFromDom();
				state.envRows.push({ key: "", value: "" });
				renderEnvRows();
				return;
			}

			const removeEnv = target.closest<HTMLButtonElement>("[data-env-remove]");
			if (removeEnv) {
				syncEnvRowsFromDom();
				const idx = Number(removeEnv.dataset.envRemove);
				state.envRows.splice(idx, 1);
				if (state.envRows.length === 0) state.envRows.push({ key: "", value: "" });
				renderEnvRows();
				return;
			}

			const emptyCancel = target.closest("[data-app-import-empty-cancel]");
			if (emptyCancel) {
				activateGitMode();
				return;
			}

			const emptySubmit = target.closest("[data-app-import-empty-submit]");
			if (emptySubmit) {
				void submitEmpty();
			}
		},
		{ signal },
	);

	accountSelect?.addEventListener(
		"change",
		() => {
			state.accountId = accountSelect.value || null;
			state.buildPath = "/";
			state.buildPathSource = "manual";
			state.detectedApps = [];
			syncBuildPathInputs();
			renderDetectedApps("unsupported");
			void loadReposForAccount();
		},
		{ signal },
	);

	branchSelect?.addEventListener(
		"change",
		() => {
			state.branch = branchSelect.value;
			state.buildPath = "/";
			state.buildPathSource = "manual";
			syncBuildPathInputs();
			void detectAppsForSelectedRepository();
		},
		{ signal },
	);

	buildPathInput?.addEventListener(
		"input",
		() => {
			if (state.buildPathSource !== "manual") return;
			state.buildPath = buildPathInput.value.trim() || "/";
		},
		{ signal },
	);

	buildPathOtherInput?.addEventListener(
		"input",
		() => {
			if (state.buildPathSource !== "other") return;
			state.buildPath = buildPathOtherInput.value.trim() || "/";
			if (buildPathInput) buildPathInput.value = state.buildPath;
			renderDetectedApps();
		},
		{ signal },
	);

	repoSearch?.addEventListener(
		"input",
		() => renderRepoList(repoSearch.value),
		{ signal },
	);

	nameInput?.addEventListener(
		"input",
		() => {
			const serviceName = slugify(nameInput.value.trim());
			if (appNameInput) {
				appNameInput.value = serviceName
					? `${ctx.projectSlug}-${serviceName}`
					: `${ctx.projectSlug}-`;
			}
		},
		{ signal },
	);

	emptyName?.addEventListener(
		"input",
		() => {
			const serviceName = slugify(emptyName.value.trim());
			if (emptyAppName) {
				emptyAppName.value = serviceName
					? `${ctx.projectSlug}-${serviceName}`
					: `${ctx.projectSlug}-`;
			}
		},
		{ signal },
	);

	envPaste?.addEventListener(
		"blur",
		() => {
			const parsed = parseEnvBlock(envPaste.value);
			if (parsed.length === 0) return;
			syncEnvRowsFromDom();
			const merged = state.envRows.filter((r) => r.key.trim());
			for (const row of parsed) merged.push(row);
			state.envRows = merged.length ? merged : [{ key: "", value: "" }];
			envPaste.value = "";
			renderEnvRows();
		},
		{ signal },
	);
}
