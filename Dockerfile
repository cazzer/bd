# syntax=docker/dockerfile:1
#
# The `breakdown` app image (tailnet-hosting decision 6): one container that
# migrates, then runs the web server (serving the built client) and the MCP
# HTTP server as two children of bin/container-launch.mjs. Configured only by
# env on the container (see that file); it carries no credential.
#
# deps and build run on the build platform: their output is JavaScript,
# SQL, and static files, the same for every target, so a multi-arch build
# compiles once and only the runtime stage differs per platform. The runtime
# stage holds no node_modules: the servers are bundled with every dependency
# (pg included) by `pnpm bundle`.
#
#   docker buildx build --platform linux/arm64,linux/amd64 -t breakdown .

FROM --platform=$BUILDPLATFORM node:22.23.5-bookworm-slim AS deps
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/mcp/package.json apps/mcp/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
RUN --mount=type=cache,id=breakdown-pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --store-dir /pnpm-store

FROM deps AS build
COPY . .
RUN pnpm --filter @breakdown/web build \
 && pnpm bundle \
 && mkdir /empty-media

FROM node:22.23.5-bookworm-slim
WORKDIR /app
# Root-owned and not writable by the `node` user; only the media volume is.
COPY --from=build /build/dist/ /app/dist/
COPY --from=build /build/apps/web/dist/ /app/client/
# migrate.mjs resolves its folder as ../migrations from /app/dist.
COPY --from=build /build/packages/db/migrations/ /app/migrations/
COPY --from=build /build/bin/container-launch.mjs /build/bin/container-launch-lib.mjs /build/bin/container-healthcheck.mjs /app/bin/
COPY --from=build --chown=node:node /empty-media /data/media
USER node
EXPOSE 4310 5320
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=2s --retries=3 \
  CMD ["node", "/app/bin/container-healthcheck.mjs"]
ENTRYPOINT ["node", "/app/bin/container-launch.mjs"]
