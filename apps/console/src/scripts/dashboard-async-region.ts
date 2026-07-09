type PageDataResponse =
	| { ok: true; shell: unknown; page: { html: string } }
	| { ok: false; code?: string; message?: string };

type DashboardRoutePayload = {
	routeId: string;
	params?: Record<string, string | null | undefined>;
	search?: string;
	orgSlug?: string | null;
	label?: string;
};

type NavigationState = DashboardRoutePayload & {
	nzDashboard: true;
	href: string;
	navKey?: string;
	shellMode?: string;
};

type DashboardFrameResponse = {
	frame: HTMLElement;
	title?: string;
};

const LOADED = "loaded";
const LOADING = "loading";
const MIN_VISIBLE_LOADING_MS = 120;
const PAGE_DATA_TIMEOUT_MS = 25_000;

let activeNavigation = 0;

function wait(ms: number) {
	return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

export function waitForDashboardPaint() {
	return new Promise<void>((resolve) => {
		window.requestAnimationFrame(() => {
			window.requestAnimationFrame(() => resolve());
		});
	});
}

function parseJsonAttr<T>(el: HTMLElement, name: string, fallback: T): T {
	const raw = el.getAttribute(name);
	if (!raw) return fallback;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

function rerunScripts(root: HTMLElement) {
	const scripts = Array.from(root.querySelectorAll("script"));
	for (const script of scripts) {
		const replacement = document.createElement("script");
		for (const attr of Array.from(script.attributes)) {
			replacement.setAttribute(attr.name, attr.value);
		}
		replacement.textContent = script.textContent;
		script.replaceWith(replacement);
	}
}

function escapeHtml(value: string) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;");
}

function loadingHtml(label = "Loading...") {
	return `
		<div class="nz-dashboard-content flex h-full min-h-[45vh] w-full items-center justify-center p-6 text-center text-xs text-[var(--nz-text-muted)]" role="status" aria-live="polite">
			<div class="grid justify-items-center gap-3">
				<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-4 animate-spin" aria-hidden="true">
					<path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
				</svg>
				<span>${escapeHtml(label)}</span>
			</div>
		</div>
	`;
}

export function renderDashboardLoading(root: HTMLElement, label?: string) {
	root.innerHTML = loadingHtml(label);
}

function showError(
	root: HTMLElement,
	message: string,
	retry: () => void,
) {
	root.innerHTML = `
		<div class="nz-dashboard-content flex h-full min-h-[45vh] w-full items-center justify-center p-6 text-center text-xs text-[var(--nz-text-muted)]">
			<div class="grid gap-3">
				<p>${escapeHtml(message || "Unable to load this page.")}</p>
				<button type="button" class="mx-auto rounded-md border border-[var(--nz-border)] bg-[var(--nz-bg-elevated)] px-3 py-1 text-xs text-[var(--nz-text)] hover:bg-[var(--nz-bg-hover)]" data-nz-dashboard-retry>
					Retry
				</button>
			</div>
		</div>
	`;
	root
		.querySelector("[data-nz-dashboard-retry]")
		?.addEventListener("click", () => {
			root.dataset.state = "";
			retry();
		});
}

function timeoutMessage(error: unknown) {
	if (error instanceof DOMException && error.name === "AbortError") {
		return "This page took too long to load. Try again.";
	}
	return error instanceof Error ? error.message : "Unable to load this page.";
}

async function fetchPageData(payload: DashboardRoutePayload) {
	const controller = new AbortController();
	const timeout = window.setTimeout(
		() => controller.abort(),
		PAGE_DATA_TIMEOUT_MS,
	);
	try {
		const response = await fetch("/api/console/page-data", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json",
			},
			credentials: "include",
			body: JSON.stringify(payload),
			signal: controller.signal,
		});
		let data: PageDataResponse;
		try {
			data = (await response.json()) as PageDataResponse;
		} catch {
			throw new Error("Unable to parse this page response.");
		}
		if (!response.ok || !data.ok) {
			throw new Error(!data.ok ? data.message : "Unable to load this page.");
		}
		return data;
	} finally {
		window.clearTimeout(timeout);
	}
}

