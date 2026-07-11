import { format } from "date-fns";
import { setButtonLoadingVisuals } from "@/lib/auth-button-state";
import { trpcMutate, trpcQuery } from "@/lib/client-api";
import { getGiteaOAuthUrl } from "@/lib/gitea-utils";
import { getGitlabAuthUrl } from "@/lib/gitlab-utils";
import {
	githubAppManifestAction,
	normalizeGithubOrganizationSlug,
} from "@/lib/github-app-manifest";
import { closeDialog, openDialog, showToast } from "@/scripts/ui";

type Bootstrap = {
	gitProviderBaseUrl: string;
	gitProviderBaseUrlIsLocal: boolean;
	organizationId: string;
	userId: string;
	authId: string;
	returnTo: string;
};

function setGitSubmitBusy(button: HTMLButtonElement | null, busy: boolean) {
	if (!button) return;
	button.disabled = busy;
	button.setAttribute("aria-busy", busy ? "true" : "false");
	setButtonLoadingVisuals(button, busy);
}

function parseBootstrap(): Bootstrap {
	const root = document.getElementById("nz-git-providers-root");
	return {
		gitProviderBaseUrl:
			root?.dataset.gitProviderBaseUrl?.replace(/\/+$/, "") ||
			window.location.origin,
		gitProviderBaseUrlIsLocal:
			root?.dataset.gitProviderBaseUrlLocal === "1",
		organizationId: root?.dataset.organizationId ?? "",
		userId: root?.dataset.userId ?? "",
		authId: root?.dataset.authId ?? "",
		returnTo: safeReturnTo(new URLSearchParams(window.location.search).get("returnTo")),
	};
}

const GIT_PROVIDER_RETURN_TO_KEY = "nearzero.gitProvider.returnTo";

function safeReturnTo(value: string | null) {
	if (!value) return "";
	try {
		const url = new URL(value, window.location.origin);
		return url.origin === window.location.origin
			? `${url.pathname}${url.search}${url.hash}`
			: "";
	} catch {
		return value.startsWith("/") && !value.startsWith("//") ? value : "";
	}
}

function rememberReturnTo(returnTo: string) {
	if (returnTo) window.sessionStorage.setItem(GIT_PROVIDER_RETURN_TO_KEY, returnTo);
}

function finishProviderSetup() {
	const returnTo =
		safeReturnTo(new URLSearchParams(window.location.search).get("returnTo")) ||
		safeReturnTo(window.sessionStorage.getItem(GIT_PROVIDER_RETURN_TO_KEY));
	if (returnTo) {
		window.sessionStorage.removeItem(GIT_PROVIDER_RETURN_TO_KEY);
		window.location.href = returnTo;
		return;
	}
	window.location.reload();
}

function randomString() {
	return Math.random().toString(36).slice(2, 8);
}

