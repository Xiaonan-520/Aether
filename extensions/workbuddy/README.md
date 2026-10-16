# gateway-extension-workbuddycn

A standalone **Gateway Extension** that wraps the Tencent **CodeBuddy / WorkBuddy
China mainland** site (provider id `workbuddycn`) behind the Gateway Extension
Protocol (Phase 3, `apiVersion` 1.0). The Gateway Core and the Extension Manager
never see Tencent endpoints, token formats or credentials — everything
provider-specific is isolated inside this extension.

The protocol contract implemented here is documented in
[`docs/PROTOCOL_CONTRACT.md`](docs/PROTOCOL_CONTRACT.md), verified against the
Phase 3 Gateway source (read-only audit). This project has **no build/run
dependency** on the Gateway source.

## Endpoints

All require `Authorization: Bearer $GATEWAY_EXTENSION_TOKEN` (Manager-injected)
except `GET /health`, which is open for container healthchecks.

| Method | Path | Purpose |
|---|---|---|
| GET | `/manifest` | Extension manifest (`apiVersion`, extension, runtime, security, providers) |
| GET | `/health` | `{status, version, accounts:{total,usable}}` (unauthenticated) |
| GET | `/v1/accounts` | `{accounts: ExtensionAccount[]}` |
| GET | `/v1/accounts/:id` | `{account}`; advances a pending login one step |
| POST | `/v1/accounts` | `{accountId?, loginMode, displayName?}` → 201 pending + `authorizationUrl` |
| POST | `/v1/accounts/:id/refresh` | `{status, refreshed, error}` |
| POST | `/v1/accounts/:id/enable` · `/disable` | `{enabled}` → `{accountId, accepted, status}` |
| GET | `/v1/accounts/:id/quota` | `QuotaSnapshotV1` (`resources[].kind`, `.status`, `.unit`) |
| GET | `/v1/models` | `{models: ProtocolModelInfo[]}` (ids have no `::` prefix) |
| POST | `/v1/chat` | `ChatRequest + {accountId, requestId, deadlineMs}`; JSON or SSE |
| POST | `/v1/actions/:actionId` | No actions declared today (404 for anything else) |

Errors: `{error: {kind, message, httpStatus?, retryable?, ...}}` where `kind` is
one of the Gateway `UpstreamErrorKind` values (`AUTH_INVALID`, `TOKEN_EXPIRED`,
`RATE_LIMIT`, `QUOTA_EXHAUSTED`, `TIMEOUT`, `TRANSPORT`, `UPSTREAM_5XX`,
`TERMINAL`, `EMPTY_RESPONSE`, `NEEDS_CAPTCHA`, `NEEDS_MANUAL`) plus the reserved
`PROTOCOL_VIOLATION`.

## Chat / SSE

Core supplies `accountId` (the extension never selects an account), a `requestId`
trace id and a `deadlineMs` budget. Streaming uses exactly one terminal frame:

```
event: chunk
data: {"text":"Hello"}

event: chunk
data: {"text":" World"}

event: done
data: {"finishReason":"stop"}

```

Failure terminates with a single `event: error` frame carrying the error envelope.
A client disconnect aborts the upstream fetch and frees the in-flight registry entry.

## Login (external-link)

`POST /v1/accounts` starts the official CodeBuddy China login flow and returns the
official authorization URL; the user completes login (and any official CAPTCHA) in
their own browser. Each `GET /v1/accounts/:id` advances the upstream poll one step
(`/v2/plugin/auth/token`, then `/v2/plugin/login/account`); the account flips from
`pending` to `active` once the credential is stored **encrypted inside the
extension**. No credential ever crosses the protocol boundary. The extension never
solves or bypasses captchas.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | HTTP listen port (matches `manifest.runtime.port`) |
| `DATA_DIR` | `/data` | SQLite + encryption key location (named-volume mount) |
| `GATEWAY_EXTENSION_TOKEN` | — | Manager-injected bearer token (secret, per-install) |
| `GATEWAY_EXTENSION_ID` | — | Manager-injected extension id |
| `EXTENSION_ENCRYPTION_KEY` | auto-generated in `DATA_DIR` | AES-256-GCM key material |
| `LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error` |
| `WORKBUDDYCN_*` | see `src/util/config.ts` | upstream endpoint/domain/timeouts/login TTL |

## Security

- Credentials are AES-256-GCM encrypted in the extension's own SQLite DB under
  `DATA_DIR`; the key never leaves the extension and is never logged.
- Account ids are the Core-allocated opaque `accountId`; upstream uid / nickname /
  enterprise id stay inside the extension.
- API responses, logs and error bodies never contain tokens, cookies, passwords
  or full Authorization headers (asserted by tests).
- Routing/cooldown/failover belong to Core; the extension reports provider-side
  account state only.

## Development

```bash
npm install          # also builds the better-sqlite3 native binding
npm run typecheck
npm run build
npm test             # 52 tests, fake upstream only (no Tencent access)
```

Tests live in `test/`: `conformance.spec.ts` (protocol domains),
`provider.spec.ts` (errors/timeout/cancellation/persistence/redaction),
`errors.spec.ts` (kind mapping), `manifest.spec.ts` (schema + Manager limits).
The fake upstream (`test/fake/upstream.ts`) emulates the Tencent endpoints and
fault injection; no real credentials are used.

## Deployment

Production installation is performed by the Phase 3 **Extension Manager** from the
manifest + image (`local/gateway-extension-workbuddycn:1.0.0`) — see
`docs/PROTOCOL_CONTRACT.md`. `docker-compose.yml` here is a loopback-only
self-test only.

## Scope

Gateway Core / Manager / Router / other providers (international WorkBuddy,
CodeArts, LobsterAI, Qoder, …) are out of scope.
