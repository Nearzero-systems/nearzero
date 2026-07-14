import { randomUUID } from "node:crypto";
import path from "node:path";
import { paths } from "@nearzero/server/constants";
import { quote } from "shell-quote";
import type { PreparedShellCommand } from "../process/execAsync";

interface CredentialedGitCloneInput {
	repositoryUrl: string;
	username: string;
	password: string;
	branch: string;
	outputPath: string;
	enableSubmodules: boolean;
	isRemote: boolean;
}

const cleanHttpsRepositoryUrl = (value: string) => {
	if (/[\0\r\n]/.test(value)) {
		throw new Error("Git provider repository URL contains control data");
	}
	let repository: URL;
	try {
		repository = new URL(value);
	} catch {
		throw new Error("Git provider repository URL is invalid");
	}
	if (repository.protocol !== "https:") {
		throw new Error(
			"Credentialed Git clones require HTTPS so provider tokens are encrypted in transit",
		);
	}
	if (
		repository.username ||
		repository.password ||
		repository.search ||
		repository.hash
	) {
		throw new Error(
			"Git provider repository URLs cannot contain credentials, query parameters, or fragments",
		);
	}
	return repository;
};

/**
 * Builds an HTTPS clone whose credentials exist only in execution-time stdin
 * and protected temporary files. The credential helper releases them only for
 * the exact repository authority, including recursive submodule operations.
 */
