# HANDOFF — Multi-Provider AI Gateway

> Written for a **new agent with no prior chat context**. Every claim below is
> grounded in the repository, the running deployment, or a recorded live test.
> Facts and unverified items are kept separate; nothing is guessed.
>
> Start here, then read `README.md`, then this file.

---

## 0. TL;DR for the next agent

- Self-hosted, OpenAI-compatible gateway: one `http://<host>:8080/v1` endpoint in
  front of 14 LLM provider adapters with multi-account pooling, token refresh,
  failover, quota-aware routing, a background scheduler and SQLite persistence.
- **14 providers registered**, **353 tests passing**, deployed and healthy on the
  home server via a GHCR image.
- 4 providers are validated end-to-end against **real accounts**
  (workbuddy, workbuddy-cn, codebuddy, buddy-intl). 6 more have their login
  plumbing fixed and verified but need a human browser authorization to finish.
- Known open bugs (all recorded honestly in §7) were **fixed** in `e5f3650`
  except the ones explicitly listed as unresolved.

---

## 1. Project goal & architecture

**Goal**: extract the provider/OAuth/credential/quota/credit capabilities of the
reference project `deepseek-harness-codearts` (a.k.a. `dsh-account-hub`, and the
wider `jet-hub` variant) into a standalone, Dockerised gateway that exposes a
single OpenAI-compatible surface to any client (RikkaHub, OpenCode, DSH, Pi agent…).

```
clients (RikkaHub / OpenCode / DSH / Pi agent / any OpenAI client)
  │  Authorization: Bearer <GATEWAY_API_KEY>
  ▼
OpenAI-compatible API (/v1)              src/http/app.ts
  ▼
Gateway Core
  ├── Protocol parser (OpenAI)           src/protocol/openai/{parse,serialize,sse}.ts
  ├── Model Registry / Router            src/core/router/model-router.ts, service/model-service.ts
  ├── Account Pool (state machine)       src/core/pool/account-pool.ts
  ├── Provider Registry / Adapters       src/core/registry/*, src/providers/*
  ├── Credential Manager (AES-256-GCM)   src/store/crypto.ts
  ├── Store (SQLite WAL / MemoryStore)   src/store/*
  └── Scheduler                          src/core/worker/scheduler.ts, service/scheduler-executors.ts
        ▼
      Provider adapters → upstream APIs
```

### Layering rules (do not violate)

- **Provider-specific logic lives only in `src/providers/<provider>/`** (or a
  shared family under `src/providers/shared/<family>/`).
- **Core must not contain provider-name branches.** Verified: no provider id
  literal appears in `src/core|store|service|http|protocol` (the single
  exception is the zcode captcha route in `src/http/app.ts`, which predates this
  and is deliberate).
- Capability truth over convenience: a provider that cannot do something declares
  `supportsQuota: false` / `supportsCredits: false` rather than faking an API.

### Key seams

| Seam | Where | Purpose |
| --- | --- | --- |
| `Provider` / `ProviderOpsImpl` / `ProviderAuthImpl` | `src/core/registry/provider.ts` | the adapter contract |
| `RefreshResult.credential` | `src/core/registry/provider.ts` | a refresh that rotates a token **must** return the new credential so the caller persists it |
| `ImportCredentialResult.credential` | `src/core/registry/provider.ts` | same, for code/AK-SK → credential exchanges |
| `ProviderCtx.resolveCredential` | `src/core/registry/provider.ts` | adapters get a decrypted credential, never the cipher |
| `LoginMode` | `src/core/types.ts` | `oauth \| device-code \| external-link \| sms \| disk-credential \| import` |
| `UpstreamProtocol` | `src/core/types.ts` | `openai-chat \| anthropic-messages` |
| `ClaimOutcome` | `src/core/types.ts` | normalised credit-claim result |

---

## 2. HTTP API surface