async function fetchDashboardFrame(href: string): Promise<DashboardFrameResponse> {
	const controller = new AbortController();
	const timeout = window.setTimeout(
		() => controller.abort(),
		PAGE_DATA_TIMEOUT_MS,
	);
	try {
		const response = await fetch(href, {
			method: "GET",
			headers: {
				accept: "text/html",
			},
			credentials: "include",
			redirect: "follow",
			signal: controller.signal,
		});
		const html = await response.text();
		const finalPath = new URL(response.url).pathname;
		if (response.redirected && finalPath === "/login") {
			throw new Error("Sign in again to load this page.");
		}
		if (!response.ok) {
			throw new Error(html || "Unable to load this page.");
		}
		const documentFragment = new DOMParser().parseFromString(html, "text/html");
		const frame = documentFragment.querySelector<HTMLElement>(
			"[data-nz-dashboard-frame]",
		);
		if (!frame) throw new Error("Unable to find the dashboard frame.");
		return {
			frame,
			title: documentFragment.querySelector("title")?.textContent ?? undefined,
		};
	} finally {
		window.clearTimeout(timeout);
	}
}

function swapContent(root: HTMLElement, html: string) {
	root.innerHTML = html;
	rerunScripts(root);
	root.dataset.state = LOADED;
	document.dispatchEvent(new Event("astro:after-swap"));
	document.dispatchEvent(new Event("astro:page-load"));
}

function swapDashboardFrame(next: DashboardFrameResponse) {
	const frame = document.querySelector<HTMLElement>("[data-nz-dashboard-frame]");
	if (!frame) throw new Error("Unable to find the current dashboard frame.");
	frame.replaceWith(next.frame);
	if (next.title) document.title = next.title;
	rerunScripts(next.frame);
	document.dispatchEvent(new Event("astro:after-swap"));
	document.dispatchEvent(new Event("astro:page-load"));
}

async function loadIntoRoot(root: HTMLElement, payload: DashboardRoutePayload) {
	if (root.dataset.state === LOADING) return;
	root.dataset.state = LOADING;
	const startedAt = performance.now();
	const loadId = String(Date.now());
	root.dataset.loadId = loadId;

	try {
		await waitForDashboardPaint();
		const data = await fetchPageData(payload);
		if (root.dataset.loadId !== loadId) return;

		const elapsed = performance.now() - startedAt;
		if (elapsed < MIN_VISIBLE_LOADING_MS) {
			await wait(MIN_VISIBLE_LOADING_MS - elapsed);
		}
		swapContent(root, data.page.html);
	} catch (error) {
		if (root.dataset.loadId !== loadId) return;
		root.dataset.state = "error";
		showError(root, timeoutMessage(error), () => {
			renderDashboardLoading(root, payload.label);
			void loadIntoRoot(root, payload);
		});
	}
}

function routePayloadFromRegion(root: HTMLElement): DashboardRoutePayload | null {
	const routeId = root.dataset.routeId;
	if (!routeId) {
		showError(root, "Missing dashboard route.", () => {
			root.dataset.state = "";
			void loadRegion(root);
		});
		return null;
	}

	return {
		routeId,
		params: parseJsonAttr<Record<string, string>>(root, "data-route-params", {}),
		search: root.dataset.routeSearch || "",
		orgSlug: root.dataset.orgSlug || null,
		label: root.textContent?.trim() || "Loading...",
	};
}

async function loadRegion(root: HTMLElement) {
	if (root.dataset.state === LOADED || root.dataset.state === LOADING) return;
	const payload = routePayloadFromRegion(root);
	if (!payload) return;
	await loadIntoRoot(root, payload);
}

function closestDashboardLink(target: EventTarget | null) {
	return target instanceof Element ?
			target.closest<HTMLAnchorElement>('a[data-nz-dashboard-nav="1"]')
		:	null;
}

function isPlainDashboardClick(event: MouseEvent, link: HTMLAnchorElement) {
	if (event.defaultPrevented || event.button !== 0) return false;
	if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
	if (link.target && link.target !== "_self") return false;
	if (link.hasAttribute("download")) return false;
	const url = new URL(link.href, window.location.href);
	return url.origin === window.location.origin;
}

function dashboardShell() {
	return document.querySelector<HTMLElement>(".nz-dashboard-shell");
}

function currentShellMode() {
	return dashboardShell()?.dataset.nzShellMode || "normal";
}

function orgSlug() {
	return dashboardShell()?.dataset.nzOrgSlug || null;
}

function currentOutlet(targetShellMode: string | undefined) {
	const shellMode = currentShellMode();
	if (shellMode === "workspace" && targetShellMode === "workspace") {
		return document.querySelector<HTMLElement>(".nz-agent-main-region");
	}
	if (shellMode === "workspace") {
		return document.querySelector<HTMLElement>(".nz-agent-main-region");
	}
	return dashboardShell();
}

