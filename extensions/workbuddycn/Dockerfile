# gateway-extension-workbuddycn — standalone Gateway Extension container.
#
# The Extension Manager creates the actual container from the manifest
# (runtime.port 8080, healthPath /health, volume 'state' → /data, read-only
# rootfs, cap_drop ALL, no-new-privileges, no published ports). This Dockerfile
# only needs to produce an image compatible with that contract.
FROM node:22-slim AS builder
WORKDIR /app
ENV NPM_CONFIG_AUDIT=false NPM_CONFIG_FUND=false
# Native build toolchain for better-sqlite3 (node-gyp needs python3/make/g++).
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
COPY scripts ./scripts
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
# Build the native SQLite binding against this runtime.

FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    LOG_LEVEL=info
WORKDIR /app
# Non-root; /data is the declared named-volume mount point.
RUN groupadd -r -g 10001 wbcn && useradd -r -u 10001 -g wbcn wbcn \
    && mkdir -p /data && chown -R wbcn:wbcn /data
COPY --from=builder --chown=wbcn:wbcn /app/node_modules ./node_modules
COPY --from=builder --chown=wbcn:wbcn /app/dist ./dist
COPY --chown=wbcn:wbcn package.json ./
USER 10001:10001
VOLUME ["/data"]
EXPOSE 8080
# Container-level healthcheck mirroring manifest.runtime.healthPath.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
