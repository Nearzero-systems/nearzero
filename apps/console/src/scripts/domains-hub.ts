import { trpcMutate, trpcQuery } from "@/lib/client-api";
import { validateDomainWithEdgeIp } from "@/lib/managed-domain-client";
import { NZ_TOAST_EVENT } from "@/lib/nzToast";
import {
	initCertificatesPanel,
	openCertificateCreateDialog,
} from "@/scripts/certificates-panel";
import { openDialog } from "@/scripts/ui";

type ZoneRow = {
	dnsZoneId: string;
	name: string;
	status: string;
	nameservers?: string[];
	records: Array<{
		dnsRecordId: string;
		name: string;
		type: string;
		value: string;
		ttl?: number | null;
		priority?: number | null;
		managedBy?: string;
	}>;
};

type ProjectOption = {
	projectId: string;
	name: string;
	environments: Array<{
		environmentId: string;
		name: string;
		applications: Array<{
			applicationId: string;
			name?: string;
			appName?: string;
			serverId?: string | null;
		}>;
		compose: Array<{
			composeId: string;
			name: string;
			serverId?: string | null;
		}>;
	}>;
};

function toast(message: string, variant?: "success" | "error") {
	document.dispatchEvent(
		new CustomEvent(NZ_TOAST_EVENT, {
			bubbles: true,
			detail: { message, variant },
		}),
	);
}

function readJson<T>(id: string, fallback: T): T {
	const el = document.getElementById(id);
	if (!el?.textContent) return fallback;
	try {
		return JSON.parse(el.textContent) as T;
	} catch {
		return fallback;
	}
}

function escapeHtml(value: unknown) {
	return String(value ?? "").replace(/[&<>"']/g, (char) => {
		switch (char) {
			case "&":
				return "&amp;";
			case "<":
				return "&lt;";
			case ">":
				return "&gt;";
			case '"':
				return "&quot;";
			default:
				return "&#39;";
		}
	});
}

function parseNameservers(value: string) {
	return Array.from(
		new Set(
			value
				.split(/[,\s]+/)
				.map((part) => part.trim().toLowerCase().replace(/\.$/, ""))
				.filter(Boolean),
		),
	);
}

