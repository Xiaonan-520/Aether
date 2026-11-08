# gateway-extension-zcode — standalone Gateway Extension container.
#
# The Extension Manager creates the actual container from the manifest
# (runtime.port 8080, healthPath /health, volume 'state' → /data, read-only
# rootfs, cap_drop ALL, no-new-privileges, no published ports). This Dockerfile
# only needs to produce an image compatible with that contract.
#
# Captcha modes (ZCODE_CAPTCHA_MODE): manual (default; human handoff page) |
# auto (happy-dom solver ported from TriDefender/zcode-api — ToS/licence risk
# carried by the deployer) | off. The solver needs NO extra system packages.
FROM node:22-slim AS builder
WORKDIR /app
ENV NPM_CONFIG_AUDIT=false NPM_CONFIG_FUND=false
# Native build toolchain for better-sqlite3 (node-gyp needs python3/make/g++).
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    LOG_LEVEL=info \
    ZCODE_CAPTCHA_MODE=manual \
    ZCODE_CAPTCHA_CPU_LIMIT_PCT=70
WORKDIR /app
# Non-root; /data is the declared named-volume mount point.
RUN groupadd -r -g 10001 zcode && useradd -r -u 10001 -g zcode zcode \
    && mkdir -p /data && chown -R zcode:zcode /data
COPY --from=builder --chown=zcode:zcode /app/node_modules ./node_modules
COPY --from=builder --chown=zcode:zcode /app/dist ./dist
COPY --chown=zcode:zcode package.json ./
USER 10001:10001
VOLUME ["/data"]
EXPOSE 8080
# Container-level healthcheck mirroring manifest.runtime.healthPath.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
