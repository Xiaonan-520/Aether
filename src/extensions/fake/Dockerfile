# gateway-extension-fake — Phase 2 test extension image
#
# The Fake (echo) Extension packaged as a real container image for Docker
# hosts. Built/Pushed like any gateway-extension-* repo (Phase 3+); Phase 2
# uses it only via `docker build` + the manager's DockerRuntimeBackend.
#
#   docker build -f src/extensions/fake/Dockerfile -t local/gateway-extension-fake:1.0.0 .
#
# The manager refuses "latest" as an install target — always tag semver.

FROM node:22-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm ci --include=optional && npm run build

FROM node:22-slim AS runtime
LABEL org.opencontainers.image.title="gateway-extension-fake"
LABEL org.opencontainers.image.description="Phase 2 echo test extension (not a real provider)"
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
ENTRYPOINT ["node", "--import", "tsx", "-e", "import { run } from './dist/extensions/fake/main.js'; await run(Number(process.env.PORT || 8080), process.env)"]
