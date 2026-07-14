# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89
FROM docker:28.5.2-cli@sha256:625d9431a9f54c5a2bc90f24f0e1c3d55b1349fd857dd85035f98c2c9acbdd4d AS docker-cli

FROM oven/bun:1.3.10@sha256:b86c67b531d87b4db11470d9b2bd0c519b1976eee6fcd71634e73abfa6230d2e AS base
WORKDIR /usr/src/app

FROM base AS build

# Install from manifests first so application source changes do not invalidate
# the expensive, architecture-specific dependency layer.
COPY package.json bun.lock ./
COPY apps/console/package.json ./apps/console/package.json
COPY apps/platform/package.json ./apps/platform/package.json
COPY apps/schedules/package.json ./apps/schedules/package.json
COPY packages/agent/package.json ./packages/agent/package.json
COPY packages/edition-community/package.json ./packages/edition-community/package.json
COPY packages/edition-contract/package.json ./packages/edition-contract/package.json
COPY packages/server/package.json ./packages/server/package.json
COPY packages/trpc-openapi/package.json ./packages/trpc-openapi/package.json

RUN apt-get update && apt-get install -y python3 make g++ git python3-pip pkg-config libsecret-1-dev curl node-gyp && rm -rf /var/lib/apt/lists/*

RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --ignore-scripts && (bun pm trust esbuild tsx node-pty || true)

COPY . /usr/src/app

RUN for dir in node_modules/.bun/node-pty@*/node_modules/node-pty; do \
      [ -d "$dir" ] || continue; \
      (cd "$dir" && (node scripts/prebuild.js || node-gyp rebuild) && node scripts/post-install.js); \
    done
RUN set -eu; found=0; for dir in node_modules/.bun/bcrypt@*/node_modules/bcrypt; do \
      [ -d "$dir" ] || continue; \
      (cd "$dir" && npm_config_build_from_source=true npm_config_nodedir=/usr/include/nodejs ../.bin/node-pre-gyp install --build-from-source); \
      test -s "$dir/lib/binding/napi-v3/bcrypt_lib.node"; \
      found=1; \
    done; \
    test "$found" -eq 1

ENV NODE_ENV=production
RUN bun run --filter @nearzero/server build
RUN bun run --filter @nearzero/platform build
# The hosted-console production env points to api.nearzero.dev. The combined
# self-hosted image must proxy server-side console API requests to its local
# platform process instead.
RUN BACKEND_URL=http://platform:3000 bun run --filter @nearzero/console build:docker

FROM base AS nearzero
WORKDIR /app
ENV NODE_ENV=production
ENV NODE_PATH=/app/apps/platform/node_modules:/app/apps/console/node_modules:/app/packages/server/node_modules:/app/packages/agent/node_modules:/app/packages/trpc-openapi/node_modules

RUN apt-get update && apt-get install -y nodejs curl unzip zip apache2-utils iproute2 rsync git-lfs && git lfs install && rm -rf /var/lib/apt/lists/*

COPY --from=build /usr/src/app/apps/platform/dist ./dist
COPY --from=build /usr/src/app/apps/platform/drizzle ./drizzle
COPY --from=build /usr/src/app/apps/platform/public ./public
COPY --from=build /usr/src/app/apps/platform/package.json ./package.json
COPY --from=build /usr/src/app/apps/console/dist ./console-dist
COPY --from=build /usr/src/app/node_modules ./node_modules
COPY --from=build /usr/src/app/apps/platform/node_modules ./apps/platform/node_modules
COPY --from=build /usr/src/app/apps/console/node_modules ./apps/console/node_modules
COPY --from=build /usr/src/app/packages/server ./packages/server
COPY --from=build /usr/src/app/packages/agent ./packages/agent
COPY --from=build /usr/src/app/packages/trpc-openapi ./packages/trpc-openapi
COPY docker/entrypoint.sh ./entrypoint.sh
COPY scripts/install-verified-build-tools.sh /tmp/install-verified-build-tools.sh
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins
RUN chmod +x ./entrypoint.sh

RUN set -eu; \
    for modules in \
      /app/apps/platform/node_modules \
      /app/apps/console/node_modules \
      /app/packages/server/node_modules \
      /app/packages/agent/node_modules \
      /app/packages/trpc-openapi/node_modules; do \
      [ -d "$modules" ] || continue; \
      for entry in "$modules"/*; do \
        [ -e "$entry" ] || continue; \
        name="$(basename "$entry")"; \
        case "$name" in \
          .*) continue ;; \
          @*) \
            mkdir -p "/app/node_modules/$name"; \
            for scoped in "$entry"/*; do \
              [ -e "$scoped" ] || continue; \
              ln -sfn "$(readlink -f "$scoped")" "/app/node_modules/$name/$(basename "$scoped")"; \
            done; \
            ;; \
          *) \
            ln -sfn "$(readlink -f "$entry")" "/app/node_modules/$name"; \
            ;; \
        esac; \
      done; \
    done

RUN chmod +x /tmp/install-verified-build-tools.sh && \
    /tmp/install-verified-build-tools.sh nixpacks railpack buildpacks rclone && \
    rm -f /tmp/install-verified-build-tools.sh && \
    docker --version && docker buildx version && docker compose version

EXPOSE 3000 4321

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=5 \
  CMD curl -fs http://localhost:3000/api/health || exit 1

LABEL org.opencontainers.image.source="https://github.com/Nearzero-systems/nearzero" \
      org.opencontainers.image.licenses="Apache-2.0"

ENTRYPOINT ["./entrypoint.sh"]
