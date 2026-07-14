import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Compose, Domain } from "@nearzero/server";
import {
	buildComposeDomainRoutingReconcileCommand,
	getComposePath,
	reconcileDomainsInComposeSpecification,
} from "@nearzero/server";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

const compose = {
	appName: "compose-live-routing",
	serverId: null,
	sourceType: "raw",
	composeType: "docker-compose",
	composePath: "docker-compose.yml",
	isolatedDeployment: false,
	isolatedDeploymentsVolume: false,
	randomize: false,
	suffix: "",
} as unknown as Compose;

const domain = {
	domainId: "domain-live-routing",
	host: "app.example.com",
	port: 3000,
	customEntrypoint: null,
	https: true,
	uniqueConfigKey: 42,
	customCertResolver: null,
	certificateType: "letsencrypt",
	applicationId: null,
	composeId: "compose-id",
	domainType: "compose",
	serviceName: "web",
	path: "/",
	createdAt: "",
	previewDeploymentId: null,
	internalPath: "/",
	stripPath: false,
	middlewares: null,
} as Domain;

describe("live Compose domain routing reconciliation", () => {
	it("builds a serialized, validated, atomic no-build Compose update with rollback", () => {
		const command = buildComposeDomainRoutingReconcileCommand({
			appName: "compose-live-routing",
			projectPath: "/etc/nearzero/compose/compose-live-routing/code",
			composePath:
				"/etc/nearzero/compose/compose-live-routing/code/docker-compose.yml",
			envFilePath: "/etc/nearzero/secrets/compose-env/compose-live-routing.env",
			composeType: "docker-compose",
			expectedSha256: "a".repeat(64),
		});

		expect(command).toContain(".nearzero-domain-routing.lock");
		expect(command).toContain('actual_hash=$(sha256sum -- "$compose_file"');
		expect(command).toContain("config --quiet");
		expect(command).toContain('--env-file "$runtime_env_file"');
		expect(command).toContain("up -d --no-build --remove-orphans");
		expect(command).not.toContain("up -d --build");
		expect(command).toContain('cat > "$candidate"');
		expect(command).toContain('chmod 600 "$candidate"');
		expect(command).toContain('mv -f -- "$candidate" "$compose_file"');
		expect(command).toContain('mv -f -- "$backup" "$compose_file"');
		expect(command).toContain('if apply_file "$compose_file"; then');
	});

	it("validates and deploys stack routing without rebuilding images", () => {
		const command = buildComposeDomainRoutingReconcileCommand({
			appName: "compose-live-routing",
			projectPath: "/etc/nearzero/compose/compose-live-routing/code",
			composePath: "/etc/nearzero/compose/compose-live-routing/code/stack.yml",
			envFilePath: "/etc/nearzero/secrets/compose-env/compose-live-routing.env",
			composeType: "stack",
			expectedSha256: "b".repeat(64),
		});

		expect(command).toContain('run_stack config "$1"');
		expect(command).toContain('run_stack deploy "$1"');
		expect(command).toContain('"--prune", "--with-registry-auth"');
		expect(command).toContain('NEARZERO_COMPOSE_ENV_FILE="$runtime_env_file"');
		expect(command).toContain("nearzero-stack-env-v1");
		expect(command).toContain("Bun.spawnSync");
		expect(command).not.toContain("--build");
	});

	it("restores and reapplies the previous file when the live update fails", () => {
		const root = mkdtempSync(join(tmpdir(), "nearzero-compose-routing-"));
		temporaryDirectories.push(root);
		const projectPath = join(root, "project");
		const composePath = join(projectPath, "docker-compose.yml");
		const envFilePath = join(root, "secrets", "compose-live-routing.env");
		const fakeBin = join(root, "bin");
		mkdirSync(projectPath, { recursive: true });
		mkdirSync(fakeBin, { recursive: true });
		mkdirSync(join(root, "secrets"), { recursive: true });
		const original = "services:\n  web:\n    image: nginx:old\n";
		const candidate = "services:\n  web:\n    image: nginx:new\n";
		writeFileSync(composePath, original, "utf8");
		writeFileSync(envFilePath, 'APP_NAME="compose-live-routing"\n', {
			mode: 0o600,
		});

		const expectedSha256 = "d".repeat(64);
		writeFileSync(
			join(fakeBin, "sha256sum"),
			`#!/bin/sh\nprintf '%s  %s\\n' '${expectedSha256}' "$2"\n`,
		);
		writeFileSync(
			join(fakeBin, "readlink"),
			'#!/bin/sh\n[ "$1" = "-f" ] && shift\n[ "$1" = "--" ] && shift\nprintf \'%s\\n\' "$1"\n',
		);
		writeFileSync(
			join(fakeBin, "docker"),
			`#!/bin/sh
root=$(dirname "$0")
printf '%s\\n' "$*" >> "$root/docker.log"
case "$*" in
	*" config --quiet") exit 0 ;;
	*" up -d --no-build "*)
		if [ ! -f "$root/failed-once" ]; then
			: > "$root/failed-once"
			exit 42
		fi
		exit 0
		;;
esac
exit 1
`,
		);
		for (const executable of ["sha256sum", "readlink", "docker"]) {
			chmodSync(join(fakeBin, executable), 0o700);
		}

		const command = buildComposeDomainRoutingReconcileCommand({
			appName: "compose-live-routing",
			projectPath,
			composePath,
			envFilePath,
			composeType: "docker-compose",
			expectedSha256,
		});
		const result = spawnSync("/bin/sh", ["-c", command], {
			input: candidate,
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${fakeBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
			},
		});

		expect(result.status).toBe(42);
		expect(result.stderr).toContain(
			"previous configuration was restored and reapplied",
		);
		expect(readFileSync(composePath, "utf8")).toBe(original);
		expect(statSync(composePath).mode & 0o777).toBe(0o600);
		expect(readFileSync(envFilePath, "utf8")).toBe(
			'APP_NAME="compose-live-routing"\n',
		);
		const dockerCalls = readFileSync(join(fakeBin, "docker.log"), "utf8")
			.trim()
			.split("\n");
		expect(dockerCalls).toHaveLength(3);
		expect(dockerCalls[0]).toContain("config --quiet");
		expect(dockerCalls[1]).toContain("up -d --no-build");
		expect(dockerCalls[2]).toContain("up -d --no-build");
	});

	it("rejects compose paths that escape the managed project", () => {
		expect(() =>
			getComposePath({
				...compose,
				sourceType: "github",
				composePath: "../../../etc/passwd",
			}),
		).toThrow("escapes its project directory");

		expect(() =>
			buildComposeDomainRoutingReconcileCommand({
				appName: "compose-live-routing",
				projectPath: "/etc/nearzero/compose/compose-live-routing/code",
				composePath: "/etc/shadow",
				envFilePath:
					"/etc/nearzero/secrets/compose-env/compose-live-routing.env",
				composeType: "docker-compose",
				expectedSha256: "c".repeat(64),
			}),
		).toThrow("escapes its project directory");
	});

	it("does not apply randomization twice to a cached deployment file", () => {
		const cachedCompose = {
			...compose,
			randomize: true,
			suffix: "blue",
		} as Compose;
		const cachedDomain = { ...domain, serviceName: "web-blue" } as Domain;
		const result = reconcileDomainsInComposeSpecification(
			cachedCompose,
			[cachedDomain],
			{
				services: {
					"web-blue": { image: "nginx:alpine" },
				},
			},
			{ applyDeploymentTransforms: false },
		);

		expect(Object.keys(result.services)).toEqual(["web-blue"]);
		expect(result.services["web-blue"].labels).toContain(
			"nearzero.managed-domain-routing=true",
		);
		expect(result.services["web-blue"].labels).toContain(
			"traefik.http.routers.compose-live-routing-42-web.rule=Host(`app.example.com`)",
		);
	});
});