Auth:
- `/v1/*` requires `Authorization: Bearer <GATEWAY_API_KEY>` (constant-time compare).
- `/api/*` requires `Authorization: Bearer <GATEWAY_ADMIN_TOKEN>`.
- `/healthz` is unauthenticated.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/healthz` | liveness |
| GET | `/v1/models` | OpenAI list envelope; de-duplicated by model id |
| POST | `/v1/chat/completions` | stream + non-stream; SSE is OpenAI-format |
| GET | `/api/providers` | id, displayName, capabilities |
| GET | `/api/accounts` (+ `/:id`) | accounts, redacted |
| POST | `/api/accounts` | create |
| PATCH/DELETE | `/api/accounts/:id` | update / remove |
| POST | `/api/accounts/:provider/login` | start login (`{displayName?, phone?}`) |
| GET | `/api/accounts/:provider/login/:loginId` | poll login |
| POST | `/api/accounts/:provider/login/:loginId/credential` | **finish a login whose flow cannot complete by polling** (auth code / refresh token / AK-SK); body `{credential:{…}}` or the payload inline |
| POST | `/api/accounts/:id/import-credential` | upload a **ready** credential blob `{credential:{…}}` |
| POST | `/api/accounts/:provider/captcha` | zcode only: operator submits a captcha token |
| GET | `/api/jobs`, `/api/events` | scheduler / audit views |

### OpenAI compatibility note (regression-tested)

`messages[].content` accepts **both** shapes:
- `content: "text"` (string), and
- `content: [{type:"text", text:"…"}, …]` (OpenAI content parts).

`flattenContent()` in `src/protocol/openai/parse.ts` concatenates text parts.
Unsupported part types (e.g. `image_url`) return an explicit **400**
`unsupported_content_part` — never silently dropped. Null / `[]` become `''`.
Regression suite: `tests/pi-agent-compat.spec.ts`.

---

## 3. The 14 providers

| # | Provider id | Family / protocol | Login mode | Notes |
| --- | --- | --- | --- | --- |
| 1 | `workbuddy` | shared/buddy (Tencent, intl) | external-link | external-link poll |
| 2 | `workbuddy-cn` | shared/buddy (Tencent, CN) | external-link | product config only |
| 3 | `codebuddy` | shared/buddy (CodeBuddy CN) | external-link | product config only |
| 4 | `buddy-intl` | shared/buddy (CodeBuddy intl) | external-link | product config only |
| 5 | `zcode` | Z.AI coding plan | oauth | upstream is Anthropic Messages; `needsCaptcha: true` (manual submit only) |
| 6 | `lobsterai` | 有道 (own protocol) | external-link + authCode exchange | HMAC-free; `X-LobsterAI-Client-*` headers |
| 7 | `cline` | Cline | device-code (WorkOS) | no local callback port |
| 8 | `trae` | shared/trae (字节, CN) | external-link + refresh-token exchange | SOLO request body + SOLO SSE; per-account `machine_id`/`device_id` |
| 9 | `trae-intl` | shared/trae (intl) | same | product config only |
| 10 | `codearts` | 华为云 (own protocol) | **AK/SK import** | SDK-HMAC-SHA256 signing; temporary AK/SK, **no refresh** |
| 11 | `loomy` | 讯飞 (own protocol) | **sms** | HMAC-SHA1 `account ak:sig`; **no refresh endpoint** (14-day session) |
| 12 | `qoder` | shared/qoder (阿里, intl) | device-code + PKCE | **encrypted inference via vendored WASM** |
| 13 | `qoder-cn` | shared/qoder (CN) | same | product config only |
| 14 | `raccoon` | 商汤 (own protocol) | **WeChat QR only** | SMS path deliberately refuses (needs Aliyun slider captcha) |

Shared families: `src/providers/shared/buddy/` (4 products), `src/providers/trae/`
(2), `src/providers/qoder/` (2). Everything else is its own protocol family.

### Vendored WASM (Qoder)

`src/providers/qoder/qoder-auth-wasm.wasm` (298 KB) is the official client's
encrypted-inference module, vendored **byte-identical** to the reference. It
produces `Authorization: Bearer COSY.<payload>.<sig>` plus the encrypted body; a
plain Bearer token yields 403 Signature invalid. Because `tsc` does not copy
non-TS assets, `npm run build` also runs `scripts/copy-assets.mjs` — keep that in
mind if you change the build.

---

## 4. Git / deployment / CI state

*(verify these before trusting them — numbers move)*

| Item | Value |
| --- | --- |
| Local path | `/home/xiaonan/multi-provider-ai-gateway` |
| GitHub | `git@github.com:Xiaonan-520/multi-provider-ai-gateway.git` (**private**) |
| Branch | `main` |
| Remote protocol | **SSH** — the `gh` OAuth token lacks `workflow` scope, so pushes containing workflow files fail over HTTPS |
| GHCR image | `ghcr.io/xiaonan-520/multi-provider-ai-gateway` (**public**, path must stay lowercase; the workflow lowercases `${GITHUB_REPOSITORY,,}`) |
| Deploy dir (server) | `/home/xiaonan/multi-provider-ai-gateway` |
| Compose | `docker-compose.yml` = pure GHCR pull, named volume `gateway-data:/data` |
| Container | `ai-gateway` (non-root uid 999), port 8080 |
| Tests | 353 passing / 29 files |
| typecheck / build | clean |

**Deploy recipe (server, single line)**:
```bash
docker pull ghcr.io/xiaonan-520/multi-provider-ai-gateway:latest && \
cd /home/xiaonan/multi-provider-ai-gateway && \
docker compose pull && docker compose up -d
```
Read secrets from `.env` with `set -a && . ./.env && set +a`.

### Hard operational constraints

- **Never** `docker compose down` other projects, `docker system prune`, remove
  volumes or containers.
- 9 pre-existing containers must stay untouched: `zcode-proxy`,
  `immich_server`, `immich_machine_learning`, `immich_redis`, `immich_postgres`,
  `mealie`, `navidrome`, `bili_tool_web`, `folia-sync`.
- **Never** read or modify `zcode-proxy` or its secrets.
- Deploy **only** by pulling the GHCR image (no local image build on the server).
- Never print or commit tokens, refresh tokens, JWTs, cookies, AK/SK, API keys.
  When inspecting credentials, print a SHA-256 fingerprint prefix instead.

---

## 5. Configuration

`.env` (real, git-ignored) next to `docker-compose.yml`. Template: `.env.example`.

| Variable | Required | Meaning |
| --- | --- | --- |
| `GATEWAY_API_KEY` | yes | key for `/v1/*` |
| `GATEWAY_SECRET` | yes (≥16 chars) | AES key material for credentials at rest — **changing it makes existing credentials undecryptable** |
| `GATEWAY_ADMIN_TOKEN` | yes | key for `/api/*` |
| `DATA_DIR` | no | default `/data` in the container |
| `TZ`, `LOG_LEVEL`, `HTTP_HOST`, `HTTP_PORT` | no | defaults in `.env.example` |

---

## 6. Data, secrets and what is NOT backed up by GitHub

| Asset | Where it lives | In GitHub? |
| --- | --- | --- |
| `.env` (the three secrets) | repo dir + server | **NO** — must be restored from your own backup |
| SQLite DB (`gateway.db`, WAL) | Docker named volume `multi-provider-ai-gateway_gateway-data`, container path `/data` | **NO** |
| Provider credentials (encrypted) | `credentials` table inside that DB | **NO** |
| Account list, models, jobs, events, credit_claims | same DB | **NO** |
| Source, tests, docs, workflows | repo | yes |

**Reinstall impact**: a fresh Arch install does not by itself destroy the Docker
volume, but a wiped Docker root does. To keep accounts, back up the
`multi-provider-ai-gateway_gateway-data` volume **and** the `.env` (the same
`GATEWAY_SECRET` is required to decrypt the stored credentials — without it the
DB is useless).

**Security check on the repo**: `.gitignore` ignores `.env` and `.env.*` while
tracking `!.env.example`. No secret has ever been committed on this repo's
current history; the tracked `docs/HANDOFF.md`, `docs/AUDIT_REPORT.md`,
`docs/DESIGN_PHASE2.md` contain design notes only. If you ever find a real
secret in history, report it — do **not** rewrite history without explicit
approval.

---

## 7. Known issues — honest current state

All items below were found during real-account validation. Batch A/B/C fixes
landed in commit `e5f3650`; the "status" column says whether it is resolved.

### P0 — login blocked (RESOLVED in `e5f3650`)

- **LobsterAI / TRAE / TRAE-INTL / CodeArts could not complete login at all.**
  Root cause was two-fold:
  1. `pollLogin` for these adapters only handled the "not finished" branch and
     never returned success;
  2. the only code that could finish the flow, `auth.importCredential`, **was
     never called by any HTTP route** — and it did not even return the exchanged
     credential (return type was `{expiresAt, refreshable}` only).
  Fix: added `ImportCredentialResult.credential`, made the adapters return the
  exchanged credential, and added
  `POST /api/accounts/:provider/login/:loginId/credential` →
  `LoginService.submitCredential()`, which persists it and syncs models.
  Verified live: submitting a bad code now yields a **structured 400** with the
  upstream business message (previously an opaque `internal gateway error`).
  Still requires a **human** browser authorization to obtain a real code.

- **Qoder / Qoder-CN device poll was missing PKCE nonce/verifier.**
  Live evidence before the fix:
  `GET https://openapi.qoder.sh/api/v1/deviceToken/poll` → **HTTP 400**
  `{"errorCode":"DeviceTokenNonceRequired","errorMessage":"nonce is required"}`.
  The adapter generated a challenge but never a verifier, never sent `nonce`,
  and used one host for both auth and openapi.
  Fix: `createQoderPkce()`, `createQoderNonce()`, `buildQoderAuthUrl()`,
  `buildQoderPollUrl()`; `product.ts` now separates `authBase` from
  `openApiBase` for both products.
  Verified live after the fix: the same endpoint returns **HTTP 404 NotFound**
  (the documented "no pending session, keep polling" response).

### P1 — credential lifecycle (RESOLVED in `e5f3650`)

- **Buddy family refresh did not persist the rotated refresh token.**
  `refreshAccount` computed `next = buildCredential(...)` but returned only the
  expiries, so the stored token drifted from upstream forever (the upstream
  rotates the refresh token on every refresh — confirmed against a live account).
  Fix: return `credential: next` (carries new `access_token`, `expires_at`,
  `refresh_token`, `refresh_expires_at`).
  Real-account regression on all four accounts: `returned_credential=true`,
  `ciphertext_changed=true`, `access_rotated=true`, `refresh_rotated=true`,
  `both_expiries=true`, and chat still answers `pong` afterwards.

### P2 — robustness

- **Buddy model discovery returns non-chat models** — *still present, deliberately
  not "fixed".* Live `/v3/config` inspection showed `data.models` entries carry
  **no `usage` field**, and the ids that failed upstream (`auto-chat`,
  `codewise-completions` → `400 code 11102 model … service info not found`) are
  genuine entries that agents also reference. There is **no reliable field to
  filter on**, so no brittle heuristic was added. The upstream error is a
  transient model-availability condition, not a catalog-shape bug.
- **ZCode captcha first-request** — the captcha manager is manual-submit only
  (45 s TTL, invalidate-on-403, single-flight). One observed request returned
  `NEEDS_CAPTCHA` and an immediate retry succeeded. **No auto-fetch was added**,
  because that could mask a genuine human-captcha requirement.
- **ZCode OAuth poll HTTP 429** — RESOLVED in `e5f3650`: retries honouring
  `retry-after` (else exponential backoff), and after exhausting retries raises
  a structured `ZCodePollRateLimitedError` which the adapter maps to a *pending*
  status with a retry hint instead of throwing out of the HTTP layer.
- **`/import-credential` with a bad body returned 500** — RESOLVED in `e5f3650`:
  now a structured 400 `invalid_request_error` ("missing \"credential\" object…").

### External / manual blockers (NOT code bugs — do not "fix" by bypassing)

- **Cline — `blocked_external_auth`.** Registering a mainland China `+86` number
  is impossible: after selecting `+86` the phone input auto-formats the first
  three digits as a bracketed area code, so an 11-digit number cannot validate.
  This is a Cline / WorkOS AuthKit page issue. Do not work around it.
- **Raccoon — `needs_manual_action`.** The QR URL the adapter returns is
  **valid** (polling the real API with our code returns `HTTP 200
  {"code":0,"data":{"status":"pending"}}`), but it is an SPA shell — every path
  (including a bogus one) returns the same 200/3364-byte document, so opening it
  in a browser renders the SPA's own 404. The reference renders the URL into an
  SVG QR image; this gateway has no QR-rendering layer yet, so a human must turn
  the URL into a scannable QR and use WeChat. This is a missing convenience
  feature, not a broken URL.
- **Loomy — `not_logged_in`.** SMS login needs a phone number, which was
  deliberately never collected. No bypass attempted.

### Other live observations (not bugs)

- `/v1/models` de-duplicates by model id, so zcode's `glm-5.2`/`glm-5.1` are
  shadowed by same-named codebuddy/workbuddy entries. This is by design
  (`ModelService.list()` keeps the first available route).
- `credit_claims` uses `UNIQUE(account_id, claim_type, claim_date)`, which is
  the idempotency guard for the 30-minute credit scan.
- A `not_available` (activity inactive) credit result deliberately does **not**
  close the day, so polling can catch the activity opening later; any real
  attempt (success / already_claimed / failure / auth problem) does close it.

---

## 8. Real-account validation status

| Provider | Models | Chat | Stream | Quota | Credits | Refresh | Real status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| workbuddy | ✅ 31 | ✅ | ✅ | `known:false` | ✅ (`active:false`) | ✅ rotated+persisted | **verified** |
| workbuddy-cn | ✅ 37 | ✅ | ✅ | `known:false` | ✅ claimed | ✅ rotated+persisted | **verified** |
| codebuddy | ✅ 18 | ✅ | ✅ | `known:false` | ✅ claimed | ✅ rotated+persisted | **verified** |
| buddy-intl | ✅ 14 | ✅ | ✅ | `known:false` | ✅ (`active:false`) | ✅ rotated+persisted | **verified** |
| zcode | ✅ 2 visible | ✅ | ✅ | `known:false` | `unsupported` | n/a (static) | **partial** |
| qoder, qoder-cn | — | — | — | — | — | ✅ | **pending_manual_authorization** |
| lobsterai, trae, trae-intl, codearts | — | — | — | — | — | ✅ | **pending_manual_authorization** |
| cline | — | — | — | — | — | — | **blocked_external_auth** |
| raccoon | — | — | — | — | — | — | **needs_manual_action** |
| loomy | — | — | — | — | — | — | **not_logged_in** |

High-value accounts (facts, not a ranking):
- `workbuddy`: DeepSeek-V4.1 (`deepseek-v4.1-flash`, `-sg`), `glm-5.3-flash`,
  plus GPT-6/GPT-5.6, Gemini 3.8, Grok-4.7, Kimi-K3; free-trial models present.
- `codebuddy`: DeepSeek-V4 flash/pro (+peak variants), `glm-5.3`, Kimi-K3-1, MiniMax-M3.
- `workbuddy-cn`: the largest catalog (37); DeepSeek-R1/V3, GLM-4.6v, hunyuan-image.
- `buddy-intl`: `o4-mini`, Tencent-Cloud genie-ide.

Credits: the daily check-in ran **once, with the operator's explicit approval**,
for `workbuddy-cn` and `codebuddy` (which share one activity subject). Every
other probe has been read-only. `credit_claims` currently holds 3 rows.

---

## 9. Development workflow

```bash
npm ci --include=optional     # native sqlite driver
npm run typecheck             # tsc --noEmit
npm test                      # vitest run  (353 tests)
npm run build                 # tsc + copy-assets (Qoder WASM into dist/)
npm run dev                   # tsx watch
npm run migrate               # apply SQLite migrations
```

Rules that keep this codebase healthy:

1. Provider logic stays in `src/providers/**`; Core stays provider-agnostic
   (grep for provider ids outside `src/providers/` before committing).
2. Every capability you cannot verify must be declared `false` / `unsupported` /
   `known:false` — never faked.
3. Try to reuse the existing family adapters (`shared/buddy`, `trae`, `qoder`)
   instead of copying a protocol.
4. Any new rotating-token provider must return `credential` from refresh and
   import.
5. Add focused regression tests for every fix; keep the OpenAI content-parts
   compatibility tests green.
6. Commit per logical stage, push to `main` over **SSH**, let CI build the GHCR
   image, then deploy by pulling it.

---

## 10. Roadmap / TODO

1. Finish **human authorization** for the 6 `pending_manual_authorization`
   providers, then validate their Models / Chat / Stream.
2. Consider a QR-rendering layer for Raccoon (feature, not a bug fix).
3. Optionally add per-account quota for Buddy-family providers if a reliable
   endpoint is found (currently `known:false`).
4. Clean up the ~17 leftover `needs_manual_action` login-attempt accounts
   (data hygiene only — they hold no credentials and do not affect routing).
5. Revisit the zcode captcha lifecycle **only** if a safe automatic refresh is
   provably equivalent to the manual path.

---

## 11. Arch reinstall — how to resume

```bash
git clone git@github.com:Xiaonan-520/multi-provider-ai-gateway.git
cd multi-provider-ai-gateway
cat README.md && cat HANDOFF.md
npm ci --include=optional && npm test && npm run build
```

Then restore, from your own backup (NOT from GitHub):
1. `.env` — the three secrets. Reuse the **same `GATEWAY_SECRET`**, otherwise the
   stored provider credentials cannot be decrypted.
2. The Docker volume `multi-provider-ai-gateway_gateway-data` (SQLite DB with
   accounts, encrypted credentials, models, jobs, events, credit_claims).

Finally: `docker compose pull && docker compose up -d`, then check
`curl -s localhost:8080/healthz`.
