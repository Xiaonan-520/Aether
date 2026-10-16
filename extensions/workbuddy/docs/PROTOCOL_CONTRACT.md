# Phase 3 Extension Protocol contract (verified from Gateway source)

Source of truth (read-only audit): `/home/xiaonan/.mpag-p3/src/multi-provider-ai-gateway/src/protocol/extension/*.ts`,
`src/core/types.ts`, `src/core/errors/upstream-error.ts`, `src/core/registry/provider.ts`,
`src/service/login-service.ts`, `src/manager/{policy,api,extension-manager}.ts`.

The extension does **not** depend on the Gateway source at build/run time; this is a local copy of the contract.

## Endpoints

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/manifest` | — | `ExtensionManifest` |
| GET | `/health` | — | `{status, ...}` |
| GET | `/v1/accounts` | — | `{accounts: ExtensionAccount[]}` |
| GET | `/v1/accounts/:id` | — | `{account: ExtensionAccount}` |
| POST | `/v1/accounts` | `CreateAccountRequest` | 201 `CreateAccountResponse` |
| POST | `/v1/accounts/:id/refresh` | — | `{status, refreshed, error}` |
| POST | `/v1/accounts/:id/enable¦disable` | `{enabled:boolean}` | `{accountId, accepted, status}` |
| GET | `/v1/accounts/:id/quota` | — | `QuotaSnapshotV1` |
| POST | `/v1/accounts/:id/claim` | — | `{outcome: ClaimOutcome}` (success \| already_claimed \| not_available \| needs_auth \| needs_manual_action \| failed) |
| GET | `/v1/models` | — | `{models: ProtocolModelInfo[]}` |
| POST | `/v1/chat` | `ExtensionChatRequest` | `ChatResult` or SSE |
| POST | `/v1/actions/:actionId` | `{accountId?, payload?}` | `{actionId?, result}` |

Auth: `Authorization: Bearer $GATEWAY_EXTENSION_TOKEN` (health/manifest optional).

## Account status enum

`active | healthy_low_quota | rate_limited | token_expired | auth_failed | quota_exhausted | cooldown | disabled | needs_manual_action | pending`

## Error kinds

`AUTH_INVALID | TOKEN_EXPIRED | RATE_LIMIT | QUOTA_EXHAUSTED | TIMEOUT | TRANSPORT | UPSTREAM_5XX | TERMINAL | EMPTY_RESPONSE | NEEDS_CAPTCHA | NEEDS_MANUAL` + reserved `PROTOCOL_VIOLATION`.
Wire: `{error:{kind, message, httpStatus?, retryable?, retryAfterMs?, modelResetAtMs?, detail?}}`.

## Chat

- `ExtensionChatRequest = {...ChatRequest, tools?, accountId, model, requestId, deadlineMs}`.
  Core supplies `accountId` (extension must NOT choose), `requestId`, `deadlineMs`.
- `ChatRequest = {messages, model, stream, maxTokens?, temperature?, reasoningEffort?, tools?}`.
- `ChatChunk = {text, reasoning?, finishReason?: 'stop'|'length'|'tool_calls'|null, usage?:{promptTokens?,completionTokens?}, toolCalls?}`.
- `ChatResult = {content, reasoning?, finishReason: string, usage?:{promptTokens?,completionTokens?}}`.
- SSE, exactly ONE terminal frame: `event: chunk|done|error`.
  - `event: chunk` + `data: <ChatChunk>` (must carry `text: string`)
  - `event: done`  + `data: {"finishReason": "...", "usage"?: {...}}`
  - `event: error` + `data: {"error": {"kind": ..., "message": ...}}`
- Client disconnect ⇒ close upstream (AbortController).

## Login chain (verified)

- Core's local `buddy` provider uses the same China-site logic: `beginLogin` → `fetchAuthState`
  returns the **official** `authUrl` (no portal decoration) ⇒ `external-link` means "return the
  official login page URL".
- Remote: `POST /v1/accounts` `{accountId, loginMode, phone?}` → `201 {accountId, status:'pending',
  authorizationUrl, expiresIn, pollInterval}`.
- `RemoteProvider.auth.pollLogin` calls `GET /v1/accounts/:id`: `status==='active'` → done/success;
  `'auth_failed'` → done/fail; anything else → still pending.
- The extension advances its login state machine on each `GET /v1/accounts/:id`; no background loop;
  never returns a credential over the wire.

## Runtime / persistence

- `runtime.volumes:[{name:'state', mountPath:'/data'}]` → Manager volume `gw-ext-workbuddycn-state`.
- Manager injects `GATEWAY_EXTENSION_TOKEN`, `GATEWAY_EXTENSION_ID`.
- Enforced: no ports, cap_drop ALL, read-only rootfs, no-new-privileges, ≤512Mi/≤1cpu, `gw-ext-net`.

## Upstream error kind mapping (WorkBuddyCN)

| Internal condition | kind |
|---|---|
| upstream 401/403, refresh token terminal | `AUTH_INVALID` |
| credential expired, not refreshable | `TOKEN_EXPIRED` |
| upstream 429 / business code 6004 / reset text | `RATE_LIMIT` |
| credit balance exhausted | `QUOTA_EXHAUSTED` |
| first-token / idle timeout | `TIMEOUT` |
| network / DNS / connect / reset | `TRANSPORT` |
| upstream 5xx | `UPSTREAM_5XX` |
| 400 bad request / unsupported / malformed body | `TERMINAL` |
| empty upstream body | `EMPTY_RESPONSE` |
| official captcha challenge | `NEEDS_CAPTCHA` |
| human action required at upstream | `NEEDS_MANUAL` |
| protocol misuse (wrong shape/undeclared) | `PROTOCOL_VIOLATION` |