function normalizeRoutePath(value: string | null | undefined) {
	const trimmed = (value ?? "").trim();
	if (!trimmed) return "/";
	return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function serviceSelectValue(
	type: "application" | "compose",
	id: string,
	serviceName?: string,
) {
	return `${type}:${id}:${encodeURIComponent(serviceName ?? "")}`;
}

function parseServiceSelectValue(value: string) {
	const [type, id, encodedService = ""] = value.split(":");
	return {
		type,
		id,
		serviceName: decodeURIComponent(encodedService),
	};
}

function bindAddNewMenu(root: HTMLElement, signal?: AbortSignal) {
	const toggle = root.querySelector<HTMLButtonElement>(
		"[data-domains-add-toggle]",
	);
	const menu = root.querySelector<HTMLElement>("[data-domains-add-menu]");
	if (!toggle || !menu) return;
	const opts = signal ? { signal } : undefined;

	toggle.addEventListener(
		"click",
		(e) => {
			e.stopPropagation();
			const open = !menu.classList.contains("hidden");
			menu.classList.toggle("hidden", open);
			toggle.setAttribute("aria-expanded", open ? "false" : "true");
		},
		opts,
	);

	document.addEventListener(
		"click",
		(e) => {
			if (!root.contains(e.target as Node)) {
				menu.classList.add("hidden");
				toggle.setAttribute("aria-expanded", "false");
			}
		},
		opts,
	);

	for (const item of root.querySelectorAll<HTMLButtonElement>(
		"[data-domains-add-action]",
	)) {
		item.addEventListener(
			"click",
			() => {
				menu.classList.add("hidden");
				toggle.setAttribute("aria-expanded", "false");
				const action = item.getAttribute("data-domains-add-action");
				if (action === "hostname") {
					const external = document.querySelector<HTMLInputElement>(
						'#nz-add-hostname-form input[name="dnsMode"][value="external"]',
					);
					if (external) external.checked = true;
					external?.dispatchEvent(new Event("change", { bubbles: true }));
					openDialog("nz-add-hostname-dialog");
				} else if (action === "connect-domain" || action === "dns-zone") {
					openDialog("nz-dns-create-dialog");
				} else if (action === "bind-env") {
					openDialog("nz-bind-env-dialog");
				} else if (action === "certificate") {
					openCertificateCreateDialog();
				}
			},
			opts,
		);
	}
}

function bindDomainsSearch(signal?: AbortSignal) {
	const wrap = document.getElementById("nz-domains-search-root");
	if (!wrap) return;

	const toggle = document.getElementById("nz-domains-search-toggle");
	const panel = document.getElementById("nz-domains-search-panel");
	const input = document.getElementById("nz-domains-search");
	const form = document.getElementById("nz-domains-filter-form");

	if (
		!(toggle instanceof HTMLButtonElement) ||
		!(panel instanceof HTMLElement) ||
		!(input instanceof HTMLInputElement)
	) {
		return;
	}
	const opts = signal ? { signal } : undefined;

	const openClasses = [
		"w-44",
		"sm:w-52",
		"px-2",
		"opacity-100",
		"pointer-events-auto",
		"border-[var(--nz-border)]",
	];
	const closedClasses = [
		"w-0",
		"px-0",
		"opacity-0",
		"pointer-events-none",
		"border-transparent",
	];

	const openSearch = () => {
		toggle.setAttribute("aria-expanded", "true");
		panel.classList.remove(...closedClasses);
		panel.classList.add(...openClasses);
		window.setTimeout(() => input.focus(), 120);
	};

	const closeSearch = () => {
		toggle.setAttribute("aria-expanded", "false");
		panel.classList.remove(...openClasses);
		panel.classList.add(...closedClasses);
		input.blur();
	};

	toggle.addEventListener(
		"click",
		(event) => {
			event.stopPropagation();
			const expanded = toggle.getAttribute("aria-expanded") === "true";
			if (expanded) closeSearch();
			else openSearch();
		},
		opts,
	);

	document.addEventListener(
		"click",
		(event) => {
			if (!(event.target instanceof Node)) return;
			if (!wrap.contains(event.target)) closeSearch();
		},
		opts,
	);

	input.addEventListener(
		"keydown",
		(event) => {
			if (event.key === "Enter" && form instanceof HTMLFormElement) {
				event.preventDefault();
				form.submit();
			}
			if (event.key === "Escape") closeSearch();
		},
		opts,
	);

	if (input.value.trim()) openSearch();
}

function bindTabs(root: HTMLElement, signal?: AbortSignal) {
	const tabs = root.querySelectorAll<HTMLElement>("[data-domains-tab]");
	const panels = root.querySelectorAll<HTMLElement>("[data-domains-panel]");
	const tabInput = document.getElementById(
		"nz-domains-tab-input",
	) as HTMLInputElement | null;
	const filterForm = document.getElementById("nz-domains-filter-form");

	const setActiveTab = (id: string, pushUrl = true) => {
		if (pushUrl) {
			const url = new URL(window.location.href);
			url.searchParams.set("tab", id);
			if (id === "certificates") {
				url.searchParams.delete("q");
				url.searchParams.delete("status");
			}
			window.history.replaceState({}, "", url.pathname + url.search);
		}
		if (tabInput) tabInput.value = id;

		for (const tab of tabs) {
			const isActive = tab.getAttribute("data-domains-tab") === id;
			tab.classList.toggle("nz-domains-tab--active", isActive);
			tab.setAttribute("aria-selected", isActive ? "true" : "false");
		}

		for (const panel of panels) {
			panel.classList.toggle(
				"hidden",
				panel.getAttribute("data-domains-panel") !== id,
			);
		}

		if (filterForm instanceof HTMLElement) {
			const searchWrap = filterForm.querySelector<HTMLElement>(
				"[data-domains-search-wrap]",
			);
			const status = filterForm.querySelector<HTMLElement>(
				'select[name="status"]',
			);
			const showFilters = id !== "certificates";
			searchWrap?.classList.toggle("hidden", !showFilters);
			status?.classList.toggle("hidden", !showFilters);
		}
	};

	for (const tab of tabs) {
		tab.addEventListener(
			"click",
			(event) => {
				const id = tab.getAttribute("data-domains-tab");
				if (!id) return;
				// Instant panel switch when panels are already in the DOM.
				// Soft-nav links still work if JS is late; preventDefault avoids a double load.
				if (panels.length > 0 && !tab.hasAttribute("data-nz-dashboard-nav")) {
					event.preventDefault();
					setActiveTab(id);
				} else if (panels.length > 0) {
					event.preventDefault();
					event.stopPropagation();
					setActiveTab(id);
				}
			},
			signal ? { signal, capture: true } : { capture: true },
		);
	}

	const current =
		new URL(window.location.href).searchParams.get("tab") ||
		tabInput?.value ||
		"hostnames";
	setActiveTab(current, false);
}

function bindDnsZones(root: HTMLElement) {
	const zones = readZonesJson();
	const createForm = document.getElementById(
		"nz-dns-create-form",
	) as HTMLFormElement | null;
	const recordsBody = document.getElementById("nz-dns-records-body");
	const recordsMeta = document.getElementById("nz-dns-records-meta");
	const recordForm = document.getElementById(
		"nz-dns-record-form",
	) as HTMLFormElement | null;
	const recordZoneInput = document.getElementById(
		"nz-dns-record-zone-id",
	) as HTMLInputElement | null;
	const recordTypeInput = document.getElementById(
		"nz-dns-record-type",
	) as HTMLSelectElement | null;
	const recordPriorityInput = document.getElementById(
		"nz-dns-record-priority",
	) as HTMLInputElement | null;

	createForm?.addEventListener("submit", async (event) => {
		event.preventDefault();
		const data = new FormData(createForm);
		const nameservers = parseNameservers(String(data.get("nameservers") || ""));
		await trpcMutate("dns.zones.create", {
			name: String(data.get("name") || ""),
			soaEmail: String(data.get("soaEmail") || ""),
			...(nameservers.length > 0 ? { nameservers } : {}),
		});
		window.location.reload();
	});

	recordTypeInput?.addEventListener("change", () => {
		recordPriorityInput?.classList.toggle(
			"hidden",
			recordTypeInput.value !== "MX",
		);
	});

	recordForm?.addEventListener("submit", async (event) => {
		event.preventDefault();
		const dnsZoneId = recordZoneInput?.value;
		if (!dnsZoneId) return;
		const data = new FormData(recordForm);
		const type = String(data.get("type") || "A");
		const ttlRaw = String(data.get("ttl") || "").trim();
		const priorityRaw = String(data.get("priority") || "").trim();
		await trpcMutate("dns.records.upsert", {
			dnsZoneId,
			name: String(data.get("name") || "@"),
			type,
			value: String(data.get("value") || ""),
			...(ttlRaw ? { ttl: Number.parseInt(ttlRaw, 10) } : {}),
			...(type === "MX" && priorityRaw
				? { priority: Number.parseInt(priorityRaw, 10) }
				: {}),
		});
		toast("DNS record saved", "success");
		window.location.reload();
	});

	recordsBody?.addEventListener("click", async (event) => {
		const target = event.target as Element | null;
		const button = target?.closest<HTMLButtonElement>("[data-delete-record]");
		const dnsRecordId = button?.getAttribute("data-delete-record");
		if (!dnsRecordId) return;
		await trpcMutate("dns.records.delete", { dnsRecordId });
		toast("DNS record deleted", "success");
		window.location.reload();
	});

	document
		.getElementById("nz-dns-zones-apply-all")
		?.addEventListener("click", async () => {
			await trpcMutate("dns.zones.publishAll", undefined);
			window.location.reload();
		});

	for (const button of root.querySelectorAll<HTMLButtonElement>(
		".nz-dns-publish",
	)) {
		button.addEventListener("click", async () => {
			const dnsZoneId = button.getAttribute("data-zone-id");
			if (!dnsZoneId) return;
			await trpcMutate("dns.zones.publish", { dnsZoneId });
			window.location.reload();
		});
	}

	for (const button of root.querySelectorAll<HTMLButtonElement>(
		"[data-zone-records]",
	)) {
		button.addEventListener("click", () => {
			const zoneId = button.getAttribute("data-zone-records");
			if (!zoneId || !recordsBody) return;
			const zone = zones.find((row) => row.dnsZoneId === zoneId);
			if (!zone) return;
			if (recordZoneInput) recordZoneInput.value = zone.dnsZoneId;
			const platformNs = readJson<string[]>(
				"nz-domains-platform-nameservers-json",
				[],
			);
			const ns = zone.nameservers?.length
				? zone.nameservers
				: platformNs.length > 0
					? platformNs
					: [`ns1.${zone.name}`, `ns2.${zone.name}`];
			if (recordsMeta) {
				recordsMeta.textContent = `${zone.name} · ${zone.records.length} record${
					zone.records.length === 1 ? "" : "s"
				} · Status ${zone.status} · NS ${ns.join(", ")}`;
			}
			recordsBody.innerHTML =
				zone.records.length === 0
					? `<tr><td class="p-3 text-xs text-muted-foreground" colspan="5">No records yet.</td></tr>`
					: zone.records
							.map(
								(record) => `<tr class="border-b">
									<td class="p-3 text-xs align-middle">${escapeHtml(record.name)}</td>
									<td class="p-3 text-xs align-middle font-mono">${escapeHtml(record.type)}</td>
									<td class="p-3 text-xs align-middle font-mono">${escapeHtml(record.value)}</td>
									<td class="p-3 text-xs align-middle text-muted-foreground">${escapeHtml(record.ttl ?? "")}</td>
									<td class="p-3 text-right text-xs align-middle">${
										record.managedBy === "user" || !record.managedBy
											? `<button type="button" class="nz-modal__btn nz-modal__btn--ghost px-2 py-1 text-[11px]" data-delete-record="${escapeHtml(record.dnsRecordId)}">Delete</button>`
											: `<span class="text-[11px] text-muted-foreground">${escapeHtml(record.managedBy)}</span>`
									}</td>
								</tr>`,
							)
							.join("");
			openDialog("nz-dns-records-dialog");
		});
	}
}

function readZonesJson(): ZoneRow[] {
	return readJson<ZoneRow[]>("nz-dns-zones-json", []);
}

function fillProjectSelect(
	select: HTMLSelectElement,
	projects: ProjectOption[],
	placeholder = "Select project",
) {
	select.innerHTML = `<option value="">${placeholder}</option>`;
	for (const project of projects) {
		const opt = document.createElement("option");
		opt.value = project.projectId;
		opt.textContent = project.name;
		select.appendChild(opt);
	}
}

function fillEnvironmentSelect(
	select: HTMLSelectElement,
	project: ProjectOption | undefined,
) {
	select.innerHTML = `<option value="">Select environment</option>`;
	if (!project) return;
	for (const env of project.environments) {
		const opt = document.createElement("option");
		opt.value = env.environmentId;
		opt.textContent = env.name;
		select.appendChild(opt);
	}
}

async function loadComposeServiceNames(composeId: string) {
	try {
		return await trpcQuery<string[]>("compose.loadServices", {
			composeId,
			type: "cache",
		});
	} catch {
		return [];
	}
}

async function fillServiceSelect(
	select: HTMLSelectElement,
	env: ProjectOption["environments"][number] | undefined,
) {
	const token = `${Date.now()}-${Math.random()}`;
	select.dataset.loadToken = token;
	select.innerHTML = `<option value="">Select service</option>`;
	if (!env) return;
	for (const app of env.applications) {
		const opt = document.createElement("option");
		opt.value = serviceSelectValue("application", app.applicationId);
		opt.textContent = `${app.name ?? app.appName ?? "Application"} (application)`;
		select.appendChild(opt);
	}
	if (env.compose.length === 0) return;
	const composeOptions = await Promise.all(
		env.compose.map(async (comp) => ({
			comp,
			services: await loadComposeServiceNames(comp.composeId),
		})),
	);
	if (select.dataset.loadToken !== token) return;
	for (const { comp, services } of composeOptions) {
		const serviceNames = services.length > 0 ? services : [comp.name];
		for (const serviceName of serviceNames) {
			const opt = document.createElement("option");
			opt.value = serviceSelectValue("compose", comp.composeId, serviceName);
			opt.textContent =
				services.length > 1
					? `${comp.name} / ${serviceName} (compose)`
					: `${comp.name} (compose: ${serviceName})`;
			select.appendChild(opt);
		}
	}
}

function bindHostnameModal(projects: ProjectOption[]) {
	const form = document.getElementById(
		"nz-add-hostname-form",
	) as HTMLFormElement | null;
	const subdomainMode = document.getElementById(
		"nz-add-hostname-subdomain-mode",
	) as HTMLInputElement | null;
	const fullRow = document.getElementById("nz-add-hostname-full-row");
	const subdomainRow = document.getElementById("nz-add-hostname-subdomain-row");
	const hostInput = document.getElementById(
		"nz-add-hostname-host",
	) as HTMLInputElement | null;
	const parentSelect = document.getElementById(
		"nz-add-hostname-parent",
	) as HTMLSelectElement | null;
	const prefixInput = document.getElementById(
		"nz-add-hostname-prefix",
	) as HTMLInputElement | null;
	const subdomainPreview = document.getElementById(
		"nz-add-hostname-subdomain-preview",
	);
	const connectToggle = document.getElementById(
		"nz-add-hostname-connect",
	) as HTMLInputElement | null;
	const connectFields = document.getElementById(
		"nz-add-hostname-connect-fields",
	);
	const projectSelect = document.getElementById(
		"nz-add-hostname-project",
	) as HTMLSelectElement | null;
	const envSelect = document.getElementById(
		"nz-add-hostname-env",
	) as HTMLSelectElement | null;
	const serviceSelect = document.getElementById(
		"nz-add-hostname-service",
	) as HTMLSelectElement | null;
	const dnsModeRadios = form?.querySelectorAll<HTMLInputElement>(
		'input[name="dnsMode"]',
	);
	const zoneRow = document.getElementById("nz-add-hostname-zone-row");
	const zoneSelect = document.getElementById(
		"nz-add-hostname-zone",
	) as HTMLSelectElement | null;
	const serverRow = document.getElementById("nz-add-hostname-server-row");
	const serverSelect = document.getElementById(
		"nz-add-hostname-server",
	) as HTMLSelectElement | null;
	const routePathInput = document.getElementById(
		"nz-add-hostname-path",
	) as HTMLInputElement | null;

	if (projectSelect) fillProjectSelect(projectSelect, projects);

	const refreshSubdomainPreview = () => {
		if (!subdomainPreview || !subdomainMode?.checked) return;
		const prefix = prefixInput?.value.trim();
		const parent = parentSelect?.value;
		subdomainPreview.textContent =
			prefix && parent
				? `Will create: ${prefix}.${parent}`
				: "Enter subdomain and select parent domain";
	};

	const setSubdomainMode = (enabled: boolean) => {
		fullRow?.classList.toggle("hidden", enabled);
		subdomainRow?.classList.toggle("hidden", !enabled);
		if (hostInput) hostInput.required = !enabled;
		if (prefixInput) prefixInput.required = enabled;
		if (parentSelect) parentSelect.required = enabled;
		refreshSubdomainPreview();
	};

	subdomainMode?.addEventListener("change", () => {
		setSubdomainMode(subdomainMode.checked);
	});

	parentSelect?.addEventListener("change", refreshSubdomainPreview);
	prefixInput?.addEventListener("input", refreshSubdomainPreview);

	const refreshTargetFields = () => {
		const mode = form?.querySelector<HTMLInputElement>(
			'input[name="dnsMode"]:checked',
		)?.value;
		const connectsToService = Boolean(connectToggle?.checked);
		zoneRow?.classList.toggle("hidden", mode !== "nearzero_managed");
		serverRow?.classList.toggle(
			"hidden",
			mode !== "external" || connectsToService,
		);
	};

	connectToggle?.addEventListener("change", () => {
		connectFields?.classList.toggle("hidden", !connectToggle.checked);
		refreshTargetFields();
	});

	projectSelect?.addEventListener("change", () => {
		const project = projects.find((p) => p.projectId === projectSelect.value);
		if (envSelect) fillEnvironmentSelect(envSelect, project);
		if (serviceSelect) void fillServiceSelect(serviceSelect, undefined);
	});

	envSelect?.addEventListener("change", () => {
		const project = projects.find((p) => p.projectId === projectSelect?.value);
		const env = project?.environments.find(
			(e) => e.environmentId === envSelect.value,
		);
		if (serviceSelect) void fillServiceSelect(serviceSelect, env);
	});

	for (const radio of dnsModeRadios ?? []) {
		radio.addEventListener("change", refreshTargetFields);
	}
	refreshTargetFields();

	const resolveHost = (): string => {
		if (subdomainMode?.checked) {
			const prefix = prefixInput?.value.trim();
			const parent = parentSelect?.value;
			if (!prefix || !parent) {
				throw new Error("Enter a subdomain and select a parent domain");
			}
			return `${prefix}.${parent}`;
		}
		const host = hostInput?.value.trim() ?? "";
		if (!host) throw new Error("Enter a domain or hostname");
		return host;
	};

	form?.addEventListener("submit", async (e) => {
		e.preventDefault();
		let host: string;
		try {
			host = resolveHost();
		} catch (err) {
			toast(err instanceof Error ? err.message : "Invalid hostname", "error");
			return;
		}

		const dnsMode =
			form.querySelector<HTMLInputElement>('input[name="dnsMode"]:checked')
				?.value ?? "external";
		const dnsZoneId = zoneSelect?.value || undefined;
		if (dnsMode === "nearzero_managed" && !dnsZoneId) {
			toast("Select an org DNS zone for Nearzero DNS", "error");
			return;
		}
		const connect = connectToggle?.checked;
		const path = normalizeRoutePath(routePathInput?.value);

		try {
			if (connect && serviceSelect?.value) {
				const { type, id, serviceName } = parseServiceSelectValue(
					serviceSelect.value,
				);
				const port = Number.parseInt(
					(document.getElementById("nz-add-hostname-port") as HTMLInputElement)
						?.value || "3000",
					10,
				);
				if (type === "application") {
					await trpcMutate("domain.create", {
						host,
						https: true,
						certificateType: "letsencrypt",
						port,
						applicationId: id,
						domainType: "application",
						path,
						managedByNearzero: dnsMode === "nearzero_managed",
						dnsZoneId: dnsMode === "nearzero_managed" ? dnsZoneId : undefined,
					});
				} else {
					await trpcMutate("domain.create", {
						host,
						https: true,
						certificateType: "letsencrypt",
						port,
						composeId: id,
						domainType: "compose",
						serviceName,
						path,
						managedByNearzero: dnsMode === "nearzero_managed",
						dnsZoneId: dnsMode === "nearzero_managed" ? dnsZoneId : undefined,
					});
				}
			} else {
				await trpcMutate("domain.register", {
					host,
					dnsMode: dnsMode as "external" | "nearzero_managed",
					https: true,
					certificateType: "letsencrypt",
					dnsZoneId: dnsMode === "nearzero_managed" ? dnsZoneId : undefined,
					serverId:
						dnsMode === "external"
							? serverSelect?.value === "nearzero"
								? null
								: serverSelect?.value || undefined
							: undefined,
				});
			}
			toast("Domain added", "success");
			window.location.reload();
		} catch (err) {
			toast(
				err instanceof Error ? err.message : "Failed to add domain",
				"error",
			);
		}
	});
}

function bindConnectServiceModal(projects: ProjectOption[]) {
	const form = document.getElementById(
		"nz-connect-service-form",
	) as HTMLFormElement | null;
	const domainIdInput = document.getElementById(
		"nz-connect-service-domain-id",
	) as HTMLInputElement | null;
	const projectSelect = document.getElementById(
		"nz-connect-service-project",
	) as HTMLSelectElement | null;
	const envSelect = document.getElementById(
		"nz-connect-service-env",
	) as HTMLSelectElement | null;
	const serviceSelect = document.getElementById(
		"nz-connect-service-service",
	) as HTMLSelectElement | null;
	const routePathInput = document.getElementById(
		"nz-connect-service-path",
	) as HTMLInputElement | null;

	if (projectSelect) fillProjectSelect(projectSelect, projects);

	projectSelect?.addEventListener("change", () => {
		const project = projects.find((p) => p.projectId === projectSelect.value);
		if (envSelect) fillEnvironmentSelect(envSelect, project);
		if (serviceSelect) void fillServiceSelect(serviceSelect, undefined);
	});

	envSelect?.addEventListener("change", () => {
		const project = projects.find((p) => p.projectId === projectSelect?.value);
		const env = project?.environments.find(
			(e) => e.environmentId === envSelect.value,
		);
		if (serviceSelect) void fillServiceSelect(serviceSelect, env);
	});

	for (const btn of document.querySelectorAll<HTMLButtonElement>(
		"[data-connect-domain]",
	)) {
		btn.addEventListener("click", () => {
			const domainId = btn.getAttribute("data-connect-domain");
			if (domainIdInput && domainId) domainIdInput.value = domainId;
			openDialog("nz-connect-service-dialog");
		});
	}

	form?.addEventListener("submit", async (e) => {
		e.preventDefault();
		const domainId = domainIdInput?.value;
		if (!domainId || !serviceSelect?.value) return;
		const { type, id, serviceName } = parseServiceSelectValue(
			serviceSelect.value,
		);
		const port = Number.parseInt(
			(document.getElementById("nz-connect-service-port") as HTMLInputElement)
				?.value || "3000",
			10,
		);
		const path = normalizeRoutePath(routePathInput?.value);

		try {
			if (type === "application") {
				await trpcMutate("domain.assignToService", {
					domainId,
					applicationId: id,
					port,
					path,
				});
			} else {
				await trpcMutate("domain.assignToService", {
					domainId,
					composeId: id,
					serviceName,
					port,
					path,
				});
			}
			toast("Service connected", "success");
			window.location.reload();
		} catch (err) {
			toast(
				err instanceof Error ? err.message : "Failed to connect service",
				"error",
			);
		}
	});
}

function bindEnvironmentBindModal(
	projects: ProjectOption[],
	zones: Array<{ dnsZoneId: string; name: string }>,
) {
	const form = document.getElementById(
		"nz-bind-env-form",
	) as HTMLFormElement | null;
	const projectSelect = document.getElementById(
		"nz-bind-env-project",
	) as HTMLSelectElement | null;
	const envSelect = document.getElementById(
		"nz-bind-env-environment",
	) as HTMLSelectElement | null;
	const zoneSelect = document.getElementById(
		"nz-bind-env-zone",
	) as HTMLSelectElement | null;

	if (projectSelect) fillProjectSelect(projectSelect, projects);
	if (zoneSelect) {
		zoneSelect.innerHTML = `<option value="">None (external DNS)</option>`;
		for (const zone of zones) {
			const opt = document.createElement("option");
			opt.value = zone.dnsZoneId;
			opt.textContent = zone.name;
			zoneSelect.appendChild(opt);
		}
	}

	projectSelect?.addEventListener("change", () => {
		const project = projects.find((p) => p.projectId === projectSelect.value);
		if (envSelect) fillEnvironmentSelect(envSelect, project);
	});

	for (const btn of document.querySelectorAll<HTMLButtonElement>(
		"[data-edit-binding]",
	)) {
		btn.addEventListener("click", () => {
			const envId = btn.getAttribute("data-edit-binding");
			const projectId = btn.getAttribute("data-binding-project");
			const zoneId = btn.getAttribute("data-binding-zone") ?? "";
			const prefix = btn.getAttribute("data-binding-prefix") ?? "";
			if (projectSelect && projectId) projectSelect.value = projectId;
			const project = projects.find((p) => p.projectId === (projectId ?? ""));
			if (envSelect) {
				fillEnvironmentSelect(envSelect, project);
				if (envId) envSelect.value = envId;
			}
			if (zoneSelect) zoneSelect.value = zoneId;
			const prefixInput = document.getElementById(
				"nz-bind-env-prefix",
			) as HTMLInputElement | null;
			if (prefixInput) prefixInput.value = prefix;
			openDialog("nz-bind-env-dialog");
		});
	}

	form?.addEventListener("submit", async (e) => {
		e.preventDefault();
		const environmentId = envSelect?.value;
		if (!environmentId) return;
		const dnsZoneId = zoneSelect?.value || null;
		const domainPrefix =
			(
				document.getElementById("nz-bind-env-prefix") as HTMLInputElement
			)?.value.trim() || null;
		try {
			const result = await trpcMutate<{
				domainReconciliation?: {
					attempted: number;
					updated: number;
					failed: number;
				};
			}>("environment.update", {
				environmentId,
				dnsZoneId: dnsZoneId || null,
				domainPrefix,
			});
			const reconciliation = result?.domainReconciliation;
			if (reconciliation?.failed) {
				toast(
					`Binding saved; ${reconciliation.failed} system-assigned route${reconciliation.failed === 1 ? "" : "s"} still need a deploy retry`,
					"error",
				);
			} else if (reconciliation?.updated) {
				toast(
					`Binding saved and ${reconciliation.updated} system-assigned route${reconciliation.updated === 1 ? "" : "s"} updated`,
					"success",
				);
			} else {
				toast("Environment binding saved", "success");
			}
			window.location.reload();
		} catch (err) {
			toast(
				err instanceof Error ? err.message : "Failed to save binding",
				"error",
			);
		}
	});
}

function bindUnassignActions() {
	for (const btn of document.querySelectorAll<HTMLButtonElement>(
		"[data-unassign-domain]",
	)) {
		btn.addEventListener("click", async () => {
			const domainId = btn.getAttribute("data-unassign-domain");
			if (!domainId) return;
			try {
				await trpcMutate("domain.unassign", { domainId });
				toast("Service disconnected", "success");
				window.location.reload();
			} catch (err) {
				toast(
					err instanceof Error ? err.message : "Failed to disconnect",
					"error",
				);
			}
		});
	}
}

function bindValidateDns() {
	for (const btn of document.querySelectorAll<HTMLButtonElement>(
		"[data-validate-domain]",
	)) {
		btn.addEventListener("click", async () => {
			const host = btn.getAttribute("data-validate-domain");
			if (!host) return;
			try {
				const result = await validateDomainWithEdgeIp({ domain: host });
				toast(
					result.isValid
						? `DNS OK: ${result.resolvedIp}`
						: (result.error ?? "DNS mismatch"),
					result.isValid ? "success" : "error",
				);
			} catch (err) {
				toast(
					err instanceof Error ? err.message : "Validation failed",
					"error",
				);
			}
		});
	}
}

export function initDomainsHub() {
	const root = document.getElementById("nz-domains-root");
	if (!root) return;

	type RootEx = HTMLElement & { __nzDomainsTeardown?: () => void };
	const r = root as RootEx;
	r.__nzDomainsTeardown?.();
	const ac = new AbortController();
	r.__nzDomainsTeardown = () => ac.abort();

	const projects = readJson<ProjectOption[]>("nz-domains-projects-json", []);
	const zones = readJson<Array<{ dnsZoneId: string; name: string }>>(
		"nz-domains-zones-options-json",
		[],
	);

	bindAddNewMenu(root, ac.signal);
	bindTabs(root, ac.signal);
	bindDomainsSearch(ac.signal);
	bindDnsZones(root);
	bindHostnameModal(projects);
	bindConnectServiceModal(projects);
	bindEnvironmentBindModal(projects, zones);
	bindUnassignActions();
	bindValidateDns();
	initCertificatesPanel();
}

export function bootDomainsHub() {
	initDomainsHub();
}

/** Shared opener for environment launcher */
export function openConnectServiceDialog(domainId?: string) {
	if (domainId) {
		const input = document.getElementById(
			"nz-connect-service-domain-id",
		) as HTMLInputElement | null;
		if (input) input.value = domainId;
	}
	openDialog("nz-connect-service-dialog");
}

export function openAddHostnameDialog() {
	openDialog("nz-add-hostname-dialog");
}