export function mountGitProvidersDashboard() {
	const root = document.getElementById("nz-git-providers-root");
	if (!root || root.dataset.bound === "1") return;
	root.dataset.bound = "1";

	const bootstrap = parseBootstrap();
	rememberReturnTo(bootstrap.returnTo);
	const githubOrganizationSwitch = document.getElementById(
		"nz-git-github-org-switch",
	) as HTMLInputElement | null;
	const githubOrganizationInput = document.getElementById(
		"nz-git-github-org-name",
	) as HTMLInputElement | null;
	const githubOrganizationField = document.querySelector(
		".nz-github-org-field",
	) as HTMLElement | null;
	let pendingDeleteId = "";
	let pendingDeleteShared = false;
	let editingProvider: { type: string; id: string } | null = null;

	const updateGithubManifest = () => {
		const manifestInput = document.getElementById("nz-git-github-manifest") as HTMLInputElement | null;
		if (!manifestInput) return;
		const url = bootstrap.gitProviderBaseUrl;
		const returnToQuery = bootstrap.returnTo
			? `&returnTo=${encodeURIComponent(bootstrap.returnTo)}`
			: "";
		manifestInput.value = JSON.stringify(
			{
				redirect_url: `${url}/api/providers/github/setup?organizationId=${bootstrap.organizationId}&userId=${bootstrap.userId}${returnToQuery}`,
				name: `Nearzero-${format(new Date(), "yyyy-MM-dd")}-${randomString()}`,
				url,
				hook_attributes: { url: `${url}/api/deploy/github` },
				callback_urls: [`${url}/api/providers/github/setup`],
				public: false,
				request_oauth_on_install: true,
				default_permissions: {
					contents: "read",
					metadata: "read",
					emails: "read",
					pull_requests: "write",
				},
				default_events: ["pull_request", "push"],
			},
			null,
			4,
		);
		const form = document.getElementById("nz-git-github-form") as HTMLFormElement | null;
		if (form) {
			const action = githubAppManifestAction({
				organizationId: bootstrap.organizationId,
				userId: bootstrap.userId,
				useGithubOrganization: githubOrganizationSwitch?.checked ?? false,
				githubOrganizationSlug: githubOrganizationInput?.value ?? "",
			});
			if (action) form.action = action;
			else form.removeAttribute("action");
		}
	};

	const syncGithubOrganizationMode = () => {
		const useOrganization = githubOrganizationSwitch?.checked ?? false;
		githubOrganizationField?.classList.toggle("hidden", !useOrganization);
		if (githubOrganizationInput) {
			githubOrganizationInput.required = useOrganization;
			if (!useOrganization) githubOrganizationInput.setCustomValidity("");
		}
		updateGithubManifest();
	};

	root.addEventListener("click", (e) => {
		const t = e.target instanceof Element ? e.target.closest("[data-git-action]") : null;
		if (!(t instanceof HTMLElement)) return;
		const action = t.dataset.gitAction;
		if (action === "open-add-github") openConnectDialog("github");
		else if (action === "open-add-gitlab") {
			openConnectDialog("gitlab");
		} else if (action === "open-add-bitbucket") openConnectDialog("bitbucket");
		else if (action === "open-add-gitea") {
			openConnectDialog("gitea");
		} else if (action === "edit") {
			editingProvider = { type: t.dataset.providerType ?? "", id: t.dataset.providerRef ?? "" };
			if (editingProvider.type === "github") void openEditGithub(editingProvider.id);
			else if (editingProvider.type === "gitlab") void openEditGitlab(editingProvider.id);
			else if (editingProvider.type === "bitbucket") void openEditBitbucket(editingProvider.id);
			else if (editingProvider.type === "gitea") void openEditGitea(editingProvider.id);
		} else if (action === "delete") {
			pendingDeleteId = t.dataset.gitProviderId ?? "";
			pendingDeleteShared = t.dataset.shared === "1";
			openDialog("nz-git-delete-dialog");
			const desc = document.getElementById("nz-git-delete-desc");
			if (desc) {
				desc.textContent = pendingDeleteShared
					? "This provider is shared with the organization. Deleting it will remove access for all members. Are you sure?"
					: "Are you sure you want to delete this Git Provider?";
			}
		}
	});

	const openConnectDialog = (providerType: string) => {
		if (providerType === "github") {
			updateGithubManifest();
			openDialog("nz-git-github-dialog");
			if (bootstrap.gitProviderBaseUrlIsLocal) {
				showToast(
					"GitHub needs a public HTTPS callback URL. Configure a domain in Web Server settings first.",
					"error",
				);
			}
			return;
		}
		if (providerType === "gitlab") {
			const redirect = document.getElementById("nz-git-gitlab-redirect") as HTMLInputElement | null;
			if (redirect) redirect.value = `${bootstrap.gitProviderBaseUrl}/api/providers/gitlab/callback`;
			openDialog("nz-git-gitlab-dialog");
			return;
		}
		if (providerType === "bitbucket") {
			openDialog("nz-git-bitbucket-dialog");
			return;
		}
		if (providerType === "gitea") {
			const redirect = document.getElementById("nz-git-gitea-redirect") as HTMLInputElement | null;
			if (redirect) redirect.value = `${bootstrap.gitProviderBaseUrl}/api/providers/gitea/callback`;
			openDialog("nz-git-gitea-dialog");
		}
	};

	root.addEventListener("change", async (e) => {
		const t = e.target instanceof Element ? e.target.closest("[data-git-share]") : null;
		if (!(t instanceof HTMLInputElement)) return;
		const gitProviderId = t.dataset.gitShare ?? "";
		try {
			await trpcMutate("gitProvider.toggleShare", {
				gitProviderId,
				sharedWithOrganization: t.checked,
			});
			showToast(t.checked ? "Provider shared with organization" : "Provider unshared", "success");
		} catch {
			showToast("Error updating sharing", "error");
			t.checked = !t.checked;
		}
	});

	const openEditGithub = async (githubId: string) => {
		try {
			const data = await trpcQuery<any>("github.one", { githubId });
			(document.getElementById("nz-git-edit-github-id") as HTMLInputElement).value = githubId;
			(document.getElementById("nz-git-edit-github-git-provider-id") as HTMLInputElement).value = data.gitProviderId ?? "";
			(document.getElementById("nz-git-edit-github-name") as HTMLInputElement).value = data.gitProvider?.name ?? "";
			(document.getElementById("nz-git-edit-github-app") as HTMLInputElement).value = data.githubAppName ?? "";
			openDialog("nz-git-edit-github-dialog");
		} catch {
			showToast("Failed to load GitHub provider", "error");
		}
	};

	const openEditGitlab = async (gitlabId: string) => {
		try {
			const data = await trpcQuery<any>("gitlab.one", { gitlabId });
			(document.getElementById("nz-git-edit-gitlab-id") as HTMLInputElement).value = gitlabId;
			(document.getElementById("nz-git-edit-gitlab-git-provider-id") as HTMLInputElement).value = data.gitProviderId ?? "";
			(document.getElementById("nz-git-edit-gitlab-name") as HTMLInputElement).value = data.gitProvider?.name ?? "";
			(document.getElementById("nz-git-edit-gitlab-url") as HTMLInputElement).value = data.gitlabUrl ?? "";
			(document.getElementById("nz-git-edit-gitlab-internal") as HTMLInputElement).value = data.gitlabInternalUrl ?? "";
			(document.getElementById("nz-git-edit-gitlab-group") as HTMLInputElement).value = data.groupName ?? "";
			openDialog("nz-git-edit-gitlab-dialog");
		} catch {
			showToast("Failed to load GitLab provider", "error");
		}
	};

	const openEditBitbucket = async (bitbucketId: string) => {
		try {
			const data = await trpcQuery<any>("bitbucket.one", { bitbucketId });
			(document.getElementById("nz-git-edit-bitbucket-id") as HTMLInputElement).value = bitbucketId;
			(document.getElementById("nz-git-edit-bitbucket-git-provider-id") as HTMLInputElement).value = data.gitProviderId ?? "";
			(document.getElementById("nz-git-edit-bitbucket-name") as HTMLInputElement).value = data.gitProvider?.name ?? "";
			(document.getElementById("nz-git-edit-bitbucket-username") as HTMLInputElement).value = data.bitbucketUsername ?? "";
			(document.getElementById("nz-git-edit-bitbucket-email") as HTMLInputElement).value = data.bitbucketEmail ?? "";
			(document.getElementById("nz-git-edit-bitbucket-workspace") as HTMLInputElement).value = data.bitbucketWorkspaceName ?? "";
			(document.getElementById("nz-git-edit-bitbucket-token") as HTMLInputElement).value = data.apiToken ?? "";
			(document.getElementById("nz-git-edit-bitbucket-app-password") as HTMLInputElement).value = data.appPassword ?? "";
			openDialog("nz-git-edit-bitbucket-dialog");
		} catch {
			showToast("Failed to load Bitbucket provider", "error");
		}
	};

	const openEditGitea = async (giteaId: string) => {
		try {
			const data = await trpcQuery<any>("gitea.one", { giteaId });
			(document.getElementById("nz-git-edit-gitea-id") as HTMLInputElement).value = giteaId;
			(document.getElementById("nz-git-edit-gitea-git-provider-id") as HTMLInputElement).value = data.gitProvider?.gitProviderId ?? "";
			(document.getElementById("nz-git-edit-gitea-name") as HTMLInputElement).value = data.gitProvider?.name ?? "";
			(document.getElementById("nz-git-edit-gitea-url") as HTMLInputElement).value = data.giteaUrl ?? "";
			(document.getElementById("nz-git-edit-gitea-internal") as HTMLInputElement).value = data.giteaInternalUrl ?? "";
			(document.getElementById("nz-git-edit-gitea-client-id") as HTMLInputElement).value = data.clientId ?? "";
			(document.getElementById("nz-git-edit-gitea-client-secret") as HTMLInputElement).value = data.clientSecret ?? "";
			openDialog("nz-git-edit-gitea-dialog");
		} catch {
			showToast("Failed to load Gitea provider", "error");
		}
	};

	document.getElementById("nz-git-github-form")?.addEventListener("submit", (event) => {
		if (
			githubOrganizationSwitch?.checked &&
			!normalizeGithubOrganizationSlug(githubOrganizationInput?.value ?? "")
		) {
			event.preventDefault();
			githubOrganizationField?.classList.remove("hidden");
			githubOrganizationInput?.setCustomValidity(
				"Enter the GitHub organization slug, for example acme-corp.",
			);
			githubOrganizationInput?.reportValidity();
			githubOrganizationInput?.focus();
			showToast("Enter a valid GitHub organization slug.", "error");
			return;
		}
		updateGithubManifest();
		setGitSubmitBusy(
			document.getElementById("nz-git-github-submit") as HTMLButtonElement | null,
			true,
		);
	});

	githubOrganizationSwitch?.addEventListener(
		"change",
		syncGithubOrganizationMode,
	);
	githubOrganizationInput?.addEventListener("input", () => {
		githubOrganizationInput.setCustomValidity("");
		updateGithubManifest();
	});
	document.querySelector("[data-git-action='open-add-github']")?.addEventListener("click", updateGithubManifest);
	syncGithubOrganizationMode();

	const connectProvider = new URLSearchParams(window.location.search).get("connect");
	if (connectProvider) {
		window.setTimeout(() => openConnectDialog(connectProvider), 0);
	}

	document.getElementById("nz-git-gitlab-form")?.addEventListener("submit", async (e) => {
		e.preventDefault();
		const submit = document.getElementById("nz-git-gitlab-submit") as HTMLButtonElement;
		setGitSubmitBusy(submit, true);
		try {
			const result = await trpcMutate<any>("gitlab.create", {
				name: (document.getElementById("nz-git-gitlab-name") as HTMLInputElement).value,
				gitlabUrl: (document.getElementById("nz-git-gitlab-url") as HTMLInputElement).value,
				gitlabInternalUrl: (document.getElementById("nz-git-gitlab-internal") as HTMLInputElement).value || undefined,
				applicationId: (document.getElementById("nz-git-gitlab-app-id") as HTMLInputElement).value,
				secret: (document.getElementById("nz-git-gitlab-secret") as HTMLInputElement).value,
				groupName: (document.getElementById("nz-git-gitlab-group") as HTMLInputElement).value,
				redirectUri: (document.getElementById("nz-git-gitlab-redirect") as HTMLInputElement).value,
				authId: bootstrap.authId,
			});
			showToast("GitLab created successfully", "success");
			closeDialog("nz-git-gitlab-dialog");
			const gitlabId = (result as any)?.gitlabId;
			if (bootstrap.returnTo && gitlabId) {
				rememberReturnTo(bootstrap.returnTo);
				window.location.href = getGitlabAuthUrl(
					(document.getElementById("nz-git-gitlab-app-id") as HTMLInputElement).value,
					gitlabId,
					(document.getElementById("nz-git-gitlab-url") as HTMLInputElement).value || "https://gitlab.com",
					bootstrap.gitProviderBaseUrl,
				);
			} else {
				finishProviderSetup();
			}
		} catch {
			showToast("Error configuring GitLab", "error");
			setGitSubmitBusy(submit, false);
		}
	});

	document.getElementById("nz-git-bitbucket-form")?.addEventListener("submit", async (e) => {
		e.preventDefault();
		const submit = document.getElementById("nz-git-bitbucket-submit") as HTMLButtonElement;
		setGitSubmitBusy(submit, true);
		try {
			await trpcMutate("bitbucket.create", {
				name: (document.getElementById("nz-git-bitbucket-name") as HTMLInputElement).value,
				bitbucketUsername: (document.getElementById("nz-git-bitbucket-username") as HTMLInputElement).value,
				bitbucketEmail: (document.getElementById("nz-git-bitbucket-email") as HTMLInputElement).value,
				apiToken: (document.getElementById("nz-git-bitbucket-token") as HTMLInputElement).value,
				bitbucketWorkspaceName: (document.getElementById("nz-git-bitbucket-workspace") as HTMLInputElement).value,
				authId: bootstrap.authId,
			});
			showToast("Bitbucket configured successfully", "success");
			closeDialog("nz-git-bitbucket-dialog");
			finishProviderSetup();
		} catch {
			showToast("Error configuring Bitbucket", "error");
			setGitSubmitBusy(submit, false);
		}
	});

	document.getElementById("nz-git-gitea-form")?.addEventListener("submit", async (e) => {
		e.preventDefault();
		const submit = document.getElementById("nz-git-gitea-submit") as HTMLButtonElement;
		setGitSubmitBusy(submit, true);
		try {
			const result = await trpcMutate<any>("gitea.create", {
				name: (document.getElementById("nz-git-gitea-name") as HTMLInputElement).value,
				giteaUrl: (document.getElementById("nz-git-gitea-url") as HTMLInputElement).value,
				giteaInternalUrl: (document.getElementById("nz-git-gitea-internal") as HTMLInputElement).value || undefined,
				clientId: (document.getElementById("nz-git-gitea-client-id") as HTMLInputElement).value,
				clientSecret: (document.getElementById("nz-git-gitea-client-secret") as HTMLInputElement).value,
				redirectUri: (document.getElementById("nz-git-gitea-redirect") as HTMLInputElement).value,
				organizationName: (document.getElementById("nz-git-gitea-org") as HTMLInputElement).value,
			});
			const authUrl = getGiteaOAuthUrl(result.giteaId, result.clientId, result.giteaUrl, bootstrap.gitProviderBaseUrl);
			if (authUrl !== "#") {
				rememberReturnTo(bootstrap.returnTo);
				if (bootstrap.returnTo) window.location.href = authUrl;
				else window.open(authUrl, "_blank");
			}
			showToast("Gitea provider created successfully", "success");
			closeDialog("nz-git-gitea-dialog");
			if (!bootstrap.returnTo) window.location.reload();
		} catch (err) {
			showToast(err instanceof Error ? err.message : "Error configuring Gitea", "error");
			setGitSubmitBusy(submit, false);
		}
	});

	document.getElementById("nz-git-edit-github-form")?.addEventListener("submit", async (e) => {
		e.preventDefault();
		const submit = document.getElementById("nz-git-edit-github-submit") as HTMLButtonElement;
		const githubId = (document.getElementById("nz-git-edit-github-id") as HTMLInputElement).value;
		setGitSubmitBusy(submit, true);
		try {
			await trpcMutate("github.update", {
				githubId,
				name: (document.getElementById("nz-git-edit-github-name") as HTMLInputElement).value,
				githubAppName: (document.getElementById("nz-git-edit-github-app") as HTMLInputElement).value,
				gitProviderId: (document.getElementById("nz-git-edit-github-git-provider-id") as HTMLInputElement).value,
			});
			showToast("Github updated successfully", "success");
			closeDialog("nz-git-edit-github-dialog");
			window.location.reload();
		} catch {
			showToast("Error updating Github", "error");
			setGitSubmitBusy(submit, false);
		}
	});

	document.getElementById("nz-git-edit-github-test")?.addEventListener("click", async () => {
		const githubId = (document.getElementById("nz-git-edit-github-id") as HTMLInputElement).value;
		try {
			const msg = await trpcMutate<string>("github.testConnection", { githubId });
			showToast(`Message: ${msg}`, "success");
		} catch (err) {
			showToast(err instanceof Error ? err.message : "Error testing connection", "error");
		}
	});

	document.getElementById("nz-git-edit-gitlab-form")?.addEventListener("submit", async (e) => {
		e.preventDefault();
		const submit = document.getElementById("nz-git-edit-gitlab-submit") as HTMLButtonElement;
		setGitSubmitBusy(submit, true);
		try {
			await trpcMutate("gitlab.update", {
				gitlabId: (document.getElementById("nz-git-edit-gitlab-id") as HTMLInputElement).value,
				gitProviderId: (document.getElementById("nz-git-edit-gitlab-git-provider-id") as HTMLInputElement).value,
				name: (document.getElementById("nz-git-edit-gitlab-name") as HTMLInputElement).value,
				gitlabUrl: (document.getElementById("nz-git-edit-gitlab-url") as HTMLInputElement).value,
				gitlabInternalUrl: (document.getElementById("nz-git-edit-gitlab-internal") as HTMLInputElement).value || null,
				groupName: (document.getElementById("nz-git-edit-gitlab-group") as HTMLInputElement).value,
			});
			showToast("Gitlab updated successfully", "success");
			closeDialog("nz-git-edit-gitlab-dialog");
			window.location.reload();
		} catch {
			showToast("Error updating Gitlab", "error");
			setGitSubmitBusy(submit, false);
		}
	});

	document.getElementById("nz-git-edit-gitlab-test")?.addEventListener("click", async () => {
		try {
			const msg = await trpcMutate<string>("gitlab.testConnection", {
				gitlabId: (document.getElementById("nz-git-edit-gitlab-id") as HTMLInputElement).value,
				groupName: (document.getElementById("nz-git-edit-gitlab-group") as HTMLInputElement).value,
			});
			showToast(`Message: ${msg}`, "success");
		} catch (err) {
			showToast(err instanceof Error ? err.message : "Error testing connection", "error");
		}
	});

	document.getElementById("nz-git-edit-bitbucket-form")?.addEventListener("submit", async (e) => {
		e.preventDefault();
		const submit = document.getElementById("nz-git-edit-bitbucket-submit") as HTMLButtonElement;
		setGitSubmitBusy(submit, true);
		try {
			await trpcMutate("bitbucket.update", {
				bitbucketId: (document.getElementById("nz-git-edit-bitbucket-id") as HTMLInputElement).value,
				gitProviderId: (document.getElementById("nz-git-edit-bitbucket-git-provider-id") as HTMLInputElement).value,
				name: (document.getElementById("nz-git-edit-bitbucket-name") as HTMLInputElement).value,
				bitbucketUsername: (document.getElementById("nz-git-edit-bitbucket-username") as HTMLInputElement).value,
				bitbucketEmail: (document.getElementById("nz-git-edit-bitbucket-email") as HTMLInputElement).value,
				bitbucketWorkspaceName: (document.getElementById("nz-git-edit-bitbucket-workspace") as HTMLInputElement).value,
				apiToken: (document.getElementById("nz-git-edit-bitbucket-token") as HTMLInputElement).value,
				appPassword: (document.getElementById("nz-git-edit-bitbucket-app-password") as HTMLInputElement).value,
			});
			showToast("Bitbucket updated successfully", "success");
			closeDialog("nz-git-edit-bitbucket-dialog");
			window.location.reload();
		} catch {
			showToast("Error updating Bitbucket", "error");
			setGitSubmitBusy(submit, false);
		}
	});

	document.getElementById("nz-git-edit-bitbucket-test")?.addEventListener("click", async () => {
		try {
			const msg = await trpcMutate<string>("bitbucket.testConnection", {
				bitbucketId: (document.getElementById("nz-git-edit-bitbucket-id") as HTMLInputElement).value,
				bitbucketUsername: (document.getElementById("nz-git-edit-bitbucket-username") as HTMLInputElement).value,
				bitbucketEmail: (document.getElementById("nz-git-edit-bitbucket-email") as HTMLInputElement).value,
				workspaceName: (document.getElementById("nz-git-edit-bitbucket-workspace") as HTMLInputElement).value,
				apiToken: (document.getElementById("nz-git-edit-bitbucket-token") as HTMLInputElement).value,
				appPassword: (document.getElementById("nz-git-edit-bitbucket-app-password") as HTMLInputElement).value,
			});
			showToast(`Message: ${msg}`, "success");
		} catch (err) {
			showToast(err instanceof Error ? err.message : "Error testing connection", "error");
		}
	});

	document.getElementById("nz-git-edit-gitea-form")?.addEventListener("submit", async (e) => {
		e.preventDefault();
		const submit = document.getElementById("nz-git-edit-gitea-submit") as HTMLButtonElement;
		setGitSubmitBusy(submit, true);
		try {
			await trpcMutate("gitea.update", {
				giteaId: (document.getElementById("nz-git-edit-gitea-id") as HTMLInputElement).value,
				gitProviderId: (document.getElementById("nz-git-edit-gitea-git-provider-id") as HTMLInputElement).value,
				name: (document.getElementById("nz-git-edit-gitea-name") as HTMLInputElement).value,
				giteaUrl: (document.getElementById("nz-git-edit-gitea-url") as HTMLInputElement).value,
				giteaInternalUrl: (document.getElementById("nz-git-edit-gitea-internal") as HTMLInputElement).value || null,
				clientId: (document.getElementById("nz-git-edit-gitea-client-id") as HTMLInputElement).value,
				clientSecret: (document.getElementById("nz-git-edit-gitea-client-secret") as HTMLInputElement).value,
			});
			showToast("Gitea provider updated successfully", "success");
			closeDialog("nz-git-edit-gitea-dialog");
			window.location.reload();
		} catch {
			showToast("Error updating Gitea provider", "error");
			setGitSubmitBusy(submit, false);
		}
	});

	document.getElementById("nz-git-edit-gitea-test")?.addEventListener("click", async () => {
		const giteaId = (document.getElementById("nz-git-edit-gitea-id") as HTMLInputElement).value;
		try {
			const result = await trpcMutate<string>("gitea.testConnection", { giteaId });
			showToast(`Gitea Connection Verified: ${result}`, "success");
		} catch (err: any) {
			const clientId = (document.getElementById("nz-git-edit-gitea-client-id") as HTMLInputElement).value;
			const giteaUrl = (document.getElementById("nz-git-edit-gitea-url") as HTMLInputElement).value;
			const authUrl = err?.authorizationUrl || getGiteaOAuthUrl(giteaId, clientId, giteaUrl, bootstrap.gitProviderBaseUrl);
			showToast(err?.message || "Please complete OAuth authorization", "error");
			if (authUrl && authUrl !== "#") window.open(authUrl, "_blank");
		}
	});

	document.getElementById("nz-git-edit-gitea-connect")?.addEventListener("click", () => {
		const giteaId = (document.getElementById("nz-git-edit-gitea-id") as HTMLInputElement).value;
		const clientId = (document.getElementById("nz-git-edit-gitea-client-id") as HTMLInputElement).value;
		const giteaUrl = (document.getElementById("nz-git-edit-gitea-url") as HTMLInputElement).value;
		const authUrl = getGiteaOAuthUrl(giteaId, clientId, giteaUrl, bootstrap.gitProviderBaseUrl);
		if (authUrl !== "#") window.open(authUrl, "_blank");
	});

	document.getElementById("nz-git-delete-confirm")?.addEventListener("click", async () => {
		if (!pendingDeleteId) return;
		try {
			await trpcMutate("gitProvider.remove", { gitProviderId: pendingDeleteId });
			showToast("Git Provider deleted successfully", "success");
			closeDialog("nz-git-delete-dialog");
			window.location.reload();
		} catch {
			showToast("Error deleting Git Provider", "error");
		} finally {
			pendingDeleteId = "";
		}
	});

	document.getElementById("nz-git-delete-cancel")?.addEventListener("click", () => {
		pendingDeleteId = "";
		closeDialog("nz-git-delete-dialog");
	});

	// Gitea OAuth callback query params
	const params = new URLSearchParams(window.location.search);
	if (params.get("connected")) {
		showToast("Git provider connected successfully", "success");
		const returnTo = safeReturnTo(window.sessionStorage.getItem(GIT_PROVIDER_RETURN_TO_KEY));
		if (returnTo) {
			window.sessionStorage.removeItem(GIT_PROVIDER_RETURN_TO_KEY);
			window.location.href = returnTo;
		} else {
			window.history.replaceState({}, "", window.location.pathname);
		}
	} else if (params.get("error")) {
		showToast(`Gitea Connection Failed: ${decodeURIComponent(params.get("error")!)}`, "error");
		window.history.replaceState({}, "", window.location.pathname);
	}
}
