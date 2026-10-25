#!/usr/bin/env bash
#
# Deploy one immutable Aether Core image by commit SHA.
#
# Why this exists: docker-compose.yml falls back to
# `${GATEWAY_IMAGE_TAG:-latest}`, so a bare `docker compose up -d` can silently
# run an old or moving image. This script refuses to guess: it requires a full
# 40-character commit, verifies the image's build revision label matches that
# commit, records the pre-deploy state, updates only the gateway service, waits
# for health, and rolls back automatically if the new container does not become
# healthy.
#
# It never rewrites .env or the compose files, never runs `compose down`, and
# never touches volumes or other services.
#
# Usage:
#   scripts/deploy-core.sh <full-40-char-commit-sha>
#   scripts/deploy-core.sh --rollback <full-40-char-commit-sha>
#   scripts/deploy-core.sh --dry-run <full-40-char-commit-sha>
#   scripts/deploy-core.sh --digest              # print the deployed image digest
#
# Environment overrides (optional):
#   AETHER_DIR          project directory (default: parent of this script)
#   GATEWAY_SERVICE     compose service name (default: gateway)
#   GATEWAY_CONTAINER   container name (default: ai-gateway)
#   GATEWAY_IMAGE_REPO  image repository (default: ghcr.io/xiaonan-520/aether)
#   HEALTH_TIMEOUT_S    seconds to wait for healthy (default: 180)
#
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
AETHER_DIR="${AETHER_DIR:-$(cd -- "$SCRIPT_DIR/.." && pwd)}"
GATEWAY_SERVICE="${GATEWAY_SERVICE:-gateway}"
GATEWAY_CONTAINER="${GATEWAY_CONTAINER:-ai-gateway}"
GATEWAY_IMAGE_REPO="${GATEWAY_IMAGE_REPO:-ghcr.io/xiaonan-520/aether}"
HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S:-180}"

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.extensions.yml)

MODE="deploy"
ACTION_LABEL="deploy"

usage() {
  sed -n '3,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

info() {
  printf '==> %s\n' "$*"
}

# --- argument parsing ------------------------------------------------------
case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
  --digest)
    MODE="digest"
    ;;
  --dry-run)
    MODE="dry-run"
    ACTION_LABEL="dry-run"
    shift
    ;;
  --rollback)
    MODE="deploy"
    ACTION_LABEL="rollback"
    shift
    ;;
  "")
    die "missing commit SHA — usage: $0 <full-40-char-commit-sha>"
    ;;
esac

COMMIT="${1:-}"

if [[ "$MODE" != "digest" ]]; then
  # A short SHA or a tag like "latest"/"main" is exactly what this script is
  # meant to prevent, so require the full commit id.
  if ! [[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
    die "commit must be a full 40-character lowercase hex SHA (got '${COMMIT:-}')"
  fi
  cd "$AETHER_DIR" || die "cannot cd to AETHER_DIR=$AETHER_DIR"
  for required in docker-compose.yml docker-compose.extensions.yml; do
    [[ -f "$required" ]] || die "missing $AETHER_DIR/$required"
  done
  command -v docker >/dev/null 2>&1 || die "docker is not installed"
  docker compose version >/dev/null 2>&1 || die "docker compose plugin is unavailable"
fi

IMAGE="${GATEWAY_IMAGE_REPO}:sha-${COMMIT}"

# --- helpers ---------------------------------------------------------------
container_field() {
  local field="$1"
  docker inspect "$GATEWAY_CONTAINER" --format "$field" 2>/dev/null || true
}

container_health() {
  container_field '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}'
}

print_digest() {
  local image_id repo_digests
  image_id="$(container_field '{{.Image}}')"
  repo_digests="$(container_field '{{join .Config.Image " "}}')"
  printf 'container=%s\n' "$GATEWAY_CONTAINER"
  printf 'image=%s\n' "$(container_field '{{.Config.Image}}')"
  printf 'image_id=%s\n' "$image_id"
  printf 'revision=%s\n' "$(container_field '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
  printf 'repo_digest=%s\n' "$(
    docker image inspect "$(container_field '{{.Config.Image}}')" \
      --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{else}}<none>{{end}}' 2>/dev/null || echo '<none>'
  )"
  printf 'started_at=%s\n' "$(container_field '{{.State.StartedAt}}')"
  printf 'health=%s\n' "$(container_health)"
  printf 'image_ref=%s\n' "$repo_digests"
}

verify_image_revision() {
  local expected="$1" revision
  docker image inspect "$IMAGE" >/dev/null 2>&1 || {
    printf 'error: image %s is not present locally\n' "$IMAGE" >&2
    printf 'hint: docker pull %s   (or load the exported image archive first)\n' "$IMAGE" >&2
    return 1
  }
  revision="$(docker image inspect "$IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || true)"
  if [[ -z "$revision" || "$revision" == "<no value>" ]]; then
    printf 'error: image %s has no org.opencontainers.image.revision label\n' "$IMAGE" >&2
    return 1
  fi
  if [[ "$revision" != "$expected" ]]; then
    printf 'error: image revision %s does not match requested commit %s\n' "$revision" "$expected" >&2
    return 1
  fi
  info "image revision verified: $revision"
}

