# Upstream research notes — `buddy` provider (Tencent CodeBuddy CN)

Source: `iJetLi/deepseek-harness-codearts` (Gitee), local clone at
`/workspace/deepseek-harness-codearts`, HEAD `cecf376`.

Research scope was **restricted to the `buddy` provider only**:
`src/buddy.ts`, `src/buddy-oauth.ts`, `src/buddy-adapter.ts`, `src/buddy-auth.ts`,
`src/product.ts` (CODEBUDDY entry), `src/credits.ts`, `src/buddy-balance-rank.ts`,
plus the shared helpers `buddy` depends on (`src/llm-adapter.ts` rate-limit/transport
classification, `src/sse.ts` `readWithIdleTimeout`).

Explicitly **not** used as a basis: `workbuddy` (international, `www.workbuddy.ai`),
CodeArts, LobsterAI, Qoder/Loomy/MiniMax/Trae/Raccoon/Cline.

> `buddy` != `workbuddy`. This project targets the **China mainland** site only.

## 1. Base endpoints (from `src/buddy.ts` + `src/product.ts` CODEBUDDY)

| Purpose | Method | Path |
|---|---|---|
| API endpoint (base) | — | `https://copilot.tencent.com` |
| Prefix path | — | `/plugin` |
| Platform | — | `ide` |
| Login website | — | `https://www.codebuddy.cn` |
| Fetch auth state | POST | `/v2/plugin/auth/state?platform=ide` |
| Poll token | GET | `/v2/plugin/auth/token?state=...` |
| Poll account | GET | `/v2/plugin/login/account?state=...` |
| Refresh token | POST | `/v2/plugin/auth/token/refresh` |
| Account list | GET | `/v2/plugin/accounts` |
| Cloud config (models) | GET | `/v3/config` |
| Scoped model catalog (preferred) | GET | `/console/enterprises/personal/models` |
| Chat completions | POST | `/v2/chat/completions` |
| Credits balance | POST | `/v2/billing/meter/get-user-resource` |
| Checkin status | POST | `/v2/billing/meter/checkin-activity-status` |
| Daily checkin claim | POST | `/v2/billing/meter/daily-checkin` |

`X-Domain` = `copilot.tencent.com` (bare host, no scheme). `X-Product` = `SaaS`
(deployment type). `X-Product-Code` = `codebuddy`. `User-Agent` = `CodeBuddyIDE/1.106.1`.

## 2. Login flow (polling, "external-link-v2")

1. `POST /v2/plugin/auth/state?platform=ide` with headers
   `X-Domain`, `X-No-Authorization: true`, `X-No-User-Id: true`,
   `X-No-Enterprise-Id: true`, `X-No-Department-Info: true`, `User-Agent`.
   → `{code, data: {state, authUrl}}`. Timeout 10s (`STATE_REQUEST_TIMEOUT_MS`).
2. User opens `authUrl` in browser (official login page — `www.codebuddy.cn/login`).
   CodeBuddy does **not** need extra query params; WorkBuddy (intl) does.
3. `GET /v2/plugin/auth/token?state=...` poll every 1000ms, 5min timeout.
   Headers: `X-No-Authorization: true`, `User-Agent`.
   Business code `11217` = token not ready → keep polling. Network error → keep polling.
   → `data: {accessToken, refreshToken, expiresIn, refreshExpiresIn, tokenType, scope, domain}`.
   **No absolute `expiresAt`** — only relative `expiresIn`. Absolute expiry derived from
   JWT `exp` of access_token (authoritative) or `iat + expiresIn`.
4. `GET /v2/plugin/login/account?state=...` poll, with the poll access token
   Headers: `X-Domain: token.domain || apiDomain`, `Authorization: Bearer <poll-token>`,
   `X-No-User-Id: true`, `X-No-Enterprise-Id: true`, `User-Agent`.
   Business code `12151` = account not ready → keep polling.
   → `data: {uid, nickname, enterpriseId, type}`. Nickname usually empty →
   fall back to JWT `nickname` / `preferred_username`.
5. Credential assembled from token + account. `token_type` defaults `Bearer`.

## 3. Refresh

`POST /v2/plugin/auth/token/refresh`, headers:
`X-Domain: apiDomain`, `Authorization: Bearer <access_token>`,
`X-Refresh-Token: <refresh_token>`, `X-Auth-Refresh-Source: ide-main`,
`User-Agent`, plus `X-Enterprise-Id`/`X-Tenant-Id` when enterprise_id present.
Response `data` parsed identically to login token. `refresh_token` empty → not refreshable.
Terminal expiry: HTTP 401/403, business code 401/403, or message containing
`expired`/`invalid` → `RefreshTokenExpiredError` (stop, require re-login).

## 4. Model discovery

Priority:
1. `GET /console/enterprises/personal/models` (scoped catalog; for personal accounts
   scope literal is `personal`). Richest metadata.
2. `GET /v3/config` → `data.models[]`, `data.agents[]`, `data.modelPromotions[]`,
   `data.productFeaturesConfig.ModelTrialBanner.banners[].targetModelId`.
3. Merge union of both by id (scoped wins on conflict); apply promotions table.
4. Fall back to the static catalog (per-product) only when both fail.

