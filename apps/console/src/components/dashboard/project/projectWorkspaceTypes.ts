export type ProjectWorkspaceServiceKind =
	| "application"
	| "compose"
	| "postgres"
	| "mysql"
	| "mongo"
	| "redis"
	| "mariadb"
	| "libsql";

export type ProjectWorkspaceService = {
	name: string;
	appName?: string | null;
	framework?: string | null;
	type: string;
	status: string;
	href: string;
	serviceKind: ProjectWorkspaceServiceKind;
	serviceId: string;
	serverId?: string | null;
	supportsDomain?: boolean;
	domains?: Array<{
		domainId: string;
		host: string;
		https: boolean;
		managedByNearzero?: boolean;
		dnsZoneId?: string | null;
		dnsRecordId?: string | null;
	}>;
};
