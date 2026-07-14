import { spawnSync } from "node:child_process";
import {
	BUN_BOOTSTRAP_VERSION,
	DOCKER_COMPOSE_BOOTSTRAP_VERSION,
	defaultCommand,
	installRClone,
	isLatestGeneratedCommand,
	normalizeDockerImageReference,
	normalizeTraefikPort,
	normalizeTraefikVersion,
	PNPM_BOOTSTRAP_VERSION,
	RCLONE_BOOTSTRAP_VERSION,
} from "@nearzero/server";
import { describe, expect, test } from "vitest";

describe("remote server bootstrap supply-chain controls", () => {
	test("accepts inert pinned ingress references and rejects shell syntax", () => {
		expect(normalizeTraefikVersion("3.6.17")).toBe("3.6.17");
		expect(normalizeTraefikVersion("3.7.0-rc.1")).toBe("3.7.0-rc.1");
		expect(
			normalizeDockerImageReference(
				"registry.example.com:5000/traefik@sha256:abc123",
				"TRAEFIK_IMAGE",
			),
		).toBe("registry.example.com:5000/traefik@sha256:abc123");

		expect(() => normalizeTraefikVersion("latest")).toThrow(
			"exact semantic version",
		);
		expect(() => normalizeTraefikVersion("3.6.17; touch /tmp/pwned")).toThrow(
			"exact semantic version",
		);
		expect(() =>
			normalizeDockerImageReference(
				"traefik:3.6.17\n--privileged",
				"TRAEFIK_IMAGE",
			),
		).toThrow("unsupported image-reference characters");
		expect(() =>
			normalizeDockerImageReference(
				"traefik:3.6.17;touch-/tmp/pwned",
				"TRAEFIK_IMAGE",
			),
		).toThrow("unsupported image-reference characters");
	});

	test("rejects malformed or host-reserved ingress ports", () => {
		expect(normalizeTraefikPort(undefined, 443, "TRAEFIK_SSL_PORT")).toBe(443);
		expect(normalizeTraefikPort("8443", 443, "TRAEFIK_SSL_PORT")).toBe(8443);
		expect(() =>
			normalizeTraefikPort("443;touch", 443, "TRAEFIK_SSL_PORT"),
		).toThrow("integer between 1 and 65535");
		expect(() =>
			normalizeTraefikPort("70000", 443, "TRAEFIK_SSL_PORT"),
		).toThrow("integer between 1 and 65535");
		expect(() => normalizeTraefikPort("4500", 443, "TRAEFIK_SSL_PORT")).toThrow(
			"reserved by a Nearzero host service",
		);
	});

	test("never streams a network response into a shell", () => {
		const command = defaultCommand();

		expect(command).not.toContain("get.docker.com");
		expect(command).not.toContain("rclone.org/install.sh");
		expect(command).not.toContain("bun.sh/install");
		expect(command).not.toContain("get.pnpm.io/install.sh");
		expect(command).not.toContain("nixpacks.com/install.sh");
		expect(command).not.toContain("railpack.com/install.sh");
		expect(command).not.toContain("monitoring:latest");
		expect(command).not.toMatch(/(?:curl|wget)[^\n]*\|[^\n]*(?:bash|sh)\b/);
	});

	test("uses immutable versioned artifacts and embedded SHA-256 digests", () => {
		const command = defaultCommand();
		const digests = command.match(/\b[0-9a-f]{64}\b/g) ?? [];

		expect(command).toContain(`RCLONE_VERSION=${RCLONE_BOOTSTRAP_VERSION}`);
		expect(command).toContain(
			`COMPOSE_VERSION=${DOCKER_COMPOSE_BOOTSTRAP_VERSION}`,
		);
		expect(command).toContain(`BUN_VERSION=${BUN_BOOTSTRAP_VERSION}`);
		expect(command).toContain(`PNPM_VERSION=${PNPM_BOOTSTRAP_VERSION}`);
		expect(command).not.toContain("releases/latest/download");
		expect(command).toContain("sha256sum -c -");
		expect(command).toContain("Checksum verification failed");
		expect(digests.length).toBeGreaterThanOrEqual(20);
	});

	test("installs Docker through package repositories and verifies Compose fallback", () => {
		const command = defaultCommand();

		expect(command).toContain("run_apt install -y docker.io");
		expect(command).toContain("dnf install -y docker-ce");
		expect(command).toContain("zypper install -y docker");
		expect(command).toContain("apk add docker docker-cli-compose");
		expect(command).toContain("pacman -Sy docker docker-compose");
		expect(command).toContain("install_verified_compose_plugin");
		expect(command).toContain("docker compose version");
		expect(command).toContain(
			"Preinstall Docker $DOCKER_VERSION from a signed package repository",
		);
	});

	test("forces old generated setup commands to regenerate", () => {
		const current = defaultCommand();
		const legacy = current.replace(
			"# nearzero-container-hardening-v1",
			"# legacy-container-hardening",
		);

		expect(current).toContain("# nearzero-bootstrap-supply-chain-v2");
		expect(current).toContain("# nearzero-container-hardening-v1");
		expect(isLatestGeneratedCommand(current)).toBe(true);
		expect(isLatestGeneratedCommand(legacy)).toBe(false);
	});

	test("drops container capabilities and protects host-side runtime storage", () => {
		const command = defaultCommand();

		expect(command).toContain("install -d -m 0700");
		expect(command).toContain(
			'install -d -m 0700 "/etc/nearzero/secrets/compose-env"',
		);
		expect(command).toContain('install -d -m 0700 "/etc/nearzero/dns/zones"');
		expect(command).not.toContain(
			'install -d -m 0700 "/etc/nearzero/dns/Corefile"',
		);
		expect(command).toContain('rmdir -- "/etc/nearzero/dns/Corefile"');
		expect(command).toContain("chmod 700 /etc/nearzero");
		expect(command).toContain("--cap-drop ALL");
		expect(command).toContain("--cap-add NET_BIND_SERVICE");
		expect(command).toContain(
			'chmod 600 "/etc/nearzero/traefik/dynamic/acme.json"',
		);
	});

	test("activates a validated key-only OpenSSH policy with rollback", () => {
		const command = defaultCommand(undefined, 22_222);

		expect(command).toContain("# nearzero-managed-ssh-v1");
		expect(command).toContain("AuthenticationMethods publickey");
		expect(command).toContain("PasswordAuthentication no");
		expect(command).toContain("KbdInteractiveAuthentication no");
		expect(command).toContain("PermitRootLogin prohibit-password");
		expect(command).toContain("AllowTcpForwarding local");
		expect(command).toContain('"$SSHD_BIN" -t -f "$SSHD_CANDIDATE"');
		expect(command).toContain('"$SSHD_BIN" -T -f "$SSHD_CANDIDATE"');
		expect(command).toContain("sshd_config.nearzero-backup");
		expect(command).toContain("nearzero_restore_sshd");
		expect(command).toContain(
			"cloud firewall restricted to trusted sources on SSH port 22222",
		);
		expect(command).not.toContain("PermitRootLogin no");
		expect(command).not.toMatch(/^\s*Port\s+22222\s*$/m);
	});

	test("keeps the generated setup command valid Bash", () => {
		const result = spawnSync("bash", ["-n"], {
			encoding: "utf8",
			input: defaultCommand(),
		});

		expect(result.status, result.stderr).toBe(0);
	});

	test("rclone bootstrap fails closed on unsupported architectures", () => {
		const command = installRClone();

		expect(command).toContain(
			"No checksum-pinned rclone artifact is available",
		);
		expect(command).toContain("download_verified_artifact");
		expect(command).not.toMatch(/curl[^\n]*\|[^\n]*(?:bash|sh)\b/);
	});
});