export const prepareCredentialedGitClone = (
	input: CredentialedGitCloneInput,
): PreparedShellCommand => {
	if (!input.username || !input.password) {
		throw new Error("Git provider credentials are missing");
	}
	if (/[\0\r\n]/.test(input.username) || /[\0\r\n]/.test(input.password)) {
		throw new Error(
			"Git provider credentials contain unsupported control data",
		);
	}
	const repository = cleanHttpsRepositoryUrl(input.repositoryUrl);
	const { SSH_PATH } = paths(input.isRemote);
	const authPrefix = path.join(SSH_PATH, `.git-auth-${randomUUID()}`);
	const helperPath = `${authPrefix}.helper`;
	const usernamePath = `${authPrefix}.username`;
	const passwordPath = `${authPrefix}.password`;
	const usernameEncoded = Buffer.from(input.username, "utf8").toString(
		"base64",
	);
	const passwordEncoded = Buffer.from(input.password, "utf8").toString(
		"base64",
	);
	const repositoryUrl = repository.toString();
	const repositoryAuthority = repository.host;
	const outputPathArg = quote([input.outputPath]);
	const helperPathArg = quote([helperPath]);
	const usernamePathArg = quote([usernamePath]);
	const passwordPathArg = quote([passwordPath]);

	const helperScript = `#!/bin/sh
set -eu
[ "\${1:-}" = get ] || exit 0
protocol=''
host=''
while IFS='=' read -r key value; do
	case "$key" in
		protocol) protocol=$value ;;
		host) host=$value ;;
	esac
done
[ "$protocol" = https ] || exit 0
[ "$host" = "$NEARZERO_GIT_ALLOWED_AUTHORITY" ] || exit 0
printf 'username='
cat -- "$NEARZERO_GIT_USERNAME_FILE"
printf '\\npassword='
cat -- "$NEARZERO_GIT_PASSWORD_FILE"
printf '\\n'`;

	const credentialConfig = [
		"-c credential.helper=",
		`-c credential.helper=${quote([helperPath])}`,
		"-c credential.useHttpPath=true",
		"-c http.extraHeader=",
		"-c http.sslVerify=true",
		"-c http.followRedirects=false",
		"-c protocol.allow=never",
		"-c protocol.https.allow=always",
	].join(" ");
	const command = `set -eu
git_auth_directory=${quote([SSH_PATH])}
git_auth_helper=${helperPathArg}
git_auth_username=${usernamePathArg}
git_auth_password=${passwordPathArg}
cleanup_git_auth() {
	rm -f -- "$git_auth_helper" "$git_auth_username" "$git_auth_password"
}
trap cleanup_git_auth EXIT
if [ -L "$git_auth_directory" ]; then
	echo 'Nearzero Git credential storage cannot be a symbolic link' >&2
	exit 66
fi
umask 077
install -d -m 0700 "$git_auth_directory"
chmod 700 "$git_auth_directory"
for auth_file in "$git_auth_helper" "$git_auth_username" "$git_auth_password"; do
	if [ -e "$auth_file" ] || [ -L "$auth_file" ]; then
		echo 'Nearzero Git credential file already exists' >&2
		exit 73
	fi
done
if ! IFS= read -r git_username_encoded || ! IFS= read -r git_password_encoded; then
	echo 'Git provider credential payload is incomplete' >&2
	exit 65
fi
case "$git_username_encoded:$git_password_encoded" in
	*[!A-Za-z0-9+/=:]*) echo 'Git provider credential payload is invalid' >&2; exit 65 ;;
esac
printf '%s' "$git_username_encoded" | base64 -d > "$git_auth_username"
printf '%s' "$git_password_encoded" | base64 -d > "$git_auth_password"
cat > "$git_auth_helper" <<'NEARZERO_GIT_CREDENTIAL_HELPER'
${helperScript}
NEARZERO_GIT_CREDENTIAL_HELPER
chmod 700 "$git_auth_helper"
chmod 600 "$git_auth_username" "$git_auth_password"
export NEARZERO_GIT_ALLOWED_AUTHORITY=${quote([repositoryAuthority])}
export NEARZERO_GIT_USERNAME_FILE="$git_auth_username"
export NEARZERO_GIT_PASSWORD_FILE="$git_auth_password"
export GIT_TERMINAL_PROMPT=0
git_clean_path=\${PATH:-/usr/bin:/bin}
git_clean_home=\${HOME:-/tmp}
run_authenticated_git() {
	env -i PATH="$git_clean_path" HOME="$git_clean_home" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 NEARZERO_GIT_ALLOWED_AUTHORITY="$NEARZERO_GIT_ALLOWED_AUTHORITY" NEARZERO_GIT_USERNAME_FILE="$NEARZERO_GIT_USERNAME_FILE" NEARZERO_GIT_PASSWORD_FILE="$NEARZERO_GIT_PASSWORD_FILE" git "$@"
}
rm -rf -- ${outputPathArg}
mkdir -p -- ${outputPathArg}
echo 'Cloning authenticated Git repository: ✅'
run_authenticated_git ${credentialConfig} clone --branch ${quote([
		input.branch,
	])} --depth 1 --progress -- ${quote([repositoryUrl])} ${outputPathArg}
run_authenticated_git -C ${outputPathArg} remote set-url origin ${quote([repositoryUrl])}
${
	input.enableSubmodules
		? `run_authenticated_git ${credentialConfig} -C ${outputPathArg} submodule sync --recursive
run_authenticated_git ${credentialConfig} -C ${outputPathArg} submodule update --init --recursive --depth 1`
		: ""
}
if [ "$(run_authenticated_git -C ${outputPathArg} remote get-url origin)" != ${quote(
		[repositoryUrl],
	)} ]; then
	echo 'Git origin URL was not sanitized' >&2
	exit 70
fi
if grep -F -q -f "$git_auth_password" ${outputPathArg}/.gitmodules 2>/dev/null; then
	echo 'A Git submodule configuration retained provider credentials' >&2
	exit 70
fi
if find ${outputPathArg}/.git -type f -name config -exec grep -F -q -f "$git_auth_password" {} \\; -print -quit | grep -q .; then
	echo 'Git configuration retained provider credentials' >&2
	exit 70
fi
cleanup_git_auth
trap - EXIT
unset NEARZERO_GIT_ALLOWED_AUTHORITY NEARZERO_GIT_USERNAME_FILE NEARZERO_GIT_PASSWORD_FILE GIT_TERMINAL_PROMPT`;

	return {
		command,
		input: `${usernameEncoded}\n${passwordEncoded}\n`,
	};
};
