# gateway-extension-zcode

A standalone **Gateway Extension** that wraps **ZCode (Z.AI coding plan)** —
provider id `zcode`, Anthropic Messages upstream — behind the Gateway Extension
Protocol (Phase 3, `apiVersion` 1.0). Architecture mirrors
`extensions/workbuddycn` and fixes three issues found in its review. This is
the **final batch** of the provider migration: the built-in adapter
(`src/providers/zcode/`) was removed in the same commit; Core's
`/captcha/zcode` page and `/api/accounts/zcode/captcha` endpoint moved here.

## Endpoints

All require `Authorization: Bearer $GATEWAY_EXTENSION_TOKEN` except
`GET /health` (healthchecks) and `GET /v1/captcha` (human authorization page).

| Method | Path | Purpose |
|---|---|---|
| GET | `/manifest` | Extension manifest |
| GET | `/health` | `{status, version, accounts:{total,usable}}` |
| GET | `/v1/accounts` | `{accounts: ExtensionAccount[]}` |
| POST | `/v1/accounts` | Create account shell (credential fields rejected — protocol boundary) |
| POST | `/v1/accounts/:id/login` | **Two-phase OAuth**: `cli/init` → returns official `authorizationUrl` |
| GET | `/v1/accounts/:id` | Detail; each GET advances the login poll **single-flighted** |
| POST | `/v1/accounts/:id/import-credential` | Paste `jwt_token` / `api_key` directly |
| POST | `/v1/accounts/:id/refresh` | Health-check semantics (ZCode credentials are static) |
| POST | `/v1/accounts/:id/enable` · `/disable` | `{enabled}` → re-enable restores `active` when a credential exists |
| **DELETE** | `/v1/accounts/:id` | Delete account + credential + caches (missing in workbuddycn) |
| GET | `/v1/accounts/:id/quota` | `QuotaSnapshotV1` — `tokens` resource, `null` stays `null` |
| GET | `/v1/models` | Static GLM catalog, cache keyed per account |
| POST | `/v1/chat` | `accountId` + `requestId` + `deadlineMs`; JSON or SSE |
| POST | `/v1/actions/:actionId` | `refresh-quota` only |
| GET | `/v1/captcha` | Official Aliyun widget page (human completes it) |
| POST | `/v1/captcha` | Submit the human-completed `verify_param` |

## Captcha: two modes

| `ZCODE_CAPTCHA_MODE` | Behavior | Compliance |
|---|---|---|
| `manual` (**default**) | Cached human token; challenge parks requests on a single-flight wait until an operator submits via `POST /v1/captcha` | No automation |
| `auto` | happy-dom solver (`src/solver/`, ported from TriDefender/zcode-api) solves challenges against the real Aliyun SDK: fixed fingerprint, network-layer interception, `isTrusted` patch, token pool, bounded retry, CPU governor | **Bypasses risk control — likely violates upstream ToS; ported code is CC BY-NC-SA 4.0 → this mode's portions are non-commercial** |
| `off` | Never sends captcha headers | — |

### auto mode internals (`src/solver/`)

All mechanisms preserved from the reference implementation, each with the
field-tested rationale in comments:

- **Fixed fingerprint** (`fingerprint.ts`) — never randomized; Aliyun correlates
  cross-request stability and randomizing triggers `F001`
- **Full network interception** — Client Hints / CORS-semantics `origin` /
  manual cookie container; CDN disk cache, `pe` bundles never cached
- **`toString()` nativization** — passes the FeiLin `[native code]` sweep
- **`Event.isTrusted` patch in-realm** — the single most important forgery
- **Polyfill table** — a missing global breaks the risk engine's probe chain
- **SDK XHR timeout patch** `5e3 → 30e3` in *both* bundles — root-cause fix for
  the F008 duplicate-certifyId cascade (fail-open on SDK upgrades)
- **Strict result validation** — degraded 76-char params (missing
  `securityToken`) are refused locally rather than sent (a bad param exposes
  more than no param)
- **Token pool** — hot path never waits on a solve (sub-ms take), F008
  dedup registry, deep-idle shutdown
- **CPU governor** — `/proc/stat` with `os.cpus()` fallback
  (**`os.loadavg()` is [0,0,0] on Windows** — the field incident that pinned a
  core and grew the heap to 2.8 GB)
- **Bounded retry** — budget-exhausted failures map to `NEEDS_CAPTCHA`, never
  a fabricated token, never a bare request

Mode wiring: an auto-solved token is preferred on first send; on a challenge
the pool is tried before falling back to the manual single-flight wait, so
`auto` degrades gracefully to `manual` when the pool cannot serve.

### auto mode env vars

| Variable | Default | Meaning |
|---|---|---|
| `ZCODE_CAPTCHA_POOL_MIN` / `_MAX` | `5` / `20` | Token pool size |
| `ZCODE_CAPTCHA_SOLVE_CONCURRENCY` | `2` | Parallel solves |
| `ZCODE_CAPTCHA_SOLVE_TIMEOUT_MS` | `30000` | Per-solve deadline |
| `ZCODE_CAPTCHA_CPU_LIMIT_PCT` | `70` | CPU ceiling, 0 = off |
| `ZCODE_CAPTCHA_SCENE_ID` / `_REGION` / `_PREFIX` | built-in defaults | Aliyun scene override |

## Fixes over workbuddycn (from the interface audit)

1. **Re-enable state machine**: `disable → enable` no longer strands accounts
   in `pending` when a credential exists (workbuddycn bug — such accounts were
   excluded from routing forever).
2. **Login-poll single-flight**: concurrent `GET /v1/accounts/:id` share one
   upstream poll (workbuddycn only single-flights token refresh).
3. **Per-account model cache**: `model_cache` is keyed by `account_id`
   (workbuddycn used a single `'default'` row for all accounts).
4. **DELETE endpoint closes the lifecycle**: deleting via Core removes the
   extension-side row, credential, and caches.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | HTTP listen port (matches manifest runtime.port) |
| `DATA_DIR` | `/data` | SQLite + encryption key (named-volume mount) |
| `GATEWAY_EXTENSION_TOKEN` | — | Manager-injected bearer token |
| `EXTENSION_ENCRYPTION_KEY` | auto-generated | AES-256-GCM key material |
| `ZCODE_API_BASE` | `https://zcode.z.ai/api/v1` | Upstream API base (test override) |
| `ZCODE_REQUEST_TIMEOUT_MS` | `120000` | Upstream chat timeout |
| `ZCODE_CAPTCHA_WAIT_MS` | `60000` | How long a challenged chat waits for a human token |

## Deploy

Built and published by CI (`.github/workflows/docker.yml` →
`ghcr.io/xiaonan-520/gateway-extension-zcode`), or locally:

```bash
docker compose -f docker-compose.extensions.yml --profile zcode-extension build gateway-extension-zcode-build
# then install via the Console / Extension Manager (install-from-image):
#   image: local/gateway-extension-zcode  tag: 1.0.0
```

## Verify

```bash
npm install
npm test          # 42 tests — multi-account, login flow, error mapping,
                  #             captcha handoff, solver regressions
npm run typecheck # strict, 0 errors
npm run build     # tsc → dist/
```

**Not verified**: a real ZCode account end-to-end (requires real credentials
and network access to zcode.z.ai). The upstream protocol was ported unchanged
from the Core adapter (`src/providers/zcode/`) which is E2E-verified with real
accounts per the Aether README.
