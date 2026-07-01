import { trpcMutate } from "@/lib/client-api";
import { bindElementEventOnce, openDialog } from "@/scripts/ui";

type ZoneRow = {
	dnsZoneId: string;
	name: string;
	status: string;
	records: Array<{
		dnsRecordId: string;
		name: string;
		type: string;
		value: string;
	}>;
};

function readZonesJson(): ZoneRow[] {
	const el = document.getElementById("nz-dns-zones-json");
	if (!el?.textContent) return [];
	try {
		return JSON.parse(el.textContent) as ZoneRow[];
	} catch {
		return [];
	}
}

export function initDnsSettingsDashboard() {
	const root = document.getElementById("nz-domains-root");
	if (!root) return;

	const zones = readZonesJson();
	const createForm = document.getElementById(
		"nz-dns-create-form",
	) as HTMLFormElement | null;
	const recordsBody = document.getElementById("nz-dns-records-body");
	const recordsMeta = document.getElementById("nz-dns-records-meta");

	bindElementEventOnce(
		document.getElementById("nz-dns-create-open"),
		"dnsCreateOpenBound",
		"click",
		() => {
			openDialog("nz-dns-create-dialog");
		},
	);

	bindElementEventOnce(
		createForm,
		"dnsCreateSubmitBound",
		"submit",
		async (event) => {
			event.preventDefault();
			if (!(event.currentTarget instanceof HTMLFormElement)) return;
			const data = new FormData(event.currentTarget);
			await trpcMutate("dns.zones.create", {
				name: String(data.get("name") || ""),
				soaEmail: String(data.get("soaEmail") || ""),
			});
			window.location.reload();
		},
	);

	bindElementEventOnce(
		document.getElementById("nz-dns-publish-all"),
		"dnsPublishAllBound",
		"click",
		async () => {
			await trpcMutate("dns.zones.publishAll", undefined);
			window.location.reload();
		},
	);

	for (const button of document.querySelectorAll<HTMLButtonElement>(
		".nz-dns-publish",
	)) {
		bindElementEventOnce(button, "dnsPublishBound", "click", async () => {
			const dnsZoneId = button.getAttribute("data-zone-id");
			if (!dnsZoneId) return;
			await trpcMutate("dns.zones.publish", { dnsZoneId });
			window.location.reload();
		});
	}

	for (const button of document.querySelectorAll<HTMLButtonElement>(
		"[data-zone-records]",
	)) {
		bindElementEventOnce(button, "dnsRecordsOpenBound", "click", () => {
			const zoneId = button.getAttribute("data-zone-records");
			if (!zoneId || !recordsBody) return;
			const zone = zones.find((row) => row.dnsZoneId === zoneId);
			if (!zone) return;

			if (recordsMeta) {
				recordsMeta.textContent = `${zone.name} · ${zone.records.length} record${
					zone.records.length === 1 ? "" : "s"
				} · Status ${zone.status}`;
			}

			recordsBody.innerHTML =
				zone.records.length === 0
					? `<tr><td class="p-3 text-xs text-muted-foreground" colspan="3">No records yet.</td></tr>`
					: zone.records
							.map(
								(record) => `<tr class="border-b">
									<td class="p-3 text-xs align-middle">${record.name}</td>
									<td class="p-3 text-xs align-middle font-mono">${record.type}</td>
									<td class="p-3 text-xs align-middle font-mono">${record.value}</td>
								</tr>`,
							)
							.join("");

			openDialog("nz-dns-records-dialog");
		});
	}

	const filterForm = document.getElementById("nz-domains-filter-form");
	const search = document.getElementById("nz-domains-search");
	bindElementEventOnce(search, "dnsSearchSubmitBound", "keydown", (event) => {
		if (!(event instanceof KeyboardEvent)) return;
		if (event.key === "Enter" && filterForm instanceof HTMLFormElement) {
			event.preventDefault();
			filterForm.submit();
		}
	});
}
