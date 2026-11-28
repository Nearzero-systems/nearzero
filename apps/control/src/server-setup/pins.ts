import type { Architecture } from "./parse.ts";

/**
 * Downloads setup makes on servers, pinned to exact releases with their published SHA-256 sums
 * (spec 09 9.3 steps 4 and 5). A sum that doesn't match stops the step before anything is
 * installed. The builder tools are pinned in runner/tools/pins.ts, which the image uses too.
 */

export interface PinnedFile {
  url: string;
  sha256: string;
}

export interface PinnedTool {
  name: string;
  version: string;
  assets: Record<Architecture, PinnedFile>;
}

/** rclone, the same release the backup helper image uses (rclone/rclone:1.71.2). */
export const RCLONE: PinnedTool = {
  name: "rclone",
  version: "1.71.2",
  assets: {
    amd64: {
      url: "https://downloads.rclone.org/v1.71.2/rclone-v1.71.2-linux-amd64.zip",
      sha256: "ab9fa5877cee91c64fdfd61a27028a458cf618b39259e5c371dc2ec34a12e415",
    },
    arm64: {
      url: "https://downloads.rclone.org/v1.71.2/rclone-v1.71.2-linux-arm64.zip",
      sha256: "e2e2efc7ed143026352d60216ef0d46d3fa4fe9d647eff1bd929e6fea498e6f1",
    },
  },
};

/**
 * The Docker Compose and buildx CLI plugins, for systems whose packages don't carry them
 * (Amazon Linux, and older SUSE and Arch packages). Elsewhere the distribution's packages are
 * used.
 */
export const COMPOSE_PLUGIN: PinnedTool = {
  name: "docker-compose",
  version: "5.7.0",
  assets: {
    amd64: {
      url: "https://github.com/docker/compose/releases/download/v5.7.0/docker-compose-linux-x86_64",
      sha256: "7758048ad38e580f22559603312874fec8bb638d021a9e64182385fc17cc12a2",
    },
    arm64: {
      url: "https://github.com/docker/compose/releases/download/v5.7.0/docker-compose-linux-aarch64",
      sha256: "15861535d14e26555736b49376c95e14bfd94285366c8446bfac7156a972e76f",
    },
  },
};

export const BUILDX_PLUGIN: PinnedTool = {
  name: "docker-buildx",
  version: "0.38.1",
  assets: {
    amd64: {
      url: "https://github.com/docker/buildx/releases/download/v0.38.1/buildx-v0.38.1.linux-amd64",
      sha256: "e25d5cd675092bb5d1d03632fdc46cdf3fede7b514dc5f023a105e00d3ce5ad4",
    },
    arm64: {
      url: "https://github.com/docker/buildx/releases/download/v0.38.1/buildx-v0.38.1.linux-arm64",
      sha256: "3b83b3731916ba433feccaaa689fe5bcdc81c641d92c8e6c2ea865dfa141c97a",
    },
  },
};
