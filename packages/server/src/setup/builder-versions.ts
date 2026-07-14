export const NIXPACKS_VERSION = "1.41.0";
export const RAILPACK_VERSION = "0.15.4";
export const BUILDPACKS_VERSION = "0.39.1";
export const COREPACK_VERSION = "0.31.0";

const readVersion = (command: string) =>
	`${command} --version 2>/dev/null | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+' | head -n 1 || true`;

const verifiedArtifactPrelude = () => `
	for NZ_REQUIRED_COMMAND in curl install mktemp sha256sum tar; do
		if ! command -v "$NZ_REQUIRED_COMMAND" >/dev/null 2>&1; then
			echo "$NZ_REQUIRED_COMMAND is required to install checksum-pinned build tools." >&2
			exit 48
		fi
	done

	nz_download_verified_artifact() {
		NZ_URL="$1"
		NZ_EXPECTED_SHA256="$2"
		NZ_DESTINATION="$3"
		case "$NZ_EXPECTED_SHA256" in
			"" | *[!0-9a-f]*)
				echo "Invalid pinned SHA-256 digest for $NZ_URL" >&2
				return 1
				;;
		esac
		if [ "\${#NZ_EXPECTED_SHA256}" -ne 64 ]; then
			echo "Invalid pinned SHA-256 digest length for $NZ_URL" >&2
			return 1
		fi
		rm -f "$NZ_DESTINATION"
		if ! curl --fail --location --show-error --silent \\
			--proto '=https' --proto-redir '=https' --tlsv1.2 \\
			--retry 3 --connect-timeout 20 --max-time 300 \\
			--output "$NZ_DESTINATION" "$NZ_URL"; then
			rm -f "$NZ_DESTINATION"
			return 1
		fi
		if ! printf '%s  %s\\n' "$NZ_EXPECTED_SHA256" "$NZ_DESTINATION" | sha256sum -c - >/dev/null; then
			echo "Checksum verification failed for $NZ_URL" >&2
			rm -f "$NZ_DESTINATION"
			return 1
		fi
	}
`;

export const installPinnedNixpacks = () => `
	NZ_EXPECTED_NIXPACKS_VERSION="${NIXPACKS_VERSION}"
	NZ_CURRENT_NIXPACKS_VERSION="$(${readVersion("nixpacks")})"
	if [ "$NZ_CURRENT_NIXPACKS_VERSION" != "$NZ_EXPECTED_NIXPACKS_VERSION" ]; then
		${verifiedArtifactPrelude()}
		case "$SYS_ARCH" in
			x86_64 | amd64)
				NZ_NIXPACKS_TARGET=x86_64-unknown-linux-musl
				NZ_NIXPACKS_SHA256=0f55de7874507b9cf7502113120bd96f2ab6979f78d10eaf2eb2ade9207b3af6
				;;
			aarch64 | arm64)
				NZ_NIXPACKS_TARGET=aarch64-unknown-linux-musl
				NZ_NIXPACKS_SHA256=912bd02dd2bb6f9c3a9ed965fe8a68b4aa318dc7a2546e2eca6f2806a894ba39
				;;
			*)
				echo "No checksum-pinned Nixpacks artifact is available for architecture $SYS_ARCH." >&2
				exit 45
				;;
		esac
		NZ_NIXPACKS_ASSET="nixpacks-v$NZ_EXPECTED_NIXPACKS_VERSION-$NZ_NIXPACKS_TARGET.tar.gz"
		NZ_NIXPACKS_TMP_DIR=$(mktemp -d)
		if ! nz_download_verified_artifact \\
			"https://github.com/railwayapp/nixpacks/releases/download/v$NZ_EXPECTED_NIXPACKS_VERSION/$NZ_NIXPACKS_ASSET" \\
			"$NZ_NIXPACKS_SHA256" "$NZ_NIXPACKS_TMP_DIR/$NZ_NIXPACKS_ASSET" ||
			! tar -xzf "$NZ_NIXPACKS_TMP_DIR/$NZ_NIXPACKS_ASSET" -C "$NZ_NIXPACKS_TMP_DIR" nixpacks ||
			! $SUDO_CMD install -m 0755 "$NZ_NIXPACKS_TMP_DIR/nixpacks" /usr/local/bin/nixpacks; then
			rm -rf "$NZ_NIXPACKS_TMP_DIR"
			echo "Nixpacks $NZ_EXPECTED_NIXPACKS_VERSION could not be installed from a verified artifact." >&2
			exit 45
		fi
		rm -rf "$NZ_NIXPACKS_TMP_DIR"
	fi
	NZ_CURRENT_NIXPACKS_VERSION="$(${readVersion("nixpacks")})"
	if [ "$NZ_CURRENT_NIXPACKS_VERSION" != "$NZ_EXPECTED_NIXPACKS_VERSION" ]; then
		echo "Nixpacks $NZ_EXPECTED_NIXPACKS_VERSION could not be installed." >&2
		exit 45
	fi
	echo "Nixpacks version $NZ_CURRENT_NIXPACKS_VERSION installed ✅"
`;