Parser (`parseModelsFromConfig`) selects: `cli` then `craft` agent-referenced models first,
then remaining `data.models`, then trial-banner models. Filters out `auto`/`default`
aliases, `nes-`/`completion-`/`codewise-` prefixes, `supportsExtra`, `maxOutputTokens <= 256`,
and `text-to-image` tag. Metadata: `id`, `name`, `maxInputTokens`→contextWindow,
`maxOutputTokens`, `supportsImages`, `reasoning.supportedEfforts`,
`reasoning.defaultEffort`, `credits`→creditsRate, promotions→discountedCreditsRate.

## 5. Quota / credits

`POST /v2/billing/meter/get-user-resource` with `Authorization: Bearer <access-token>`, `X-Domain: apiDomain`,
`X-Product: SaaS`, `X-Product-Code: codebuddy`, `X-User-Id`, `X-Enterprise-Id`/`X-Tenant-Id`
(if present), `User-Agent`. Body `{}`.
Response: `data.Response.Data.Accounts[]` (**double nested**). Per package:
`PackageName`/`SubProductName`/`PackageCode`, `CapacityUnit`/`OriginUnit`,
`CycleCapacityRemain`(+`Precise`) = cycle remaining (IDE display figure),
`CycleCapacitySize`, `CycleCapacityUsed`, `Status` (3 = expired),
`ExpiredTime`, `DeductionEndTime` (ms — the real "when does this expire" field),
`CycleStartTime`, `CycleEndTime`. Total = sum of active packages' cycle remaining.
Checkin: `checkin-activity-status` (authoritative) + `daily-checkin`; code 10001/1001
= already claimed, 1002 = no qualification, 1003 = activity ended.

## 6. Chat + streaming

`POST /v2/chat/completions`, OpenAI Chat Completions protocol. Headers:
`Authorization: Bearer`, `Accept: text/event-stream`, `Content-Type: application/json`,
`X-Domain: apiDomain`, `X-Product-Code: codebuddy`, `X-Agent-Purpose: conversation`,
`X-IDE-Name`/`X-IDE-Type` = `CodeBuddy`, `X-IDE-Version: 1.106.1`, `X-Product: CodeBuddy`,
`User-Agent: CodeBuddyIDE/1.106.1`.

Request body: `{model, messages, stream:true, prompt_cache_key, tools?, temperature?,
stop?, max_tokens?, thinking?, reasoning_effort?}`.

Provider-specific:
- `prompt_cache_key` enables prefix cache (large cost difference).
- DeepSeek-family models: send `thinking: {type:'enabled'}` **and** `reasoning_effort`
  (reasoning_effort is the real switch; thinking alone is a no-op).
- `reasoning_effort` only sent when model declares that effort (else 400).
- `max_tokens` from caller → remote `maxOutputTokens` → fallback table; omitted if unknown.
- assistant messages always carry `reasoning_content` field (reasoning models 400 without).
- empty content + tool_calls ⇒ `content: null`.
- images inlined as `data:<mime>;base64,...` (only accepted form).

SSE response (standard OpenAI SSE): `delta.content`, `delta.reasoning_content`,
`delta.tool_calls[]` (`index`, `id` only on first fragment, `function.name`,
`function.arguments`), `choices[0].finish_reason`, `usage` (`prompt_tokens`,
`completion_tokens`, `prompt_tokens_details.cached_tokens`,
`completion_tokens_details.reasoning_tokens`, `prompt_cache_hit_tokens`, `credit`),
terminated by `data: [DONE]`. In-stream errors can appear as `data.error` (map to SERVER)
or as a top-level `{code,msg,displayMsg}` frame with no `choices` (content/security rejection).

## 7. Errors / retry / timeouts

- Transport errors: `terminated`, `UND_ERR_*`, `fetch failed`, `ECONNRESET`, `EPIPE`,
  `socket hang up` → retryable TRANSPORT.
- Rate limit: HTTP 429 always; else business `code 6004` (JSON top-level) or
  pattern `频率限制|频率超出|使用量已超出|重置|rate.?limit|frequency limit|usage exceeds|too many requests`.
  Reset time parsed from `将在|reset at <time> UTC±N`; fallback 1 hour.
- Auth: HTTP 401/403 (also code 403 / content rejection 11140 on 403 — account-level,
  handled by refresh + account switch).
- Timeouts: state request 10s; other control-plane 60s; stream has first-token timeout
  and per-chunk idle timeout (`readWithIdleTimeout`).
- HTTP status → code mapping: 401/403→AUTH, quota→QUOTA_EXCEEDED, 429→RATE_LIMIT,
  400→INVALID_REQUEST (context-window-exceeded special-cased), ≥500→SERVER.

## 8. Mapping to this Extension

This Extension is a **standalone process**. It does not use DSH `ctx.*`,
does not expose the account pool to a Gateway, and does not copy the Jet Hub
architecture. It speaks only the Gateway Extension Protocol v1 over HTTP/JSON/SSE.

Extension `account_id` is opaque (`wbcn_acc_<ulid>`). The upstream `uid`, nickname,
email, `enterprise_id` and all tokens stay inside the Extension and are never
returned through the protocol or written to logs.
