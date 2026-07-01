export const NIXPACKS_VERSION = "1.41.0";
export const RAILPACK_VERSION = "0.15.4";
export const BUILDPACKS_VERSION = "0.39.1";
export const COREPACK_VERSION = "0.31.0";

const readVersion = (command: string) =>
	`${command} --version 2>/dev/null | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+' | head -n 1 || true`;

export const installPinnedNixpacks = () => `
	NZ_EXPECTED_NIXPACKS_VERSION="${NIXPACKS_VERSION}"
	NZ_CURRENT_NIXPACKS_VERSION="$(${readVersion("nixpacks")})"
	if [ "$NZ_CURRENT_NIXPACKS_VERSION" != "$NZ_EXPECTED_NIXPACKS_VERSION" ]; then
		echo "Installing Nixpacks $NZ_EXPECTED_NIXPACKS_VERSION..."
		$SUDO_CMD env NIXPACKS_VERSION="$NZ_EXPECTED_NIXPACKS_VERSION" bash -c "$(curl -fsSL https://nixpacks.com/install.sh)"
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
		echo "Installing Railpack $NZ_EXPECTED_RAILPACK_VERSION..."
		$SUDO_CMD env RAILPACK_VERSION="$NZ_EXPECTED_RAILPACK_VERSION" bash -c "$(curl -fsSL https://railpack.com/install.sh)"
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
		NZ_BUILDPACKS_SUFFIX=""
		if [ "$SYS_ARCH" = "aarch64" ] || [ "$SYS_ARCH" = "arm64" ]; then
			NZ_BUILDPACKS_SUFFIX="-arm64"
		fi
		NZ_BUILDPACKS_ARCHIVE="$(mktemp)"
		curl -fsSL "https://github.com/buildpacks/pack/releases/download/v$NZ_EXPECTED_BUILDPACKS_VERSION/pack-v$NZ_EXPECTED_BUILDPACKS_VERSION-linux$NZ_BUILDPACKS_SUFFIX.tgz" -o "$NZ_BUILDPACKS_ARCHIVE"
		$SUDO_CMD tar -C /usr/local/bin/ --no-same-owner -xzf "$NZ_BUILDPACKS_ARCHIVE" pack
		rm -f "$NZ_BUILDPACKS_ARCHIVE"
	fi
	NZ_CURRENT_BUILDPACKS_VERSION="$(${readVersion("pack")})"
	if [ "$NZ_CURRENT_BUILDPACKS_VERSION" != "$NZ_EXPECTED_BUILDPACKS_VERSION" ]; then
		echo "Buildpacks $NZ_EXPECTED_BUILDPACKS_VERSION could not be installed." >&2
		exit 47
	fi
	echo "Buildpacks version $NZ_CURRENT_BUILDPACKS_VERSION installed ✅"
`;
