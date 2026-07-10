import { fs, vol } from "memfs";

vi.mock("node:fs", () => ({
	...fs,
	default: fs,
}));

import type { FileConfig } from "@nearzero/server";
import {
	createDefaultServerTraefikConfig,
	loadOrCreateConfig,
	updateServerTraefik,
} from "@nearzero/server";
import {
	apiAssignDomain,
	type webServerSettings,
} from "@nearzero/server/db/schema";
import { beforeEach, expect, test, vi } from "vitest";

type WebServerSettings = typeof webServerSettings.$inferSelect;

const baseSettings: WebServerSettings = {
	id: "",
	https: false,
	certificateType: "none",
	host: null,
	serverIp: null,
	letsEncryptEmail: null,
	sshPrivateKey: null,
	enableDockerCleanup: false,
	logCleanupCron: null,
	metricsConfig: {
		containers: {
			refreshRate: 20,
			services: {
				include: [],
				exclude: [],
			},
		},
		server: {
			type: "Nearzero",
			cronJob: "",
			port: 4500,
			refreshRate: 20,
			retentionDays: 2,
			token: "",
			thresholds: {
				cpu: 0,
				memory: 0,
			},
			urlCallback: "",
		},
	},
	whitelabelingConfig: {
		appName: null,
		appDescription: null,
		logoUrl: null,
		faviconUrl: null,
		customCss: null,
		loginLogoUrl: null,
		supportUrl: null,
		docsUrl: null,
		errorPageTitle: null,
		errorPageDescription: null,
		metaTitle: null,
		footerText: null,
	},
	cleanupCacheApplications: false,
	cleanupCacheOnCompose: false,
	cleanupCacheOnPreviews: false,
	createdAt: null,
	updatedAt: new Date(),
};

beforeEach(() => {
	vol.reset();
	createDefaultServerTraefikConfig();
});

test("Should read the configuration file", () => {
	const config: FileConfig = loadOrCreateConfig("nearzero");
	expect(config.http?.routers?.["nearzero-router-app"]?.service).toBe(
		"nearzero-service-app",
	);
});

test("Should apply redirect-to-https", () => {
	updateServerTraefik(
		{
			...baseSettings,
			https: true,
			certificateType: "letsencrypt",
		},
		"example.com",
	);

	const config: FileConfig = loadOrCreateConfig("nearzero");

	expect(config.http?.routers?.["nearzero-router-app"]?.middlewares).toContain(
		"redirect-to-https",
	);
	expect(
		config.http?.services?.["nearzero-service-app"]?.loadBalancer?.servers?.[0]
			?.url,
	).toBe("http://nearzero:4321");
});

test("Should accept a public hostname and reject URLs or IP addresses", () => {
	expect(
		apiAssignDomain.parse({
			host: "Nearzero.Example.com",
			certificateType: "letsencrypt",
			letsEncryptEmail: "admin@example.com",
			https: true,
		}).host,
	).toBe("nearzero.example.com");
	expect(() =>
		apiAssignDomain.parse({
			host: "https://nearzero.example.com",
			certificateType: "letsencrypt",
		}),
	).toThrow();
	expect(() =>
		apiAssignDomain.parse({
			host: "13.61.19.252",
			certificateType: "letsencrypt",
		}),
	).toThrow();
});

test("Should change only host when no certificate", () => {
	updateServerTraefik(baseSettings, "example.com");

	const config: FileConfig = loadOrCreateConfig("nearzero");

	expect(config.http?.routers?.["nearzero-router-app-secure"]).toBeUndefined();
});

test("Should not touch config without host", () => {
	const originalConfig: FileConfig = loadOrCreateConfig("nearzero");

	updateServerTraefik(baseSettings, null);

	const config: FileConfig = loadOrCreateConfig("nearzero");

	expect(originalConfig).toEqual(config);
});

test("Should remove websecure if https rollback to http", () => {
	updateServerTraefik(
		{ ...baseSettings, certificateType: "letsencrypt" },
		"example.com",
	);

	updateServerTraefik(
		{ ...baseSettings, certificateType: "none" },
		"example.com",
	);

	const config: FileConfig = loadOrCreateConfig("nearzero");

	expect(config.http?.routers?.["nearzero-router-app-secure"]).toBeUndefined();
	expect(
		config.http?.routers?.["nearzero-router-app"]?.middlewares,
	).not.toContain("redirect-to-https");
});
