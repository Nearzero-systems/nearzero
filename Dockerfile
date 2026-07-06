# syntax=docker/dockerfile:1
FROM oven/bun:1.3.10 AS base
WORKDIR /usr/src/app

FROM base AS build
COPY . /usr/src/app

RUN apt-get update && apt-get install -y python3 make g++ git python3-pip pkg-config libsecret-1-dev curl node-gyp && rm -rf /var/lib/apt/lists/*

RUN bun install --frozen-lockfile --ignore-scripts && (bun pm trust esbuild tsx node-pty || true)
RUN for dir in node_modules/.bun/node-pty@*/node_modules/node-pty; do \
      [ -d "$dir" ] || continue; \
      (cd "$dir" && (node scripts/prebuild.js || node-gyp rebuild) && node scripts/post-install.js); \
    done

ENV NODE_ENV=production
RUN bun run --filter @nearzero/server build
RUN bun run --filter @nearzero/platform build
RUN bun run --filter @nearzero/console build:docker

FROM base AS nearzero
WORKDIR /app
ENV NODE_ENV=production
ENV NODE_PATH=/app/apps/platform/node_modules:/app/apps/console/node_modules:/app/packages/server/node_modules:/app/packages/agent/node_modules:/app/packages/trpc-openapi/node_modules

RUN apt-get update && apt-get install -y curl unzip zip apache2-utils iproute2 rsync git-lfs && git lfs install && rm -rf /var/lib/apt/lists/*

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

RUN curl -fsSL https://get.docker.com -o get-docker.sh && sh get-docker.sh --version 28.5.2 && rm get-docker.sh && curl https://rclone.org/install.sh | bash

ARG NIXPACKS_VERSION=1.41.0
RUN curl -sSL https://nixpacks.com/install.sh -o install.sh && chmod +x install.sh && ./install.sh

ARG RAILPACK_VERSION=0.15.4
RUN curl -sSL https://railpack.com/install.sh | bash

EXPOSE 3000 4321

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=5 \
  CMD curl -fs http://localhost:3000/api/health || exit 1

ENTRYPOINT ["./entrypoint.sh"]
