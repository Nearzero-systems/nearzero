#!/bin/sh
set -eu

# Installs only immutable, checksum-pinned release artifacts. This helper is
# shared by the production image build and CI so neither path executes a
# downloaded installer script.

NIXPACKS_VERSION="1.41.0"
RAILPACK_VERSION="0.15.4"
BUILDPACKS_VERSION="0.39.1"
RCLONE_VERSION="1.74.2"
INSTALL_BIN_DIR="${INSTALL_BIN_DIR:-/usr/local/bin}"

die() {
	printf 'install-verified-build-tools: %s\n' "$*" >&2
	exit 1
}

for command_name in curl install mktemp sed sha256sum tar; do
	command -v "$command_name" >/dev/null 2>&1 || die "$command_name is required"
done

case "$(uname -m)" in
	x86_64 | amd64)
		NIXPACKS_TARGET="x86_64-unknown-linux-musl"
		NIXPACKS_SHA256="0f55de7874507b9cf7502113120bd96f2ab6979f78d10eaf2eb2ade9207b3af6"
		RAILPACK_TARGET="x86_64-unknown-linux-musl"
		RAILPACK_SHA256="459d86f5a9d8698bee8c7be4f224a305f51158fe5f44eb528255dfd568e4eaf1"
		BUILDPACKS_ASSET="pack-v${BUILDPACKS_VERSION}-linux.tgz"
		BUILDPACKS_SHA256="77109791ec8ad73749bc9efc5ecd3905f49175a5071c50e4be59840041ee4b42"
		RCLONE_ARCH="amd64"
		RCLONE_SHA256="72a806370072015ccbe4d81bcd348cc5eaf3beca6c65ba693fd43fb31fcca5b1"
		;;
	aarch64 | arm64)
		NIXPACKS_TARGET="aarch64-unknown-linux-musl"
		NIXPACKS_SHA256="912bd02dd2bb6f9c3a9ed965fe8a68b4aa318dc7a2546e2eca6f2806a894ba39"
		RAILPACK_TARGET="arm64-unknown-linux-musl"
		RAILPACK_SHA256="035856398a88894a7e57dbea44e8c88aacca33a86900d3b8c7750216b424806f"
		BUILDPACKS_ASSET="pack-v${BUILDPACKS_VERSION}-linux-arm64.tgz"
		BUILDPACKS_SHA256="6ffe978d5fe59ecc17ed685f51da35b7d6a003aeaa3676e831e7aeeb0ddd09c8"
		RCLONE_ARCH="arm64"
		RCLONE_SHA256="bc2b2eb8269b743ed7bcea869f3782cfb4931e41efa53fc8befc6dc8308b7a50"
		;;
	*)
		die "no checksum-pinned artifacts are available for architecture $(uname -m)"
		;;
esac

TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT HUP INT TERM

download_verified() {
	url="$1"
	expected_sha256="$2"
	destination="$3"

	case "$expected_sha256" in
		????????????????????????????????????????????????????????????????) ;;
		*) die "invalid SHA-256 digest for $url" ;;
	esac
	case "$expected_sha256" in
		*[!0-9a-f]*) die "invalid SHA-256 digest for $url" ;;
	esac

	rm -f "$destination"
	if ! curl --fail --location --show-error --silent \
		--proto '=https' --proto-redir '=https' --tlsv1.2 \
		--retry 3 --connect-timeout 20 --max-time 300 \
		--output "$destination" "$url"; then
		rm -f "$destination"
		die "download failed for $url"
	fi
	if ! printf '%s  %s\n' "$expected_sha256" "$destination" | sha256sum -c - >/dev/null; then
		rm -f "$destination"
		die "checksum verification failed for $url"
	fi
}

install_tar_binary() {
	name="$1"
	version="$2"
	asset="$3"
	sha256="$4"
	url="$5"
	archive="$TEMP_DIR/$asset"
	extract_dir="$TEMP_DIR/extract-$name"

	download_verified "$url" "$sha256" "$archive"
	mkdir -p "$extract_dir"
	tar -xzf "$archive" -C "$extract_dir" "$name"
	install -d -m 0755 "$INSTALL_BIN_DIR"
	install -m 0755 "$extract_dir/$name" "$INSTALL_BIN_DIR/$name"
	case "$("$INSTALL_BIN_DIR/$name" --version 2>&1 | sed -n '1p')" in
		*"$version"*) ;;
		*) die "$name did not report the expected version $version" ;;
	esac
}

install_nixpacks() {
	asset="nixpacks-v${NIXPACKS_VERSION}-${NIXPACKS_TARGET}.tar.gz"
	install_tar_binary nixpacks "$NIXPACKS_VERSION" "$asset" "$NIXPACKS_SHA256" \
		"https://github.com/railwayapp/nixpacks/releases/download/v${NIXPACKS_VERSION}/${asset}"
}

install_railpack() {
	asset="railpack-v${RAILPACK_VERSION}-${RAILPACK_TARGET}.tar.gz"
	install_tar_binary railpack "$RAILPACK_VERSION" "$asset" "$RAILPACK_SHA256" \
		"https://github.com/railwayapp/railpack/releases/download/v${RAILPACK_VERSION}/${asset}"
}

install_buildpacks() {
	install_tar_binary pack "$BUILDPACKS_VERSION" "$BUILDPACKS_ASSET" "$BUILDPACKS_SHA256" \
		"https://github.com/buildpacks/pack/releases/download/v${BUILDPACKS_VERSION}/${BUILDPACKS_ASSET}"
}

install_rclone() {
	command -v unzip >/dev/null 2>&1 || die "unzip is required to install rclone"
	asset="rclone-v${RCLONE_VERSION}-linux-${RCLONE_ARCH}.zip"
	archive="$TEMP_DIR/$asset"
	download_verified \
		"https://github.com/rclone/rclone/releases/download/v${RCLONE_VERSION}/${asset}" \
		"$RCLONE_SHA256" "$archive"
	unzip -q "$archive" -d "$TEMP_DIR/rclone"
	install -d -m 0755 "$INSTALL_BIN_DIR"
	install -m 0755 \
		"$TEMP_DIR/rclone/rclone-v${RCLONE_VERSION}-linux-${RCLONE_ARCH}/rclone" \
		"$INSTALL_BIN_DIR/rclone"
	case "$("$INSTALL_BIN_DIR/rclone" version 2>&1 | sed -n '1p')" in
		*"v$RCLONE_VERSION"*) ;;
		*) die "rclone did not report the expected version $RCLONE_VERSION" ;;
	esac
}

[ "$#" -gt 0 ] || die "specify at least one of: nixpacks railpack buildpacks rclone"
for tool_name in "$@"; do
	case "$tool_name" in
		nixpacks) install_nixpacks ;;
		railpack) install_railpack ;;
		buildpacks) install_buildpacks ;;
		rclone) install_rclone ;;
		*) die "unsupported tool: $tool_name" ;;
	esac
done