export const installPinnedRailpack = () => `
	NZ_EXPECTED_RAILPACK_VERSION="${RAILPACK_VERSION}"
	NZ_CURRENT_RAILPACK_VERSION="$(${readVersion("railpack")})"
	if [ "$NZ_CURRENT_RAILPACK_VERSION" != "$NZ_EXPECTED_RAILPACK_VERSION" ]; then
		${verifiedArtifactPrelude()}
		case "$SYS_ARCH" in
			x86_64 | amd64)
				NZ_RAILPACK_TARGET=x86_64-unknown-linux-musl
				NZ_RAILPACK_SHA256=459d86f5a9d8698bee8c7be4f224a305f51158fe5f44eb528255dfd568e4eaf1
				;;
			aarch64 | arm64)
				NZ_RAILPACK_TARGET=arm64-unknown-linux-musl
				NZ_RAILPACK_SHA256=035856398a88894a7e57dbea44e8c88aacca33a86900d3b8c7750216b424806f
				;;
			*)
				echo "No checksum-pinned Railpack artifact is available for architecture $SYS_ARCH." >&2
				exit 46
				;;
		esac
		NZ_RAILPACK_ASSET="railpack-v$NZ_EXPECTED_RAILPACK_VERSION-$NZ_RAILPACK_TARGET.tar.gz"
		NZ_RAILPACK_TMP_DIR=$(mktemp -d)
		if ! nz_download_verified_artifact \\
			"https://github.com/railwayapp/railpack/releases/download/v$NZ_EXPECTED_RAILPACK_VERSION/$NZ_RAILPACK_ASSET" \\
			"$NZ_RAILPACK_SHA256" "$NZ_RAILPACK_TMP_DIR/$NZ_RAILPACK_ASSET" ||
			! tar -xzf "$NZ_RAILPACK_TMP_DIR/$NZ_RAILPACK_ASSET" -C "$NZ_RAILPACK_TMP_DIR" railpack ||
			! $SUDO_CMD install -m 0755 "$NZ_RAILPACK_TMP_DIR/railpack" /usr/local/bin/railpack; then
			rm -rf "$NZ_RAILPACK_TMP_DIR"
			echo "Railpack $NZ_EXPECTED_RAILPACK_VERSION could not be installed from a verified artifact." >&2
			exit 46
		fi
		rm -rf "$NZ_RAILPACK_TMP_DIR"
	fi
	NZ_CURRENT_RAILPACK_VERSION="$(${readVersion("railpack")})"
	if [ "$NZ_CURRENT_RAILPACK_VERSION" != "$NZ_EXPECTED_RAILPACK_VERSION" ]; then
		echo "Railpack $NZ_EXPECTED_RAILPACK_VERSION could not be installed." >&2
		exit 46
	fi
	echo "Railpack version $NZ_CURRENT_RAILPACK_VERSION installed ✅"
`;

export const installPinnedBuildpacks = () => `
	NZ_EXPECTED_BUILDPACKS_VERSION="${BUILDPACKS_VERSION}"
	NZ_CURRENT_BUILDPACKS_VERSION="$(${readVersion("pack")})"
	if [ "$NZ_CURRENT_BUILDPACKS_VERSION" != "$NZ_EXPECTED_BUILDPACKS_VERSION" ]; then
		${verifiedArtifactPrelude()}
		case "$SYS_ARCH" in
			x86_64 | amd64)
				NZ_BUILDPACKS_ASSET="pack-v$NZ_EXPECTED_BUILDPACKS_VERSION-linux.tgz"
				NZ_BUILDPACKS_SHA256=77109791ec8ad73749bc9efc5ecd3905f49175a5071c50e4be59840041ee4b42
				;;
			aarch64 | arm64)
				NZ_BUILDPACKS_ASSET="pack-v$NZ_EXPECTED_BUILDPACKS_VERSION-linux-arm64.tgz"
				NZ_BUILDPACKS_SHA256=6ffe978d5fe59ecc17ed685f51da35b7d6a003aeaa3676e831e7aeeb0ddd09c8
				;;
			*)
				echo "No checksum-pinned Buildpacks artifact is available for architecture $SYS_ARCH." >&2
				exit 47
				;;
		esac
		NZ_BUILDPACKS_TMP_DIR=$(mktemp -d)
		if ! nz_download_verified_artifact \\
			"https://github.com/buildpacks/pack/releases/download/v$NZ_EXPECTED_BUILDPACKS_VERSION/$NZ_BUILDPACKS_ASSET" \\
			"$NZ_BUILDPACKS_SHA256" "$NZ_BUILDPACKS_TMP_DIR/$NZ_BUILDPACKS_ASSET" ||
			! tar -xzf "$NZ_BUILDPACKS_TMP_DIR/$NZ_BUILDPACKS_ASSET" -C "$NZ_BUILDPACKS_TMP_DIR" pack ||
			! $SUDO_CMD install -m 0755 "$NZ_BUILDPACKS_TMP_DIR/pack" /usr/local/bin/pack; then
			rm -rf "$NZ_BUILDPACKS_TMP_DIR"
			echo "Buildpacks $NZ_EXPECTED_BUILDPACKS_VERSION could not be installed from a verified artifact." >&2
			exit 47
		fi
		rm -rf "$NZ_BUILDPACKS_TMP_DIR"
	fi
	NZ_CURRENT_BUILDPACKS_VERSION="$(${readVersion("pack")})"
	if [ "$NZ_CURRENT_BUILDPACKS_VERSION" != "$NZ_EXPECTED_BUILDPACKS_VERSION" ]; then
		echo "Buildpacks $NZ_EXPECTED_BUILDPACKS_VERSION could not be installed." >&2
		exit 47
	fi
	echo "Buildpacks version $NZ_CURRENT_BUILDPACKS_VERSION installed ✅"
`;