wait_healthy() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT_S)) status
  while (( SECONDS < deadline )); do
    status="$(docker inspect "$GATEWAY_CONTAINER" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || echo missing)"
    case "$status" in
      healthy)
        info "container is healthy"
        return 0
        ;;
      unhealthy|exited|dead)
        printf 'error: container became %s\n' "$status" >&2
        return 1
        ;;
    esac
    sleep 3
  done
  printf 'error: container did not become healthy within %ss (last status: %s)\n' "$HEALTH_TIMEOUT_S" "${status:-unknown}" >&2
  return 1
}

wait_http_healthy() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT_S)) body
  while (( SECONDS < deadline )); do
    body="$(docker exec "$GATEWAY_CONTAINER" sh -lc 'curl -fsS --max-time 3 http://127.0.0.1:8080/healthz 2>/dev/null' || true)"
    if [[ "$body" == *'"ok":true'* ]]; then
      info "healthz ok"
      return 0
    fi
    sleep 3
  done
  printf 'error: /healthz did not report ok within %ss\n' "$HEALTH_TIMEOUT_S" >&2
  return 1
}

if [[ "$MODE" == "digest" ]]; then
  print_digest
  exit 0
fi

# --- preflight -------------------------------------------------------------
info "$ACTION_LABEL target: commit $COMMIT"
info "image: $IMAGE"

PREVIOUS_IMAGE="$(container_field '{{.Config.Image}}')"
PREVIOUS_HEALTH="$(container_health)"
PREVIOUS_STARTED="$(container_field '{{.State.StartedAt}}')"
PREVIOUS_REVISION="$(container_field '{{index .Config.Labels "org.opencontainers.image.revision"}}')"

[[ -n "$PREVIOUS_IMAGE" ]] || die "container $GATEWAY_CONTAINER not found; this script only updates an existing deployment"
[[ "$PREVIOUS_IMAGE" =~ ^.+:sha-[0-9a-f]{40}$ ]] || {
  die "current image '$PREVIOUS_IMAGE' is not pinned to a commit tag; fix that before using this script"
}

info "previous: image=$PREVIOUS_IMAGE revision=${PREVIOUS_REVISION:-unknown} health=$PREVIOUS_HEALTH started=$PREVIOUS_STARTED"

verify_image_revision "$COMMIT" || die "refusing to deploy an unverified image"

if [[ "$MODE" == "dry-run" ]]; then
  info "dry-run: docker compose ... up -d --no-deps --no-build $GATEWAY_SERVICE"
  info "dry-run: would wait for healthy and roll back to $PREVIOUS_IMAGE on failure"
  exit 0
fi

compose_config="$(GATEWAY_IMAGE_TAG="sha-$COMMIT" "${COMPOSE[@]}" config --images 2>/dev/null || true)"
[[ "$compose_config" == *"$IMAGE"* ]] || die "compose did not resolve the requested image (got: ${compose_config:-none})"
info "compose resolves $IMAGE"

# --- deploy + automatic rollback -------------------------------------------
deploy() {
  GATEWAY_IMAGE_TAG="sha-$COMMIT" "${COMPOSE[@]}" up -d --no-deps --no-build "$GATEWAY_SERVICE"
}

restore_previous() {
  local tag="${PREVIOUS_IMAGE##*:sha-}"
  printf 'error: deploy failed; rolling back to %s\n' "$PREVIOUS_IMAGE" >&2
  if ! docker image inspect "$PREVIOUS_IMAGE" >/dev/null 2>&1; then
    printf 'error: previous image %s is not present locally; manual rollback required\n' "$PREVIOUS_IMAGE" >&2
    return 1
  fi
  GATEWAY_IMAGE_TAG="sha-$tag" "${COMPOSE[@]}" up -d --no-deps --no-build "$GATEWAY_SERVICE" || {
    printf 'error: rollback command failed; manual intervention required\n' >&2
    return 1
  }
  if wait_healthy && wait_http_healthy; then
    printf 'rollback complete: %s is healthy again\n' "$PREVIOUS_IMAGE" >&2
    return 0
  fi
  printf 'error: rollback did not reach a healthy state; manual intervention required\n' >&2
  return 1
}

if ! deploy; then
  restore_previous || die "deploy and rollback both failed"
  die "deploy failed and was rolled back"
fi

if wait_healthy && wait_http_healthy; then
  info "deployed revision $COMMIT"
  if [[ "$PREVIOUS_IMAGE" != "$IMAGE" ]]; then
    info "rollback command: $0 --rollback ${PREVIOUS_IMAGE##*:sha-}"
  fi
  info "current image digest:"
  print_digest
  exit 0
fi

restore_previous || die "deploy became unhealthy and rollback failed"
die "deploy became unhealthy and was rolled back"
