export type EnvironmentDnsContext = {
	dnsZoneId: string | null;
	domainPrefix: string;
	zoneName: string | null;
};

type DnsZonesApi = {
	dns: {
		zones: {
			one: {
				query: (input: { dnsZoneId: string }) => Promise<{ name: string }>;
			};
		};
	};
};

export async function loadEnvironmentDnsContext(
	api: DnsZonesApi,
	environment:
		| {
				dnsZoneId?: string | null;
				domainPrefix?: string | null;
		  }
		| null
		| undefined,
): Promise<EnvironmentDnsContext> {
	const dnsZoneId = environment?.dnsZoneId ?? null;
	const domainPrefix = environment?.domainPrefix ?? "";
	let zoneName: string | null = null;
	if (dnsZoneId) {
		try {
			const zone = await api.dns.zones.one.query({ dnsZoneId });
			zoneName = zone.name ?? null;
		} catch {
			zoneName = null;
		}
	}
	return { dnsZoneId, domainPrefix, zoneName };
}
