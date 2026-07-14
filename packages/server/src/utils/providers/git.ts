import { randomUUID } from "node:crypto";
import path, { join } from "node:path";
import { paths } from "@nearzero/server/constants";
import {
	findSSHKeyById,
	updateSSHKeyById,
} from "@nearzero/server/services/ssh-key";
import { quote } from "shell-quote";
import type { PreparedShellCommand } from "../process/execAsync";
import { execAsync, execAsyncRemote } from "../process/execAsync";

interface CloneGitRepository {
	appName: string;
	customGitUrl?: string | null;
	customGitBranch?: string | null;
	customGitSSHKeyId?: string | null;
	enableSubmodules?: boolean;
	serverId: string | null;
	type?: "application" | "compose";
	outputPathOverride?: string;
}

export const cloneGitRepository = async (
	{ type = "application", ...entity }: CloneGitRepository,
	options?: { targetServerId?: string | null },
): Promise<PreparedShellCommand> => {
	let command = "set -e;";
	const {
		appName,
		customGitUrl,
		customGitBranch,
		customGitSSHKeyId,
		enableSubmodules,
		serverId,
		outputPathOverride,
	} = entity;
	const targetServerId = options?.targetServerId ?? serverId;
	const { SSH_PATH, COMPOSE_PATH, APPLICATIONS_PATH } = paths(!!targetServerId);

	if (!customGitUrl || !customGitBranch) {
		command += `echo "Error: ❌ Repository not found"; exit 1;`;
		return { command };
	}

	const transport = parseCustomGitTransport(customGitUrl);
	const basePath = type === "compose" ? COMPOSE_PATH : APPLICATIONS_PATH;
	const outputPath = outputPathOverride ?? join(basePath, appName, "code");
	const knownHostsPath = path.join(SSH_PATH, "known_hosts");
	const outputPathArg = quote([outputPath]);
	const repositoryArg = `'${customGitUrl.replaceAll("'", `'"'"'`)}'`;
	const branchArg = quote([customGitBranch]);

	let privateKey: string | undefined;
	let temporalKeyPath: string | null = null;
	if (transport.type === "ssh") {
		if (!customGitSSHKeyId) {
			command += `echo "Error: ❌ You are trying to clone a ssh repository without a ssh key, please set a ssh key"; exit 1;`;
			return { command };
		}

		const sshKey = await findSSHKeyById(customGitSSHKeyId);
		privateKey = sshKey.privateKey;
		await updateSSHKeyById({
			sshKeyId: customGitSSHKeyId,
			lastUsedAt: new Date().toISOString(),
		});
		temporalKeyPath = path.join(SSH_PATH, `.git-deploy-key-${randomUUID()}`);
		const sshPathArg = quote([SSH_PATH]);
		const keyPathArg = quote([temporalKeyPath]);
		command += `
		if [ -L ${sshPathArg} ]; then
			echo 'Nearzero SSH storage cannot be a symbolic link' >&2
			exit 66
		fi
		umask 077
		mkdir -p -- ${sshPathArg}
		chmod 700 -- ${sshPathArg}
		GIT_KEY_PATH=${quote([temporalKeyPath])}
		cleanup_git_key() { rm -f -- "$GIT_KEY_PATH"; }
		trap cleanup_git_key EXIT
		if [ -e ${keyPathArg} ] || [ -L ${keyPathArg} ] || ! (set -C; cat > ${keyPathArg}); then
			echo 'Could not provision the custom Git deploy key' >&2
			exit 73
		fi
		chmod 600 -- ${keyPathArg}
		if [ ! -s ${keyPathArg} ]; then
			echo 'Custom Git deploy key is empty' >&2
			exit 65
		fi
		`;
		command += addHostToKnownHostsCommand(
			transport.domain,
			transport.port,
			knownHostsPath,
		);
	}

	command += `rm -rf -- ${outputPathArg};`;
	command += `mkdir -p -- ${outputPathArg};`;
	command += 'echo "Cloning custom repository: ✅";';

	if (transport.type === "ssh" && temporalKeyPath) {
		const gitSshCommand = [
			"ssh",
			"-i",
			temporalKeyPath,
			"-p",
			String(transport.port),
			"-o",
			"BatchMode=yes",
			"-o",
			"IdentitiesOnly=yes",
			"-o",
			"StrictHostKeyChecking=yes",
			"-o",
			`UserKnownHostsFile=${knownHostsPath}`,
		]
			.map((part) => quote([part]))
			.join(" ");
		command += `export GIT_SSH_COMMAND=${quote([gitSshCommand])};`;
	}
	command += `if ! git clone --branch ${branchArg} --depth 1 ${enableSubmodules ? "--recurse-submodules" : ""} --progress -- ${repositoryArg} ${outputPathArg}; then
				echo "❌ [ERROR] Failed to clone the custom repository";
				exit 1;
			fi
			`;
	if (temporalKeyPath) {
		command +=
			"cleanup_git_key; trap - EXIT; unset GIT_KEY_PATH GIT_SSH_COMMAND;";
	}

	return { command, input: privateKey };
};

type CustomGitTransport =
	| { type: "https" }
	| { type: "ssh"; domain: string; port: number };

