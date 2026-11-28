/**
 * The builder tools every build machine carries (spec 6.4, 25 D5), pinned to exact releases and
 * checked against their published SHA-256 sums. The production image installs them with
 * install.ts (see the Dockerfile), and server setup installs the very same files, so a build
 * behaves the same on the Nearzero host and on every server.
 *
 * Layout on a build machine: <builders dir>/<tool>/<version>/<binary>, with the default version
 * of each also on PATH. The runner looks there first (NEARZERO_BUILDERS_DIR, default
 * /usr/local/lib/nearzero/builders).
 */

export type Architecture = "amd64" | "arm64";

export interface ToolRelease {
  tool: "railpack" | "nixpacks" | "pack";
  version: string;
  /** The binary inside the archive. */
  binary: string;
  assets: Record<Architecture, { url: string; sha256: string }>;
}

export const DEFAULT_BUILDERS_DIR = "/usr/local/lib/nearzero/builders";

export const TOOL_RELEASES: readonly ToolRelease[] = [
  {
    tool: "railpack",
    version: "0.43.0",
    binary: "railpack",
    assets: {
      amd64: {
        url: "https://github.com/railwayapp/railpack/releases/download/v0.43.0/railpack-v0.43.0-x86_64-unknown-linux-musl.tar.gz",
        sha256: "248a8f60f36854aabed6124113631078a802de3461660855fc4de9c26065c1fb",
      },
      arm64: {
        url: "https://github.com/railwayapp/railpack/releases/download/v0.43.0/railpack-v0.43.0-arm64-unknown-linux-musl.tar.gz",
        sha256: "732ece14eb4f4676a43ebba19431f954edf7b130acb76159ef0f2ff86ac42ac9",
      },
    },
  },
  {
    tool: "railpack",
    version: "0.42.0",
    binary: "railpack",
    assets: {
      amd64: {
        url: "https://github.com/railwayapp/railpack/releases/download/v0.42.0/railpack-v0.42.0-x86_64-unknown-linux-musl.tar.gz",
        sha256: "81bca91d0577c7650378762609116d12d8630e2cfc1779e41d3ac3964fc7194b",
      },
      arm64: {
        url: "https://github.com/railwayapp/railpack/releases/download/v0.42.0/railpack-v0.42.0-arm64-unknown-linux-musl.tar.gz",
        sha256: "63c0417d6c0a437162fa2c688ddf58aabf9e4433eeffb69d8c3fb498603e2c3b",
      },
    },
  },
  {
    tool: "nixpacks",
    version: "1.41.0",
    binary: "nixpacks",
    assets: {
      amd64: {
        url: "https://github.com/railwayapp/nixpacks/releases/download/v1.41.0/nixpacks-v1.41.0-x86_64-unknown-linux-musl.tar.gz",
        sha256: "0f55de7874507b9cf7502113120bd96f2ab6979f78d10eaf2eb2ade9207b3af6",
      },
      arm64: {
        url: "https://github.com/railwayapp/nixpacks/releases/download/v1.41.0/nixpacks-v1.41.0-aarch64-unknown-linux-musl.tar.gz",
        sha256: "912bd02dd2bb6f9c3a9ed965fe8a68b4aa318dc7a2546e2eca6f2806a894ba39",
      },
    },
  },
  {
    tool: "pack",
    version: "0.40.10",
    binary: "pack",
    assets: {
      amd64: {
        url: "https://github.com/buildpacks/pack/releases/download/v0.40.10/pack-v0.40.10-linux.tgz",
        sha256: "687c3616e21824a449b56d4f989613ca68c921c6cce670b4de4459b025233806",
      },
      arm64: {
        url: "https://github.com/buildpacks/pack/releases/download/v0.40.10/pack-v0.40.10-linux-arm64.tgz",
        sha256: "9a294abb0576fd95e19a009b3f9d5f5aa9fecdc2d7da7fa05e7e1e94f5085d77",
      },
    },
  },
];

/** The version of each tool that is also on PATH: the first listed. */
export function defaultRelease(tool: ToolRelease["tool"]): ToolRelease {
  const release = TOOL_RELEASES.find((item) => item.tool === tool);
  if (!release) throw new Error(`No pinned release of ${tool}.`);
  return release;
}

/**
 * Images builds use, pinned. The Railpack frontend runs inside BuildKit and must match the
 * version that wrote the plan.
 */
export const RAILPACK_FRONTENDS: Record<string, string> = {
  "0.43.0":
    "ghcr.io/railwayapp/railpack-frontend:v0.43.0@sha256:355ef61fae6f2551103cd8b10c710cb07167dd353d561f15c69b8d7ac1c676cc",
  "0.42.0":
    "ghcr.io/railwayapp/railpack-frontend:v0.42.0@sha256:a42a12399fa9e83a09e475f69dbf8a45a8a74ea38a4485fcb401356d84317a14",
};

/**
 * BuildKit in its own container, for Railpack builds on Docker engines whose built-in builder
 * lacks merge operations (the classic image store; the containerd image store has them).
 */
export const BUILDKIT_IMAGE =
  "moby/buildkit:v0.34.1@sha256:99368f3e46177c6405b9740e4461d91cee004128daeecca78d4ceac50ec1da5c";
export const RAILPACK_BUILDER_NAME = "nearzero-railpack";
/** The BuildKit container, its cache volume, and Nearzero's labelled copy of the image. */
export const BUILDKIT_CONTAINER = "nearzero-buildkit";
export const BUILDKIT_VOLUME = "nearzero-buildkit-state";
export const BUILDKIT_OWN_TAG = "nearzero/buildkit:v0.34.1";
/** Which pinned image the container was made from; a new pin recreates it. */
export const BUILDKIT_PIN_LABEL = "dev.nearzero.builder-image";

/** The small static file server for the Static builder and Nixpacks publish folders. */
export const STATIC_SERVER_IMAGE = "nginx:1.30.6-alpine";
/** Where the Static builder runs Install and Build commands, when there are any. */
export const STATIC_BUILD_IMAGE = "node:24-alpine";

export const HEROKU_BUILDERS: Record<string, string> = {
  "24": "heroku/builder:24",
  "22": "heroku/builder:22",
};
/**
 * Paketo's full Jammy builder (30b R2-14): more languages than the base one (PHP among them) and
 * more system libraries.
 */
export const PAKETO_BUILDER = "paketobuildpacks/builder-jammy-full";
