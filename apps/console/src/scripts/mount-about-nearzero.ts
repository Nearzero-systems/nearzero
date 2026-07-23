import {
	bindCopyServerIp,
	bindPublicDomainDialog,
} from "@/scripts/web-server-shared";

type RootEx = HTMLElement & { __nzAboutTeardown?: () => void };

let pageLoadBound = false;

function bindAboutNearzeroPage() {
	const root = document.getElementById("nz-about-nearzero-root");
	if (!(root instanceof HTMLElement)) return;

	const r = root as RootEx;
	r.__nzAboutTeardown?.();
	const ac = new AbortController();
	r.__nzAboutTeardown = () => ac.abort();

	if (document.getElementById("nz-ws-copy-ip")) {
		bindCopyServerIp(ac.signal);
	}
	bindPublicDomainDialog(root, ac.signal);
}

export function mountAboutNearzeroDashboard() {
	bindAboutNearzeroPage();
	if (pageLoadBound) return;
	pageLoadBound = true;
	document.addEventListener("astro:page-load", bindAboutNearzeroPage);
	document.addEventListener("astro:after-swap", bindAboutNearzeroPage);
}