function setActiveNav(navKey: string | undefined) {
	if (!navKey) return;
	for (const item of Array.from(
		document.querySelectorAll<HTMLElement>("[data-nz-dashboard-nav]"),
	)) {
		const active = item.dataset.navKey === navKey;
		item.classList.toggle("nz-nav-item--active", active);
		item.classList.toggle("bg-[var(--nz-bg-hover)]", active);
		item.classList.toggle("text-[var(--nz-text)]", active);
		item.classList.toggle("bg-transparent", !active);
		item.classList.toggle("text-[var(--nz-text-muted)]", !active);
	}
}

function stateFromLink(link: HTMLAnchorElement, href: string): NavigationState | null {
	const routeId = link.dataset.routeId;
	if (!routeId) return null;
	const url = new URL(href, window.location.href);
	return {
		nzDashboard: true,
		href: url.pathname + url.search + url.hash,
		routeId,
		search: url.search,
		orgSlug: orgSlug(),
		label: link.dataset.loadingLabel || "Loading...",
		navKey: link.dataset.navKey,
		shellMode: link.dataset.shellMode || "normal",
	};
}

function replaceInitialHistoryState() {
	if (history.state?.nzDashboard) return;
	const activeLink =
		document.querySelector<HTMLAnchorElement>(
			'a[data-nz-dashboard-nav="1"].nz-nav-item--active',
		) ||
		document.querySelector<HTMLAnchorElement>('a[data-nz-dashboard-nav="1"]');
	if (!activeLink) return;
	const state = stateFromLink(activeLink, window.location.href);
	if (state) history.replaceState(state, "", window.location.href);
}

async function navigateWithState(state: NavigationState, options?: { push?: boolean }) {
	const outlet = currentOutlet(state.shellMode);
	if (!outlet) {
		window.location.assign(state.href);
		return;
	}

	const sameShell = currentShellMode() === (state.shellMode || "normal");
	const sequence = ++activeNavigation;
	outlet.dataset.state = "";
	delete outlet.dataset.loadId;
	renderDashboardLoading(outlet, state.label);
	setActiveNav(state.navKey);

	if (options?.push) {
		history.pushState(state, "", state.href);
	}

	await waitForDashboardPaint();
	if (sequence !== activeNavigation) return;

	if (!sameShell) {
		try {
			const nextFrame = await fetchDashboardFrame(state.href);
			if (sequence !== activeNavigation) return;
			swapDashboardFrame(nextFrame);
		} catch (error) {
			if (sequence !== activeNavigation) return;
			outlet.dataset.state = "error";
			showError(outlet, timeoutMessage(error), () => {
				renderDashboardLoading(outlet, state.label);
				void navigateWithState(state);
			});
		}
		return;
	}

	void loadIntoRoot(outlet, {
		routeId: state.routeId,
		params: state.params,
		search: state.search,
		orgSlug: state.orgSlug,
		label: state.label,
	});
}

export function navigateDashboardHref(
	href: string,
	options: {
		routeId: string;
		label?: string;
		navKey?: string;
		shellMode?: string;
		push?: boolean;
	}): boolean {
	const url = new URL(href, window.location.href);
	if (url.origin !== window.location.origin) return false;
	const state: NavigationState = {
		nzDashboard: true,
		href: url.pathname + url.search + url.hash,
		routeId: options.routeId,
		search: url.search,
		orgSlug: orgSlug(),
		label: options.label || "Loading...",
		navKey: options.navKey,
		shellMode: options.shellMode || "normal",
	};
	void navigateWithState(state, { push: options.push ?? true });
	return true;
}

function onSidebarClick(event: MouseEvent) {
	const link = closestDashboardLink(event.target);
	if (!link || !isPlainDashboardClick(event, link)) return;
	const url = new URL(link.href, window.location.href);
	if (url.pathname === window.location.pathname && url.search === window.location.search) {
		event.preventDefault();
		event.stopImmediatePropagation();
		return;
	}
	const state = stateFromLink(link, link.href);
	if (!state) return;

	event.preventDefault();
	event.stopImmediatePropagation();
	void navigateWithState(state, { push: true });
}

function onPopState(event: PopStateEvent) {
	const state = event.state as NavigationState | null;
	if (!state?.nzDashboard || !state.routeId) {
		window.location.assign(window.location.href);
		return;
	}
	void navigateWithState(state);
}

export function bindDashboardSidebarNavigation() {
	if (document.documentElement.dataset.nzDashboardSidebarRouter === "1") return;
	document.documentElement.dataset.nzDashboardSidebarRouter = "1";
	replaceInitialHistoryState();
	document.addEventListener("click", onSidebarClick, true);
	window.addEventListener("popstate", onPopState);
}

export function bootDashboardAsyncRegions() {
	for (const root of Array.from(
		document.querySelectorAll<HTMLElement>("[data-nz-dashboard-async]"),
	)) {
		void loadRegion(root);
	}
}
