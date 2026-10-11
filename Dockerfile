# Multi-Provider AI Gateway — multi-stage build
# Build stage compiles TS and rebuilds the native SQLite driver for the
# runtime's Node ABI; runtime stage ships dist/ + production deps only.

FROM node:22-slim AS build
WORKDIR /build
# better-sqlite3 needs build tools when no prebuilt binary matches
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --include=optional
COPY tsconfig.json ./
COPY src ./src
# scripts/ holds build-time helpers (asset copy; the Qoder WASM is optional)
COPY scripts ./scripts
RUN npm run build
# prune to production deps for the runtime image
RUN npm prune --omit=dev
# console web build (served by the gateway under /console). Separate npm ci
# so console dependency churn does not invalidate the core build layers.
COPY console/package.json console/package-lock.json ./console/
RUN npm ci --prefix console
COPY console ./console
RUN npm run build --prefix console

FROM node:22-slim AS runtime
# OCI labels: the source label lets GHCR link the package to this repository
# so the package page and its access settings follow the repo.
LABEL org.opencontainers.image.source="https://github.com/Xiaonan-520/multi-provider-ai-gateway"
LABEL org.opencontainers.image.title="multi-provider-ai-gateway"
LABEL org.opencontainers.image.description="Self-hosted, multi-provider, OpenAI-compatible AI gateway"
LABEL org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd -r gateway && useradd -r -g gateway gateway
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist
# static console SPA; the gateway serves it at /console when present
COPY --from=build /build/dist-console ./dist-console
COPY package.json ./
# data volume ownership (SQLite db + secrets live here)
RUN mkdir -p /data && chown gateway:gateway /data
USER gateway
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["node", "dist/http/index.js"]