const parseCustomGitTransport = (repositoryUrl: string): CustomGitTransport => {
	if (/^https?:\/\//i.test(repositoryUrl)) {
		let parsed: URL;
		try {
			parsed = new URL(repositoryUrl);
		} catch {
			throw new Error("Custom Git URL is invalid");
		}
		if (parsed.protocol !== "https:") {
			throw new Error("Custom Git repositories must use HTTPS or SSH");
		}
		if (parsed.username || parsed.password || parsed.search || parsed.hash) {
			throw new Error(
				"Custom Git URLs cannot contain credentials, query parameters, or fragments",
			);
		}
		return { type: "https" };
	}

	const { domain, port, protocol } = sanitizeRepoPathSSH(repositoryUrl);
	if (protocol && protocol !== "ssh") {
		throw new Error("Custom Git repositories must use HTTPS or SSH");
	}
	if (!domain) throw new Error("Custom Git SSH URL is missing a host");
	return { type: "ssh", domain, port };
};

// const addHostToKnownHosts = async (repositoryURL: string) => {
// 	const { SSH_PATH } = paths();
// 	const { domain, port } = sanitizeRepoPathSSH(repositoryURL);
// 	const knownHostsPath = path.join(SSH_PATH, "known_hosts");

// 	const command = `ssh-keyscan -p ${port} ${domain} >> ${knownHostsPath}`;
// 	try {
// 		await execAsync(command);
// 	} catch (error) {
// 		console.error(`Error adding host to known_hosts: ${error}`);
// 		throw error;
// 	}
// };

const addHostToKnownHostsCommand = (
	domain: string,
	port: number,
	knownHostsPath: string,
) => {
	const sshPath = path.dirname(knownHostsPath);
	const sshPathArg = quote([sshPath]);
	const knownHostsPathArg = quote([knownHostsPath]);
	const domainArg = quote([domain]);
	const lookupHost = port === 22 ? domain : `[${domain}]:${port}`;
	const lookupHostArg = quote([lookupHost]);

	return `
		umask 077
		mkdir -p -- ${sshPathArg}
		chmod 700 -- ${sshPathArg}
		touch -- ${knownHostsPathArg}
		chmod 600 -- ${knownHostsPathArg}
		if ! ssh-keygen -F ${lookupHostArg} -f ${knownHostsPathArg} >/dev/null 2>&1; then
			KNOWN_HOSTS_CANDIDATE=$(mktemp ${quote([
				path.join(sshPath, ".known-hosts.XXXXXX"),
			])})
			if ! ssh-keyscan -T 10 -p ${port} ${domainArg} > "$KNOWN_HOSTS_CANDIDATE" 2>/dev/null || [ ! -s "$KNOWN_HOSTS_CANDIDATE" ]; then
				rm -f -- "$KNOWN_HOSTS_CANDIDATE"
				echo 'Could not obtain the custom Git host key' >&2
				exit 69
			fi
			cat -- "$KNOWN_HOSTS_CANDIDATE" >> ${knownHostsPathArg}
			rm -f -- "$KNOWN_HOSTS_CANDIDATE"
		fi
	`;
};
const sanitizeRepoPathSSH = (input: string) => {
	const SSH_PATH_RE = new RegExp(
		[
			/^\s*/,
			/(?:(?<proto>[a-z]+):\/\/)?/,
			/(?:(?<user>[a-z_][a-z0-9_-]+)@)?/,
			/(?<domain>[^\s/?#:]+)/,
			/(?::(?<port>[0-9]{1,5}))?/,
			/(?:[/:](?<owner>[^\s/?#:]+))?/,
			/(?:[/:](?<repo>(?:[^\s?#:.]|\.(?!git\/?\s*$))+))/,
			/(?:.git)?\/?\s*$/,
		]
			.map((r) => r.source)
			.join(""),
		"i",
	);

	const found = input.match(SSH_PATH_RE);
	if (!found) {
		throw new Error(`Malformatted SSH path: ${input}`);
	}

	const port = Number(found.groups?.port ?? 22);
	if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
		throw new Error("Custom Git SSH port must be between 1 and 65535");
	}

	return {
		protocol: found.groups?.proto?.toLowerCase(),
		user: found.groups?.user ?? "git",
		domain: found.groups?.domain,
		port,
		owner: found.groups?.owner ?? "",
		repo: found.groups?.repo,
		get repoPath() {
			return `ssh://${this.user}@${this.domain}:${this.port}/${this.owner}${
				this.owner && "/"
			}${this.repo}.git`;
		},
	};
};

interface Props {
	appName: string;
	type?: "application" | "compose";
	serverId: string | null;
}

export const getGitCommitInfo = async ({
	appName,
	type = "application",
	serverId,
}: Props) => {
	const { COMPOSE_PATH, APPLICATIONS_PATH } = paths(!!serverId);
	const basePath = type === "compose" ? COMPOSE_PATH : APPLICATIONS_PATH;
	const outputPath = join(basePath, appName, "code");
	let stdoutResult = "";
	const result = {
		message: "",
		hash: "",
	};
	try {
		const gitCommand = `git -C ${outputPath} log -1 --pretty=format:"%H---DELIMITER---%B"`;
		if (serverId) {
			const { stdout } = await execAsyncRemote(serverId, gitCommand);
			stdoutResult = stdout.trim();
		} else {
			const { stdout } = await execAsync(gitCommand);
			stdoutResult = stdout.trim();
		}

		const parts = stdoutResult.split("---DELIMITER---");
		if (parts && parts.length === 2) {
			result.hash = parts[0]?.trim() || "";
			result.message = parts[1]?.trim() || "";
		}
	} catch (error) {
		console.error(`Error getting git commit info: ${error}`);
		return null;
	}
	return result;
};
