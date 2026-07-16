import { readFileSync } from "node:fs";
import { isExternallyManagedWebMonitoring } from "@nearzero/server";
import {
	getMonitoringImageCandidates,
	monitoringDockerAccessConfig,
	monitoringLoopbackPortConfig,
} from "@nearzero/server/setup/monitoring-setup";
import { afterEach, expect, test } from "vitest";
import { parse } from "yaml";

const originalMetricsUrl = process.env.NEARZERO_METRICS_URL;
const originalDockerMetadataOptIn =
	process.env.NEARZERO_ALLOW_MONITORING_DOCKER_METADATA;
const originalMonitoringImage = process.env.NEARZERO_MONITORING_IMAGE;
const originalMonitoringImageTag = process.env.NEARZERO_MONITORING_IMAGE_TAG;
const originalReleaseTag = process.env.RELEASE_TAG;
const originalNodeEnv = process.env.NODE_ENV;

const restoreEnv = (key: string, value: string | undefined) => {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
};

afterEach(() => {
	if (originalMetricsUrl === undefined) {
		delete process.env.NEARZERO_METRICS_URL;
	} else {
		process.env.NEARZERO_METRICS_URL = originalMetricsUrl;
	}
	if (originalDockerMetadataOptIn === undefined) {
		delete process.env.NEARZERO_ALLOW_MONITORING_DOCKER_METADATA;
	} else {
		process.env.NEARZERO_ALLOW_MONITORING_DOCKER_METADATA =
			originalDockerMetadataOptIn;
	}
	restoreEnv("NEARZERO_MONITORING_IMAGE", originalMonitoringImage);
	restoreEnv("NEARZERO_MONITORING_IMAGE_TAG", originalMonitoringImageTag);
	restoreEnv("RELEASE_TAG", originalReleaseTag);
	restoreEnv("NODE_ENV", originalNodeEnv);
});

test("uses an explicit monitoring image without rewriting it", () => {
	process.env.NEARZERO_MONITORING_IMAGE =
		"registry.example/monitoring@sha256:0123456789abcdef";
	process.env.NEARZERO_MONITORING_IMAGE_TAG = "nightly";
	process.env.RELEASE_TAG = "0.1.33";

	expect(getMonitoringImageCandidates()).toEqual([
		"registry.example/monitoring@sha256:0123456789abcdef",
	]);
});

test("propagates versioned and channel release tags to monitoring", () => {
	delete process.env.NEARZERO_MONITORING_IMAGE;
	delete process.env.NEARZERO_MONITORING_IMAGE_TAG;
	process.env.NODE_ENV = "production";

	for (const releaseTag of ["0.1.33", "latest", "nightly"]) {
		process.env.RELEASE_TAG = releaseTag;
		expect(getMonitoringImageCandidates()).toEqual([
			`ghcr.io/nearzero-systems/monitoring:${releaseTag}`,
		]);
	}
});

test("treats a configured metrics URL as externally managed", () => {
	process.env.NEARZERO_METRICS_URL = "http://monitoring:4500/metrics";
	expect(isExternallyManagedWebMonitoring()).toBe(true);
});

test("allows local lifecycle management without a metrics URL", () => {
	delete process.env.NEARZERO_METRICS_URL;
	expect(isExternallyManagedWebMonitoring()).toBe(false);
});

test("publishes monitoring only on IPv4 loopback", () => {
	const config = monitoringLoopbackPortConfig(4500);
	expect(config).toEqual({
		PortBindings: {
			"4500/tcp": [{ HostIp: "127.0.0.1", HostPort: "4500" }],
		},
		ExposedPorts: { "4500/tcp": {} },
	});
	expect(() => monitoringLoopbackPortConfig(0)).toThrow();
});

test("denies Docker metadata access when no services are explicitly included", () => {
	delete process.env.NEARZERO_ALLOW_MONITORING_DOCKER_METADATA;
	const config = monitoringDockerAccessConfig([]);
	expect(config.enabled).toBe(false);
	expect(config.dockerHost).toBeUndefined();
	expect(config.networkingConfig.EndpointsConfig).toEqual({
		"nearzero-network": {},
	});
});

test("requires an explicit metadata-exposure opt-in for container metrics", () => {
	delete process.env.NEARZERO_ALLOW_MONITORING_DOCKER_METADATA;
	expect(() => monitoringDockerAccessConfig(["app"])).toThrow(
		"NEARZERO_ALLOW_MONITORING_DOCKER_METADATA=true",
	);

	process.env.NEARZERO_ALLOW_MONITORING_DOCKER_METADATA = "true";
	const config = monitoringDockerAccessConfig(["app"]);
	expect(config.enabled).toBe(true);
	expect(config.dockerHost).toBe("tcp://nearzero-docker-proxy:2375");
	expect(config.networkingConfig.EndpointsConfig).toEqual({
		"nearzero-network": {},
		"nearzero-traefik-control": {},
	});
});

test("OSS Compose gives monitoring no Docker or host-process access", () => {
	const compose = parse(
		readFileSync(
			new URL("../../../../docker-compose.prod.yml", import.meta.url),
			"utf8",
		),
	) as {
		services: Record<string, Record<string, unknown>>;
		networks?: Record<string, Record<string, unknown>>;
	};
	const monitoring = compose.services.monitoring ?? {};
	const monitoringVolumes = monitoring.volumes as string[];
	const monitoringEnvironment = monitoring.environment as Record<
		string,
		string
	>;

	expect(compose.services["monitoring-docker-proxy"]).toBeUndefined();
	expect(
		monitoringVolumes.some((volume) => volume.includes("/var/run/docker.sock")),
	).toBe(false);
	expect(monitoringVolumes).not.toContain("/proc:/host/proc:ro");
	expect(monitoringVolumes).not.toContain("/:/host/root:ro");
	expect(monitoringVolumes).toContain("/etc/nearzero/monitoring:/host/root:ro");
	expect(monitoringEnvironment.DOCKER_HOST).toBeUndefined();
	expect(monitoringEnvironment.HOST_PROC).toBeUndefined();
	expect(compose.networks?.["monitoring-control"]).toBeUndefined();
});
