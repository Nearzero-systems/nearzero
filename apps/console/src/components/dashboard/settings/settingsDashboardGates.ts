import type { NavContext } from "@/components/dashboard/navMenu";
import {
	EDITION_FEATURES,
	isEditionFeatureEnabled,
} from "@/lib/edition-policy";

function admin(ctx: NavContext) {
	return !!ctx.permissions?.organization?.update;
}

export const settingsDashboardGates = {
	always(_ctx: NavContext) {
		return true;
	},
	profile(ctx: NavContext) {
		return settingsDashboardGates.always(ctx);
	},
	users(ctx: NavContext) {
		return !!ctx.permissions?.member?.read;
	},
	sso(ctx: NavContext) {
		return admin(ctx) && isEditionFeatureEnabled(EDITION_FEATURES.sso);
	},
	auditLogs(ctx: NavContext) {
		return (
			!!ctx.permissions?.auditLog?.read &&
			isEditionFeatureEnabled(EDITION_FEATURES.auditLogs)
		);
	},
	sshKeys(ctx: NavContext) {
		return !!ctx.permissions?.sshKeys?.read;
	},
	certificates(ctx: NavContext) {
		return !!ctx.permissions?.certificate?.read;
	},
	gitProviders(ctx: NavContext) {
		return !!ctx.permissions?.gitProviders?.read;
	},
	registry(ctx: NavContext) {
		return !!ctx.permissions?.registry?.read;
	},
	notifications(ctx: NavContext) {
		return !!ctx.permissions?.notification?.read;
	},
	tags(ctx: NavContext) {
		return !!ctx.permissions?.tag?.read;
	},
	agent(ctx: NavContext) {
		return admin(ctx);
	},
	domainsHub(ctx: NavContext) {
		return (
			!!ctx.permissions?.domain?.read || !!ctx.permissions?.certificate?.read
		);
	},
	dns(ctx: NavContext) {
		return !!ctx.permissions?.domain?.read;
	},
	monitoring(ctx: NavContext) {
		return !!ctx.permissions?.monitoring?.read;
	},
	schedules(ctx: NavContext) {
		return admin(ctx);
	},
	traefik(ctx: NavContext) {
		return !!ctx.permissions?.traefikFiles?.read;
	},
	requests(ctx: NavContext) {
		return !!ctx.permissions?.docker?.read;
	},
	cluster(ctx: NavContext) {
		return admin(ctx);
	},
	servers(ctx: NavContext) {
		return !!ctx.permissions?.server?.read;
	},
	webServer(ctx: NavContext) {
		return admin(ctx);
	},
};
