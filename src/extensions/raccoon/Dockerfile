# gateway-extension-raccoon — Raccoon provider extension image.
#
# Packaged from the same repo as the gateway: only dist/extensions/raccoon
# plus the shared protocol/providers modules it imports are needed at runtime.
#
#   docker build -f src/extensions/raccoon/Dockerfile -t local/gateway-extension-raccoon:1.0.0 .
#
# The manager refuses "latest" as an install target — always tag semver.
# GATEWAY_EXTENSION_TOKEN / GATEWAY_EXTENSION_SECRET are injected by the
# Extension Manager at container creation — never baked into the image.

FROM node:22-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm ci --include=optional && npm run build

FROM node:22-slim AS runtime
LABEL org.opencontainers.image.title="gateway-extension-raccoon"
LABEL org.opencontainers.image.description="Raccoon (SenseNova) provider extension (Extension Protocol v1)"
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd -r gwext && useradd -r -g gwext gwext
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist
COPY package.json ./
RUN mkdir -p /data && chown gwext:gwext /data
USER gwext
VOLUME ["/data"]
EXPOSE 8080
# Extension Protocol v1 entrypoint. GATEWAY_EXTENSION_TOKEN is injected by
# the Extension Manager at container creation — never baked into the image.
ENTRYPOINT ["node", "--import", "tsx", "-e", "import { run } from './dist/extensions/raccoon/main.js'; await run(Number(process.env.PORT || 8080), process.env)"]
