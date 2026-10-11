# gateway-extension-codearts — CodeArts provider extension image.
#
#   docker build -f src/extensions/codearts/Dockerfile -t local/gateway-extension-codearts:1.0.0 .
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
LABEL org.opencontainers.image.title="gateway-extension-codearts"
LABEL org.opencontainers.image.description="CodeArts (Huawei Cloud) provider extension (Extension Protocol v1)"
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
ENTRYPOINT ["node", "--import", "tsx", "-e", "import { run } from './dist/extensions/codearts/main.js'; await run(Number(process.env.PORT || 8080), process.env)"]
