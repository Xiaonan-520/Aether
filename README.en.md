# Aether

English | [中文](README.md)

> **Aether** is the project's formal name (formerly Multi-Provider AI Gateway).
> See [docs/RENAME-AETHER.md](docs/RENAME-AETHER.md) for the repository and
> image migration notes.

Self-hosted, multi-provider, OpenAI-compatible AI gateway. It exposes a single
`/v1` endpoint to any OpenAI-compatible client and, behind it, manages a pool
of provider accounts: routing, token refresh, quota awareness, failover and
background maintenance jobs. Credentials are encrypted at rest and never
appear in API responses or logs.

> **Development model:** Vibe Coding / AI-assisted development — see
> [Development](#development) for what that means here.

```text
Client (any OpenAI-compatible tool)
  │  Authorization: Bearer <GATEWAY_API_KEY>
  ▼
OpenAI-compatible API  /v1/chat/completions · /v1/models   (SSE streaming)
  ▼
Model Router            provider::model explicit routing + priority fallback
  ▼
Provider Adapter        one module per provider; core has no provider branches
  ▼
Account Pool            status machine + failover + cooldown / rate-limit windows
  ▼
Provider API
```

Supporting services: a scheduler runs `token_refresh` / `quota_sync` /
`credit_claim` / `health_check` jobs per account; persistence is SQLite (WAL,
schema migrations) with an in-memory fallback; an admin API (`/api/*`) manages
accounts, logins and keys.

## Features

Implemented and covered by the test suite (400+ tests):

- OpenAI-compatible API — `/v1/chat/completions` (streaming via SSE and
  non-streaming) and `/v1/models`
- Multi-provider account pool with a status machine (`active`, `cooldown`,
  `rate_limited`, `quota_exhausted`, `needs_manual_action`, …)
- Automatic failover between accounts: auth errors trigger one in-place token
  refresh and retry, rate limits / quota exhaustion / transport errors switch
  accounts, terminal errors fail fast
- OAuth and token-refresh flows per provider; rotated refresh tokens are
  persisted before anything else
- Credential encryption at rest (AES-256-GCM, key derived from
  `GATEWAY_SECRET`)
- Quota synchronization and daily credit/check-in claims where a provider
  supports them
- Health checks and background jobs with bounded retries
- Manual CAPTCHA handoff for ZCode: the gateway detects the challenge, a human
  completes the official Aliyun widget, and the resulting token is submitted
  through the admin API. There is deliberately no automated solver.
- Gateway API keys for clients (hash-only storage, prefix lookup)
- SQLite persistence (WAL, sequential migrations) with an in-memory fallback
  when the native driver is unavailable
- Docker deployment; images are built and published to GHCR by CI

## Provider Support

14 providers are registered. "Login" below means the interactive flow an
operator completes once; after that the gateway manages the account.

| Provider     | Adapter | Login mode            | Notes                                             |
| ------------ | ------- | --------------------- | ------------------------------------------------- |
| workbuddy    | ✅      | browser authorization | E2E verified with a real account                  |
| workbuddy-cn | ✅      | browser authorization | E2E verified with a real account                  |
| codebuddy    | ✅      | browser authorization | E2E verified with a real account                  |
| buddy-intl   | ✅      | browser authorization | E2E verified with a real account                  |
| zcode        | ✅      | OAuth (CLI flow)      | E2E verified; manual CAPTCHA handoff, see below   |
| lobsterai    | ✅      | browser authorization | adapter implemented; login flow tested            |
| cline        | ✅      | WorkOS device code    | adapter implemented; login flow tested            |
| trae / trae-intl | ✅  | browser authorization | adapter implemented                               |
| codearts     | ✅      | OAuth (PKCE + DPoP)   | adapter implemented                               |
| qoder / qoder-cn | ✅  | device code           | adapter implemented; chat requires the client WASM binary, see below |
| loomy        | ✅      | phone number + SMS    | adapter implemented                               |
| raccoon      | ✅      | WeChat QR scan        | adapter implemented                               |

Status is stated per account on `/v1/models` (`available`) and in the admin
API. Not every provider has been exercised against a live account recently;
the table reflects the current development status, not a compatibility
guarantee.

### ZCode CAPTCHA policy

ZCode's upstream occasionally requires an Aliyun CAPTCHA. This gateway:

1. detects the challenge from the upstream response (header or body variant),
2. serves the **official Aliyun widget** to a human at `GET /captcha/zcode`,
3. accepts the token the human submits and uses it for subsequent requests.

There is no automated solving, no bypass, and no browser fingerprint
spoofing — by design. Without a fresh human-completed token the account is
parked in `needs_manual_action` and skipped by the pool.

### Qoder encrypted inference

Qoder's chat endpoint expects request bodies produced by the official
client's WASM module. That binary is **proprietary and not distributed with
this repository**. If you operate Qoder clients and legally possess the file,
place `qoder-auth-wasm.wasm` next to `src/providers/qoder/` (or point
`QODER_WASM_PATH` at it) — the adapter loads it at runtime. Without it,
qoder/qoder-cn login, model listing and quota keep working, but chat requests
fail with an explicit error. No extraction or redistribution instructions are
provided by this project.

## Requirements

- Node.js ≥ 18 (Node 22 for the Docker image)
- Docker + Docker Compose (optional, for container deployment)
- `better-sqlite3` is an optional dependency; without it the gateway falls
  back to in-memory storage (data is not persisted)

## Quick Start

```bash
git clone https://github.com/Xiaonan-520/Aether.git
cd Aether
cp .env.example .env          # fill in the three secrets (see Configuration)
docker compose up -d
curl http://127.0.0.1:8080/healthz
```

Or without Docker:

```bash
cp .env.example .env
npm install
npm run build && npm start    # or: npm run dev
```

Then register an account through the admin API (all admin endpoints take
`Authorization: Bearer <GATEWAY_ADMIN_TOKEN>`):

```bash
# start a login flow for a provider
curl -X POST -H "Authorization: Bearer $ADMIN" \
     -H "Content-Type: application/json" \
     -d '{"displayName": "main"}' \
     http://127.0.0.1:8080/api/accounts/workbuddy/login
# poll the returned login URL / loginId until it succeeds, then chat:
curl -X POST -H "Authorization: Bearer $KEY" \
     -H "Content-Type: application/json" \
     -d '{"model": "workbuddy::glm-5.3", "messages": [{"role": "user", "content": "hi"}]}' \
     http://127.0.0.1:8080/v1/chat/completions
```

## Configuration

All configuration is via environment variables (compose reads `.env`).

| Variable              | Required | Description                                                                 |
| --------------------- | -------- | --------------------------------------------------------------------------- |
| `GATEWAY_API_KEY`     | yes      | Bearer key clients must present on `/v1/*`                                  |
| `GATEWAY_SECRET`      | yes      | Derives the AES-256-GCM key encrypting stored credentials. Do not change after accounts exist, or stored tokens cannot be decrypted |
| `GATEWAY_ADMIN_TOKEN` | yes      | Bearer token for the management API `/api/*`                                |
| `DATA_DIR`            | no       | Data directory for SQLite + keys (default `./data`, `/data` in Docker)      |
| `TZ`                  | no       | Time zone for daily credit-claim scheduling (default `Asia/Shanghai`)       |
| `LOG_LEVEL`           | no       | `debug` / `info` / `warn` / `error` (default `info`)                        |
| `HTTP_HOST`           | no       | Bind host (default `0.0.0.0`)                                               |
| `HTTP_PORT`           | no       | Bind port (default `8080`)                                                  |
| `QODER_WASM_PATH`     | no       | Absolute path to a `qoder-auth-wasm.wasm` binary you supply yourself        |

## API

### OpenAI-compatible — `Authorization: Bearer <GATEWAY_API_KEY>`

```text
GET  /v1/models               model catalog with availability annotation
POST /v1/chat/completions     chat; stream=true returns SSE (data: {...} … data: [DONE])
```

Models can be addressed as `model` (router picks by priority/availability) or
explicitly as `provider::model`.

### Management — `Authorization: Bearer <GATEWAY_ADMIN_TOKEN>`

```text
GET    /api/providers                              registered adapters
GET    /api/accounts?provider=                     accounts + status
POST   /api/accounts                               create (import credential)
PATCH  /api/accounts/:id                           patch status/display/metadata
DELETE /api/accounts/:id
POST   /api/accounts/:provider/login               start interactive login
GET    /api/accounts/:provider/login/:loginId      poll login status
POST   /api/accounts/:provider/login/:loginId/credential   complete code/token exchange
POST   /api/accounts/:id/import-credential         upload a ready credential
POST   /api/accounts/:provider/captcha             zcode only: submit human-completed CAPTCHA token
GET    /api/jobs?type=                             background job history
GET    /api/events?limit=                          audit events
POST   /api/keys                                   issue a gateway API key
GET    /api/keys
DELETE /api/keys/:id
```

```text
GET /captcha/zcode     zcode CAPTCHA handoff page (browser, human-completed; admin token
                       is entered in the page and sent only to this gateway)
GET /healthz           liveness probe, no auth
```

The management API is part of the public interface but is meant for the
operator: it must never be exposed to untrusted networks.

## Architecture

```text
src/
├─ http/            Hono app: /v1, /api, /healthz; SSE plumbing
├─ protocol/openai/ request parsing, response serialization, SSE frames
├─ service/         chat orchestration (failover), models, logins, admin, API keys
├─ core/
│  ├─ router/       model → provider routing (explicit + fallback)
│  ├─ pool/         account status machine + selection + failure reporting
│  ├─ registry/     provider adapter interface + registry
│  ├─ worker/       job scheduler (token_refresh / quota_sync / credit_claim / health_check)
│  └─ errors/       upstream error kinds; provider-agnostic failover semantics
├─ providers/       one directory per provider + shared protocol helpers
└─ store/           StoreGateway interface; SQLite (WAL + migrations) and memory backends
```

Provider adapters never leak into core: each adapter translates its upstream
protocol into the canonical chat interfaces and maps upstream failures onto
the shared error kinds (`AUTH_INVALID`, `RATE_LIMIT`, `QUOTA_EXHAUSTED`,
`NEEDS_CAPTCHA`, …). Failover decisions live entirely in the pool/chat
service.

## Development

```bash
npm install
npm test            # vitest, 400+ tests
npm run typecheck   # tsc --noEmit
npm run build       # tsc + asset copy into dist/
npm run dev         # tsx watch mode
npm run migrate     # apply SQLite migrations manually
```

### Development model: Vibe Coding / AI-assisted development

This project is a **Vibe Coding / AI-assisted development** product. Most of
the code, tests and documentation were written with AI coding agents under
continuous human direction. In concrete terms:

- a human defined the requirements, architecture direction and provider
  roadmap, reviewed changes, ran the verification, operated the production
  deployment, and made every release decision;
- AI agents produced the implementation, refactors, tests and much of the
  debugging;
- AI-generated code is not assumed correct: everything here has gone through
  the test suite, type checking, and in several cases verification against
  real provider accounts. Production behavior is defined by what was actually
  tested and deployed, not by what the AI produced.

No AI tool is an author or copyright holder of this project; the copyright
and license are held by the human maintainer as stated in `LICENSE`.

### Contributing

Issues and pull requests are welcome. For provider adapters, please keep the
core provider-agnostic (new providers register in `src/providers/register.ts`)
and include tests. Note that CAPTCHA solving, bypass, or client-fingerprint
spoofing code will not be accepted.

## Docker

The image is built by GitHub Actions and published to GHCR on every push to
`main` and every `v*` tag:

```bash
# Canonical location once the repository is renamed to Aether
docker pull ghcr.io/xiaonan-520/aether:latest

# Migration-period compatibility: images published before the rename stay
# available under the old path; existing tags are untouched.
docker pull ghcr.io/xiaonan-520/multi-provider-ai-gateway:latest
```

`docker-compose.yml` runs the image with the data volume `gateway-data`
mounted at `/data`, a container healthcheck on `/healthz`, and
`restart: unless-stopped`. Secrets come from the `.env` file next to the
compose file — never bake them into an image. Pin `GATEWAY_IMAGE_TAG` to a
`sha-<commit>` tag for reproducible deploys.

## License

[MIT](LICENSE) — see also [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)
for third-party credits and attribution requirements.

## References & Third-Party Licenses

This project references, adapts, or interoperates with other open-source
projects. Their names, trademarks, code, and licenses remain with their
respective authors.

| Project | Repository | License | Usage |
| ------- | ---------- | ------- | ----- |
| deepseek-harness-codearts ("jet-hub") | [gitee.com/iJetLi/deepseek-harness-codearts](https://gitee.com/iJetLi/deepseek-harness-codearts) | MIT | Adapted code (provider protocol/signing material, Qoder WASM glue) + architecture reference |
| deepseek-harness | [github.com/deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | MIT | Architecture reference; no source code included |
| zcode-api | [github.com/TriDefender/zcode-api](https://github.com/TriDefender/zcode-api) | none (reference only) | Research reference for upstream captcha challenge behavior; no source code included, no authorization implied |
| Qoder client `qoder-auth-wasm.wasm` | — | proprietary | Not distributed. Loaded at runtime only if the operator supplies their own copy |

Full attribution, including the MIT notice text for jet-hub, is in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
