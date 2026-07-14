import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Compose, Domain } from "@nearzero/server";
import {
	addDomainToCompose,
	getComposePath,
	writeDomainsToCompose,
} from "@nearzero/server";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";

const appName = "label-reconciliation-test";
const compose = {
	appName,
	serverId: null,
	sourceType: "raw",
	composeType: "docker-compose",
	isolatedDeployment: false,
	isolatedDeploymentsVolume: false,
	randomize: false,
	suffix: "",
} as unknown as Compose;

const baseDomain: Domain = {
	host: "example.com",
	port: 3000,
	customEntrypoint: null,
	https: false,
	uniqueConfigKey: 1,
	customCertResolver: null,
	certificateType: "none",
	applicationId: "",
	composeId: "compose-id",
	domainType: "compose",
	serviceName: "new-service",
	domainId: "domain-id",
	path: "/",
	createdAt: "",
	previewDeploymentId: "",
	internalPath: "/",
	stripPath: false,
	middlewares: null,
};

const writeFixture = (specification: unknown) => {
	const path = getComposePath(compose);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, stringify(specification), "utf8");
};

afterEach(() => {
	rmSync(dirname(dirname(getComposePath(compose))), {
		recursive: true,
		force: true,
	});
});

describe("Compose domain label reconciliation", () => {
	it("removes generated labels from the old service when a domain moves", async () => {
		writeFixture({
			services: {
				"old-service": {
					image: "nginx",
					labels: [
						`traefik.http.routers.${appName}-1-web.rule=Host(\`old.example.com\`)`,
						`traefik.http.services.${appName}-1-web.loadbalancer.server.port=3000`,
						`traefik.http.middlewares.stripprefix-${appName}-1.stripprefix.prefixes=/old`,
						"com.example.keep=true",
					],
				},
				"new-service": {
					image: "nginx",
					labels: ["com.example.second=kept"],
				},
			},
		});

		const result = await addDomainToCompose(compose, [baseDomain]);
		const oldLabels = result?.services["old-service"].labels as string[];
		const newLabels = result?.services["new-service"].labels as string[];

		expect(oldLabels).toEqual(["com.example.keep=true"]);
		expect(newLabels).toContain("com.example.second=kept");
		expect(newLabels).toContain(
			`traefik.http.routers.${appName}-1-web.rule=Host(\`example.com\`)`,
		);
	});

	it("removes stale array and map labels when every domain is deleted", async () => {
		writeFixture({
			services: {
				web: {
					image: "nginx",
					labels: {
						[`traefik.http.routers.${appName}-1-web.rule`]:
							"Host(`example.com`)",
						"nearzero.managed-domain-routing": "true",
						"traefik.enable": "true",
						"traefik.docker.network": "nearzero-network",
						"com.example.keep": "true",
					},
					deploy: {
						labels: [
							`traefik.http.services.${appName}-1-web.loadbalancer.server.port=3000`,
							"traefik.enable=true",
							"traefik.swarm.network=nearzero-network",
							"com.example.deploy-keep=true",
						],
					},
				},
			},
		});

		const result = await addDomainToCompose(compose, []);
		const service = result?.services.web;

		expect(service?.labels).toEqual({ "com.example.keep": "true" });
		expect(service?.deploy?.labels).toEqual(["com.example.deploy-keep=true"]);
	});

	it("drops obsolete websecure labels when HTTPS is disabled", async () => {
		writeFixture({
			services: {
				"new-service": {
					image: "nginx",
					labels: [
						`traefik.http.routers.${appName}-1-websecure.rule=Host(\`example.com\`)`,
						`traefik.http.routers.${appName}-1-websecure.tls.certresolver=letsencrypt`,
					],
				},
			},
		});

		const result = await addDomainToCompose(compose, [baseDomain]);
		const labels = result?.services["new-service"].labels as string[];

		expect(labels.some((label) => label.includes("websecure"))).toBe(false);
		expect(labels).toContain(
			`traefik.http.routers.${appName}-1-web.rule=Host(\`example.com\`)`,
		);
	});

	it("does not interpolate untrusted validation errors into deployment shell", async () => {
		writeFixture({
			services: {
				"new-service": { image: "nginx" },
			},
		});
		const untrustedHost = 'bad.example"; touch /tmp/should-not-run; #';

		const command = await writeDomainsToCompose(compose, [
			{ ...baseDomain, host: untrustedHost },
		]);

		expect(command).toContain(
			"Error: Could not update Compose domain routing labels",
		);
		expect(command).not.toContain(untrustedHost);
		expect(command).not.toContain("touch /tmp/should-not-run");
	});

	it("writes deployment label updates atomically with private permissions", async () => {
		writeFixture({
			services: {
				"new-service": { image: "nginx" },
			},
		});

		const command = await writeDomainsToCompose(compose, [baseDomain]);

		expect(command).toContain("mktemp");
		expect(command).toContain('chmod 600 "$nearzero_compose_candidate"');
		expect(command).toContain('mv -f -- "$nearzero_compose_candidate"');
		expect(command).not.toContain(`> "${getComposePath(compose)}"`);
	});
});
