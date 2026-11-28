# syntax=docker/dockerfile:1
#
# The Nearzero production image: the control plane (API, jobs) and the console in one container,
# started by a small supervisor (container/supervise.ts), and the host's runner, which compose.yml
# starts from the same image with its own entry point. Spec 03 3.1, 23.3, 25 D1, D5.
#
#   docker build --platform linux/arm64 -t nz1-nearzero:dev .
#
# Both apps are bundled by their builds (Bun for the control plane, Astro for the console), so the
# final stage carries no node_modules at all: no dev dependencies and no sharp/libvips. It also
# carries the compiled runners server setup installs on other servers (/app/runner-binaries).

ARG BUN_VERSION=1.3.10

# ---------------------------------------------------------------------------------------------
# Only the package manifests, so the dependency install below is cached until one changes.
FROM oven/bun:${BUN_VERSION}-alpine AS manifests
WORKDIR /src
COPY . .
RUN find . -type f ! -name package.json ! -name bun.lock -delete \
 && find . -depth -type d -empty -delete

# ---------------------------------------------------------------------------------------------
# The workspace's dependencies, shared by the stages below.
FROM oven/bun:${BUN_VERSION}-alpine AS deps
WORKDIR /src
COPY --from=manifests /src ./
RUN bun install --frozen-lockfile --ignore-scripts

# ---------------------------------------------------------------------------------------------
# The compiled runner server setup installs on every server (spec 09 9.3 step 6, 25 D1, D5):
# linux x64 and arm64, glibc and musl, from runner/scripts/build.ts, with SHA256SUMS of the
# binaries. Every image carries all four, whatever its own architecture, since one control plane
# sets up servers of any kind. They are kept gzip-compressed (about 37 MB each instead of 100);
# server setup decompresses one and checks it against SHA256SUMS before sending it.
#
# This stage runs on a glibc (Debian) Bun: on an Alpine one, Bun compiles the glibc targets
# against musl, and the build script refuses binaries whose C library isn't the target's. Only
# the runner's source and the shared package go in, so it is rebuilt only when they change, in
# parallel with the build below; Bun's downloads (packages and each target) are cached.
FROM oven/bun:${BUN_VERSION}-slim AS runner-binaries
WORKDIR /src
COPY --from=manifests /src ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --ignore-scripts
COPY packages/shared ./packages/shared
COPY runner ./runner
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun runner/scripts/build.ts \
 && mkdir -p /out/runner-binaries \
 && cd runner/dist \
 && sha256sum -c SHA256SUMS \
 && for file in nearzero-runner-linux-*; do gzip -9 -n -c "$file" > "/out/runner-binaries/$file.gz"; done \
 && cp SHA256SUMS /out/runner-binaries/SHA256SUMS

# ---------------------------------------------------------------------------------------------
FROM deps AS build
WORKDIR /src
ENV ASTRO_TELEMETRY_DISABLED=1
# The builder tools the host's runner builds apps with (spec 6.4), pinned with checksums in
# runner/tools/pins.ts; server setup installs the same files on every server. Before the full
# source, so the download is cached until the pins change.
COPY runner/tools ./runner/tools
ARG TARGETARCH
RUN bun runner/tools/install.ts --arch "${TARGETARCH:-amd64}" --dest /out/builders
COPY . .
# The control plane's account commands (create-owner, reset-password, reset-2fa) become cli.js
# when the control build doesn't emit one itself. Install scripts don't run here, so optional
# native add-ons aren't built: cpu-features (an optional speed-up the SSH client loads inside a
# try) stays outside the bundle, and the SSH client uses its JavaScript code instead.
RUN bun run --cwd apps/control build --external cpu-features \
 && if [ ! -f apps/control/dist/cli.js ] && [ -f apps/control/src/cli.ts ]; then \
      bun build apps/control/src/cli.ts --target=bun --outdir=apps/control/dist; \
    fi \
 && bun run --cwd apps/console build \
 && bun build container/supervise.ts container/healthcheck.ts --target=bun --outdir=/out/app/bin \
 && bun build runner/src/main.ts --target=bun --outdir=/out/app/runner
# Lay out exactly what runs; nothing else from the source tree reaches the final image.
RUN mkdir -p /out/app/control /out/app/console \
 && cp apps/control/dist/*.js /out/app/control/ \
 && cp -R apps/control/migrations /out/app/migrations \
 && cp -R apps/console/dist/server apps/console/dist/client /out/app/console/ \
 && install -m 0755 container/nearzero-control /out/nearzero-control

# ---------------------------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-alpine AS runtime

ARG VERSION=1.0.0-dev
ARG REVISION=unknown
ARG SOURCE=https://github.com/Nearzero-systems/nearzero

LABEL org.opencontainers.image.title="Nearzero" \
      org.opencontainers.image.description="Nearzero control plane and console" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.source="${SOURCE}" \
      org.opencontainers.image.licenses="Apache-2.0" \
      dev.nearzero.managed="true" \
      dev.nearzero.component="control"

# A dedicated unprivileged account; the app files stay owned by root and read-only to it.
# The same image runs the Nearzero host's runner (compose.yml), which drives Docker Compose and
# BuildKit through the Docker CLI. The handoff folder is where the control plane leaves the host
# runner's one-time join token, and the runner link's folder keeps its certificate and key; a
# volume mounted on either starts with this owner and mode.
RUN addgroup -S -g 10001 nearzero \
 && adduser -S -D -H -u 10001 -G nearzero -h /nonexistent -s /sbin/nologin nearzero \
 && apk add --no-cache docker-cli docker-cli-compose docker-cli-buildx git openssh-client \
 && install -d -o 10001 -g 10001 -m 0750 /var/lib/nearzero/handoff \
 && install -d -o 10001 -g 10001 -m 0700 /var/lib/nearzero/runner-link \
 && rm -rf /root/.bun/install/cache

WORKDIR /app
COPY --from=build /out/app /app
COPY --from=build /out/nearzero-control /usr/local/bin/nearzero-control
COPY --from=build /out/builders /usr/local/lib/nearzero/builders
COPY --from=runner-binaries /out/runner-binaries /app/runner-binaries

ENV NEARZERO_ENV=production \
    NODE_ENV=production \
    NEARZERO_APP_DIR=/app \
    NEARZERO_BUILDERS_DIR=/usr/local/lib/nearzero/builders \
    PATH=/usr/local/lib/nearzero/builders/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

USER nearzero:nearzero
EXPOSE 3000 3443 4321

HEALTHCHECK --interval=10s --timeout=6s --start-period=60s --retries=3 \
  CMD ["bun", "--no-install", "/app/bin/healthcheck.js"]

# --no-install: everything is bundled, so Bun never fetches or writes packages at run time.
ENTRYPOINT ["bun", "--no-install", "/app/bin/supervise.js"]
