# dsh-codearts-auth → 独立自托管 AI Gateway — 第一阶段源码审计报告

> 对象仓库：`https://gitee.com/iJetLi/deepseek-harness-codearts`（本地克隆于 `/workspace/deepseek-harness-codearts`）
> 参考：官方 `deepseek-harness`（`/workspace/deepseek-harness`）、`dsh-provider-auth`（早期快照，同源）、`dsh-provider-hub`（sidecar 架构参考）
> 方式：**只读审计**，未修改任何文件。所有结论均引用 `文件路径 → 函数/类/接口`。
> 版本信息：包 `dsh-codearts-auth@0.1.0`，TypeScript + ESM，Node ^22.19。

---

## 0. 一句话结论

原始项目 **不是** 一个可独立运行的 HTTP 服务，而是一个 **DeepSeek Harness 的 Cordis 插件**
（`@deepseek-ai/cordis`），core 只做「认证 + 上游适配 + 账号池 + 定时续期」，**没有 HTTP server、没有
OpenAI 网关层、没有独立持久化 schema、也没有 Docker**。但它内部的认证协议层、多账号账号池、续期
调度、积分/签到、以及 OpenAI 兼容序列化逻辑，**绝大部分可剥离出 DSH 直接复用**；需要从零写的是
「OpenAI-compatible HTTP 网关 → `/v1/models` `/v1/chat/completions` → 路由 → 账号池 → 上游」这整条链路。

---

## 1. 实际目录结构

```
deepseek-harness-codearts/
├─ package.json            # dsh-codearts-auth，Cordis 插件元信息（inject+peerDeps）
├─ pnpm-workspace.yaml     # pnpm 构建放行配置（esbuild）
├─ pnpm-lock.yaml
├─ cordis.patch.yml        # DSH bundle patch 描述（dsh.client ./client 入口）
├─ tsconfig.json / tsconfig.client-check.json
├─ vitest.config.ts / vitest.e2e.config.ts
├─ AGENTS.md (402KB)       # 大量真实缺陷记录 / 协议逆向文档（金矿，但非代码）
├─ README.md (130KB)       # 11 个 provider 的官方说明
├─ locale/{zh,en}.json     # 插件前端文案
├─ docs/  scripts/  tests/
├─ src/                    # ★ 服务端（宿主 Node 进程）实现，约 5.6 万行
├─ plugin-src/client/      # ★ Jet Hub 前端页面（设置页 UI：账号/积分/模型开关）
└─ tests/{unit,e2e,fixtures}
```

### src/ 按职责分组（对应问题 2）
| 职责 | 文件 |
|---|---|
| **入口/装配** | `src/index.ts`（`apply()`，注册全部 provider、账号池、定时器、RPC） |
| **CodeArts OAuth / 登录** | `src/login.ts`（`runOAuthFlow`/`runLoginFlow`/`startOAuthFlow`+本地回调服务器）、`src/oauth.ts`（PKCE+DPoP token 端点）、`src/service.ts`（`CodeArtsAuth`） |
| **token 获取 / refresh** | `src/oauth.ts`（`exchangeAuthorizationCode`/`exchangeRefreshToken`）、`src/service.ts:refreshAll` |
| **refresh 调度** | `src/refresh.ts`（`RefreshScheduler`）、`src/expiry-sync.ts` |
| **credential 持久化** | `@deepseek-ai/dsh-credentials`（`ctx.credentials`，本地落 `$DSH_HOME/.credentials.yaml`） |
| **CodeBuddy 登录** | `src/buddy-oauth.ts`（external-link-v2 轮询）、`src/buddy-auth.ts`（`BuddyAuth`）、`src/buddy.ts`（协议常量/凭据结构） |
| **WorkBuddy 登录** | 复用 `BuddyAuth`，仅 `product.ts:WORKBUDDY` 换 endpoint/UA/platform |
| **Provider 请求（上游适配）** | `src/llm-adapter.ts`（CodeArts）、`src/buddy-adapter.ts`、`src/cline-adapter.ts`、`src/loomy-adapter.ts`、`src/minimax-adapter.ts`、`src/raccoon-adapter.ts`、`src/qoder-adapter.ts`、`src/trae-adapter.ts`、`src/lobsterai-adapter.ts`、`src/zcode-adapter.ts` |
| **多账号管理** | `src/account-pool.ts`（`AccountPool`）、`src/jet-hub-store.ts`（持久化）、`src/jet-hub-rpc.ts`（RPC） |
| **账号切换** | `AccountPool.getAvailableAccount`（`account-pool.ts:698`）+ 各 adapter 内的 `switchAccountOnQuota` |
| **限流** | `src/account-pool.ts:updateModelRateLimit`、`sweepExpiredRateLimits`；错误分类在 adapter 内（如 `llm-adapter.ts:isAuthError/isQueueError/httpErrorCode`） |
| **失败重试** | `src/refresh.ts`、`src/sse.ts:readWithIdleTimeout`、各 adapter 的 stream 重试块 |
| **积分/签到** | `src/credits.ts`（buddy/workbuddy 签到/余额）、`src/codearts-credits.ts`（CodeArts 签到）、`src/sign.ts`（华为 HMAC 签名）、`src/loomy-credits.ts`/`qoder-credits.ts`/`trae-credits.ts` 等 |
| **模型列表** | `src/models.ts`（CodeArts 远端拉取+磁盘缓存）、`src/product.ts`（buddy/workbuddy 兜底目录）、各 `*-product.ts` |
| **DSH 与 Provider 的接口** | `LlmAdapter`（`@deepseek-ai/dsh-llm`）+ `src/llm-adapter.ts:CodeArtsAdapterOptions`（五个注入点） |
| **共享协议工具** | `src/openai-compat.ts`（OpenAI 序列化+SSE+错误归类）、`src/sse.ts`、`src/message-shape.ts` |
| **Jet Hub RPC / 前端** | `src/jet-hub-rpc.ts`、`src/jet-hub-store.ts`、`plugin-src/client/*` |


---

## 2. 核心数据结构（对应问题 3）

> 原项目**没有统一 `Account` 类**，也不同时存在你列的 `Credential/Token/Quota/RateLimit` 独立类型——
> 真实分层如下：

### 2.1 账号池索引 —— `ProviderAccountEntry`（`src/types.ts`）
发消息/切换/UI 只读这一层，**不含 secret**。
```ts
interface ProviderAccountEntry {
  id: string            // "{provider}-{shortid}"，如 codearts-a1b2c3d4
  provider: string      // codearts | buddy | workbuddy | ...
  nickname: string
  enabled: boolean      // 停用不参与自动选号（但仍参与续期/签到）
  credentialRef: string // "CODEARTS_ACCOUNT_XXX" —— 指向 credentials store 的 key
  createdAt: number
  expiresAt?: number    // 展示用（易陈旧！见 expiry-sync 的缺陷记录）
  refreshable: boolean
  modelRateLimits?: Record<string, number>   // ★ 每模型的限流重置时刻
  traeCheckinDeviceGeneration?: number        // 仅 trae
}
```
### 2.2 凭据（secret）—— 真正的 token 载体
- `CodeArtsCredential`（`src/types.ts`）：`access_key_id/secret_access_key/security_token/expires_at/refresh_token/code_verifier/dpop_private_key_jwk/model_rate_limits`。
- `BuddyCredential`（`src/buddy.ts:109`）：`access_token/refresh_token/expires_at/refresh_expires_at/domain/scopes/device_id` 等。
- 每个 provider 一个凭据类型（`loomy.ts`/`qoder.ts`/`trae.ts`/`cline.ts`…），存于 `ctx.credentials`（JSON 字符串）。
### 2.3 存储 key
- 账号池索引 & 模型黑名单 → `$DSH_HOME/jet-hub/state.json`；锁定表 → `$DSH_HOME/jet-hub/permanent-locks.json`。
- 凭据 → `$DSH_HOME/.credentials.yaml`（`dsh-credentials-local`）。
- 模型缓存 → `~/.cache/deveco/codearts_models.json` 等。
### 2.4 限流
没有独立类型——用 `ProviderAccountEntry.modelRateLimits: Record<modelId, resetAtMs>`（滚动窗口），无令牌桶全局计数。
### 2.5 Quota / 积分
`src/credits.ts`：`CheckinStatus`、`ClaimOutcome`（`claimed|already-claimed|inactive|failed`）、`CreditBalance`、`CreditPackage`（含 `expiredTime`）。仅影响 UI 展示与「锁定永久积分」选号策略，**不参与发消息拦截**。
### 2.6 Token
无 `Token` 抽象——就是上面的 `CodeArtsCredential`/`BuddyCredential`，由适配器直接使用。

> ⚠️ 设计启示：原项目把「索引层（元信息）」和「secret 层（credentials store）」**刻意分离**，
> 这正好是你第二阶段独立 Account Manager 的天然模型，但原项目没有 `status/last_used_at/last_error/cooldown`
> 这些字段——需要新增（见第 8 节）。

---

## 3. 实际调用链（对应问题 4）

### 3.1 CodeArts 发消息（真实链路，非猜测）
```
客户端对话框
→ dsh-llm 路由到 CodeArtsAdapter
→ CodeArtsAdapter.stream()  (src/llm-adapter.ts)
→ options.resolveCredential()   [index.ts:240 → pool.getAvailableAccount('codearts','')]
→    AccountPool.getAvailableAccount (src/account-pool.ts:698)
→    readAccounts() 过滤 enabled + 限流豁免
→    ctx.credentials.resolve(CredentialRef)   ←从中取 secret
→ 过期? → options.refresh()  [index.ts:249 → service.refreshAccountCredential → exchangeRefreshToken]
→ 组装 chat-completions（serializeMessages/message-shape/openai-compat）
→ POST https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/... （HMAC sign, src/sign.ts）
→ 401/403 → isAuthError → refresh 一次 → 重试
→ 排队/限流 → updateModelRateLimit → getAvailableAccount(换号,exclude) → 退避轮询 QUEUE_STATUS
→ SSE 消费（src/sse.ts / openai-compat.ts）→ StreamChunk → 回传给 dsh-llm
```

### 3.2 登录（CodeArts）
```
startOAuthFlow (src/login.ts:393)
→ 本地起 HTTP server on 127.0.0.1 随机端口 (startOAuthCallbackServer)
→ openBrowser(buildOAuthLoginUrl)  → 华为 portal /portal/authorize
→ 用户浏览器授权 → 回跳 http://127.0.0.1:<port>/oauth/callback?code=...
→ exchangeAuthorizationCode → PKCE + DPoP → STS https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens
→ credentialFromTokenResponse → ctx.credentials.set → accountPool.addAccount
```

### 3.3 定时续期（后台 worker）
```
index.ts 定时器 (每 30 分钟, REFRESH_INTERVAL_MS)
→ refreshAllCredentials() → 13 组 [provider, refreshAll(pool)]
→ 各 Auth.refreshAll → refreshAccountWithReconcile (src/expiry-sync.ts)
→   shouldRefreshNow(距过期≤1h) ? 发 refresh : 只对账
→   exchangeRefreshToken → ctx.credentials.set → 回写账号池 expiresAt
```

### 3.4 CodeBuddy 登录（external-link-v2 轮询，src/buddy-oauth.ts）
```
POST /v2/plugin/auth/state?platform=ide → {state, authUrl}   (buddy-oauth.ts:134)
openBrowser(authUrl)
GET  /v2/plugin/auth/token?state=…  轮询 1s，code 11217=未就绪，5min 超时 (buddy-oauth.ts:170)
GET  /v2/plugin/login/account?state=… 取账号 (buddy-oauth.ts:225)
     → BuddyToken → ctx.credentials.set → pool.addAccount
刷新: POST /v2/plugin/auth/token/refresh (X-Refresh-Token 头)
```

---

## 4. 与 DeepSeek Harness 的耦合点（对应问题 5）

> 审计目标：区分 **A 可复用** / **B 仅 DSH 插件内可用** / **C 可抽象库** / **D 需重写**。

### A. 可直接复用的 Provider/协议逻辑（几乎零 DSH 依赖，纯协议+标准库+jose）
- `src/oauth.ts`（CodeArts OAuth2+PKCE+DPoP+refresh token 端点）★
- `src/login.ts` 的 `buildOAuthLoginUrl/buildPortalLoginResultUrl/buildLoginUrl/generateRandomSecret`
- `src/sign.ts`（华为 SDK-HMAC-SHA256 签名，纯 WebCrypto）★
- `src/buddy.ts`、`src/buddy-oauth.ts`（CodeBuddy/WorkBuddy 全部 API 常量、登录/刷新/模型/签到端点）★
- `src/credits.ts` + 各 `*-credits.ts`（签到/余额接口）★  ← 但 `CheckinStatus/ClaimOutcome` 结构可移植
- `src/refresh.ts`（`RefreshScheduler` 重试语义）★、`src/expiry-sync.ts`（lead-time 对账逻辑）★
- `src/models.ts`（远端模型拉取+JSON 提取+磁盘缓存）
- `src/sse.ts`、`src/openai-compat.ts`、`src/message-shape.ts`（OpenAI 序列化/SSE/错误归类）★  ← C 类最佳候选

### B. 只能在 DSH 插件中工作的代码
- `src/index.ts` 的整个 `apply()`（`ctx.provide/inject/ctx.effect`、`SettingsForms`、`registerConfigurableProviders`）
- `registerXxxLlm(ctx,…)`（依赖 `@deepseek-ai/dsh-llm` 的 `LlmAdapter`/`StreamChunk`/`LlmError`）
- adapter 里所有 `new LlmError(..., code)`（DSH 错误码体系，如 `MISSING_CREDENTIAL/QUEUE/TRANSPORT`）
- `@deepseek-ai/dsh-credentials` 的 `credentialRef/ctx.credentials`（代码直接 import）
- `settings-compat.ts`、`plugin-src/client/*`（Jet Hub UI）

### C. 可抽象成独立 library 的代码
- `AccountPool`（`account-pool.ts`）——依赖 `ctx.credentials` 与 `JetHubStore` 两个 seam，换成自主 credential 接口即可独立。
- `RefreshScheduler`/`refreshAll`/`expiry-sync` —— 已是纯逻辑，只需注入 credential 读写。
- `openai-compat.ts`/`sse.ts`/`message-shape.ts` —— 纯协议，零 DSH 依赖。
- `sign.ts`/`oauth.ts`/`buddy-oauth.ts`/`credits.ts` 各协议模块。

### D. 必须重写成 Gateway HTTP API 的代码
- **OpenAI-compatible HTTP 服务器**（`/v1/models`、`/v1/chat/completions`、流式 SSE、`/v1/responses`）——原项目完全没有。
- **Model Router**（model id → provider → 账号池）——原项目靠 dsh-llm 的路由，需自己写。
- **账号池的并发安全 / HTTP 请求级生命周期**——原项目是进程内单实例服务，无 HTTP 并发语义。
- **独立持久化（SQLite/JSON）**——替换 `$DSH_HOME/jet-hub/state.json` + `.credentials.yaml`。
- **Quota 拦截策略**——原项目 quota 只做展示/锁定补贴，不做"额度耗尽拒绝请求"。


---

## 5. 依赖与运行时（对应问题 6）

`package.json` 明确反映 DSH 插件生态：

| 依赖 | 类别 | Gateway 需要吗 |
|---|---|---|
| `@deepseek-ai/cordis` | **插件框架核心**（依赖注入/服务/生命周期） | ❌ 替换成自己的运行时（Node HTTP/Express/Fastify） |
| `@deepseek-ai/dsh-credentials` | credential 密封 seam | ❌ 但**移植其设计**到 SQLite |
| `@deepseek-ai/dsh-llm` | LLM provider 接口（LlmAdapter/LlmError/StreamChunk） | ❌ 替换成自主 `Provider` 接口 |
| `@deepseek-ai/dsh-commands` | 斜杠命令 | ❌ |
| `@deepseek-ai/schemastery` | 配置 schema | ❌ |
| `@deepseek-ai/cosmokit` | 工具 | ❌ |
| `jose` | JWT/DPoP 签名 | ✅ **保留**（OAuth/DPoP/refresh 需要） |
| `node:crypto` / WebCrypto | 内置 | ✅ 保留 |
| `cross-env/esbuild/tsx/typescript/vitest` | 构建/测试 | ✅ dev |
| `${DSH_HOME}/.credentials.yaml + chokidar + yaml + atomic-write` | 在官方 harness 里（认证方） | ❌ 换 SQLite |

> **删除面**：Cordis 全家、dsh-* 全部、Jet Hub UI、qoder wasm（若不用 qoder）。
> **保留面**：`jose`、所有纯协议模块、`openai-compat/sse/message-shape`。

---

## 6. credential/token 存储方式（对应问题 7）

审计结论：
- **token 写磁盘**：是。凭据 JSON 写入 `$DSH_HOME/.credentials.yaml`（`dsh-credentials-local`），账号索引写 `$DSH_HOME/jet-hub/state.json`，锁定表写 `permanent-locks.json`，模型缓存写 `~/.cache/deveco/*.json`。
- **依赖 DSH_HOME**：是——所有持久化都挂在 `$DSH_HOME` 下（路径由 `@deepseek-ai/dsh-home-paths` 解析）。
- **依赖 DSH credential store**：是（`ctx.credentials` 就是那个 seam 的抽象）。
- **能否迁移 SQLite**：**可以**。凭据本质是 `ref → JSON string`，账号索引是 `Record` 数组——两个表即可表达。`AccountPool` 的读改写是以 `JetHubStore` 接口隔离的（`jet-hub-store.ts:createJetHubStore`），换后端只需实现同接口；`ctx.credentials` 也需替换为同语义 provider。
- **可用 Docker volume**：可行——把 SQLite 文件挂到 `/data`。
- **明文 secret 风险**：**有**。token 明文 JSON 直接落盘（无加密）。备份导出 `BackupPayload.credentials` 也是明文 JSON 原文字符串（`plugin-src/client/backup-crypto.js` 做客户端侧可选加密，但服务端默认明文）。→ 目标：服务端加密 at rest + 权限收紧。
- **token refresh 是否需要浏览器**：**不需要**（凭据带 refresh_token/PKCE/DPoP 即可静默续期，见 `RefreshTokenExpiredError`/`exchangeRefreshToken`）；**只有"首次登录"需要浏览器**（CodeArts portal、CodeBuddy external-link、WorkBuddy）。
- **多账号状态持久化**：是，`state.json` + `.credentials.yaml` 已支持多账号（不同 `credentialRef`）。

---

## 7. 多账号池分析（对应问题 8）

### 原项目已实现
- 多账号 CRUD、启停用、拖拽排序（`AccountPool.*`，`account-pool.ts`）。
- 自动选号：`getAvailableAccount(provider, modelId, exclude?)`（`account-pool.ts:698`）——filter `enabled=true` + **排除限流中的模型** + 手动顺序优先 + 逐账号解析凭据。
- 每模型滚动窗口限流：`updateModelRateLimit` / `sweepExpiredRateLimits`。
- 批量续期（含停用账号）：`refreshAll`（各 Auth 类）。
- 积分领取遍历全部账号（停用也参与）：`credits` 侧。
- 按凭据身份反查账号：`findAccountIdByCredential`。

### 原项目**没有 / 需重新设计**
- **HTTP 请求级并发安全**：原池是单进程内存权威副本 + 读改写，靠 `modifyRecord` 做跨进程 token 刷新锁；Gateway 需要锁 + 原子状态机。
- **状态字段缺失**：
  - `status`（启用/冷却/禁用/credential 失效）→ 目前仅 `enabled` + `refreshable`。
  - `last_used_at`、`last_error`、`cooldown_until`（失败冷却）→ **没有**，需新增。
  - `quota`（额度快照）→ 只有 Loomy/buddy/qoder 等有 `CreditBalance`，且不拦截。
- **失败分类与换号策略**：adapter 内各自实现（`switchAccountOnQuota`/`exclude` 集合），未统一定义"可重试/可换号/终态"。
- **Cooldown（冷却期）**：原项目只有 `modelRateLimits`（按模型），**没有账号级全局冷却**。

> 建议：基于原 `AccountPool` 语义，新增 `status/cooldown/lastError/quota` 字段与状态机（第 8 节设计）。

---

## 8. 错误处理审计（对应问题 9）

原项目错误处理**分散在各 adapter**，但共享一套语义函数：

| 场景 | 原项目行为 | 位置 |
|---|---|---|
| HTTP 401/403 | `isAuthError(status===401/403)` + CodeArts `APIG.0602` → **refresh 一次→重试一次**；仍失败抛 `LlmError('AUTH')` | `llm-adapter.ts:357` |
| HTTP 429 | `httpErrorCode→'RATE_LIMIT'`；`isQueueError`(400+81111) / `isSseQueueErrorCode`(/429|限流|TPM/) → **换号/退避** | `llm-adapter.ts:402,369` |
| token expired | `stream()` 开头 `Date.parse(expires_at)<=now → refresh()`；refresh 后仍无凭据抛 `MISSING_CREDENTIAL` | `llm-adapter.ts:865` |
| refresh failed（终态） | `RefreshTokenExpiredError` → 停止调度、`refreshable=false`、提示重登 | `refresh.ts:isRefreshTokenExpired`、`oauth.ts` |
| quota exhausted | **只影响显示/锁定补贴，不拦截**；部分 provider 有 `switchAccountOnQuota` | `qoder-adapter` 等 |
| upstream timeout | `readWithIdleTimeout`（首 token/分块空闲超时）→ 抛可重试 `TIMEOUT` | `sse.ts` |
| network error | `isAbnormalNetworkError`（fetch failed/ENOTFOUND/ECONNREFUSED）→ 更快重试间隔 | `refresh.ts` |
| provider unavailable | 属于上层 `LlmError('TRANSPORT'/'UNKNOWN')`，由 dsh-llm 决定重试 | adapter + `openai-compat.ts` |
| 排队（业务级） | `QUEUE_STATUS_BASE` 轮询 + 指数退避，30min 上限 | `llm-adapter.ts:259` |

> ⚠️ **原项目无统一错误归一化层**（各 adapter 各写一套），这是 Gateway 必须新增的：一个 `UpstreamError` 分类器（按 HTTP 状态 + 业务码 + 网络类），统一驱动「retry / refresh / cooldown / switch-account / fail」。

---

## 9. 积分/签到审计（对应问题 10）

> 全部是平台允许的正常能力：每日签到 / 领取赠送积分 / 查余额。**不涉及验证码绕过或越权**。

| provider | 机制 | 认证 | 是否每日 | 幂等/重复保护 | 失败重试 |
|---|---|---|---|---|---|
| **CodeArts** | `GET /snap-manager/v1/statistics/plugin` + `GET /v1/ops/delivery?channel=IDE` + `POST /v1/ops/claim` + `POST /v1/ops/confirm` | **SDK-HMAC-SHA256 签名**（`sign.ts`，用现有 AK/SK/SecurityToken） | 是（`USER_LOGIN` 类型） | 幂等业务码（已有 `already` 判定） | 模块内不重试，靠 RPC 手动 |
| **CodeBuddy** | `POST /v2/billing/meter/checkin-activity-status` + `POST /v2/billing/meter/daily-checkin`；余额 `GET /v2/billing/meter/get-user-resource` | Bearer access_token（`checkinHeaders` 用 BuddyCredential） | 是 | 幂等：重复领取 HTTP 400 + code 10001（"今日已签到"） | `ClaimOutcome` 分类，不自动重试 |
| **WorkBuddy(国际版)** | **只有积分余额查询**，**无每日签到**（README 明示：国际版内核没有 `checkin-status`/`daily-checkin`） | Bearer access_token | 否 | — | — |
| Qoder | 每日 100 Credits，UTC+8 10:00 刷新，加密推理端点 |「每日领取」 | 是 | 幂等 | — |
| Loomy | 每日额度签到 + 新手任务一次性 10000 积分 + 锁定永久积分 | 短信/微信 | 是 | 任务一次性 | — |

**重要**：
- 认证全部**不需要 Cookie/CSRF**，只用 OAuth access_token 或 AK/SK 签名（HTTP-only 即可无头执行）——**可以安全地从 background worker 抽出来**。
- 原项目「一键领取」通过 `jet-hub-rpc.ts` 的 RPC 手动/轮询触发，**没有纯后台自动每日签到**（有 RPC 端点 + 手动按钮）；若你要新增「定时自动签到」，需自己加 crontab 式调度（原项目无）。
- `codearts-credits.ts:33` 明确写了认证方式表，确认签到用**签名而非 Cookie**（这是个可复用的关键结论）。


---

## 10. 可复用 vs 必须重写清单（对应交付项 8/9）

### ✅ 可直接复用（C 类可抽库，几乎零改动）
| 模块 | 说明 |
|---|---|
| `src/oauth.ts` | CodeArts OAuth2+PKCE+DPoP+refresh —— 纯逻辑，仅需 `jose` |
| `src/sign.ts` | 华为 SDK-HMAC-SHA256 签名 |
| `src/buddy.ts` + `src/buddy-oauth.ts` | CodeBuddy/WorkBuddy 全部 API（登录/刷新/模型/签到/余额） |
| `src/refresh.ts` + `src/expiry-sync.ts` | 定时刷新调度 + lead-time 对账（需注入 credential 读写） |
| `src/credits.ts` + 各 `*-credits.ts` | 积分/签到客户端 |
| `src/openai-compat.ts` + `src/sse.ts` + `src/message-shape.ts` | OpenAI 消息序列化/SSE/错误归类（**可封装成独立库 `@gw/openai`**） |
| `src/models.ts` | 远端模型拉取 + JSON 提取 + 缓存 |

### ⚠️ 需改造复用（去掉 DSH 依赖，改接口）
| 模块 | 改造点 |
|---|---|
| `src/account-pool.ts` (`AccountPool`) | 把 `ctx.credentials` / `JetHubStore` 换成自主 credential + SQLite repository |
| `src/llm-adapter.ts` / 各 `*-adapter.ts` | `LlmAdapter`/`LlmError`/`StreamChunk` → 自己的 `Provider` 接口；错误码换成自己的分类 |
| `src/buddy-auth.ts` / `service.ts` | 去掉 `Service/cordis`，保留登录/刷新/签到编排 |
| `src/jet-hub-store.ts` | 保留 schema 语义，后端换 SQLite/JSON |

### ❌ 必须重写（原项目完全没有）
1. **OpenAI 兼容 HTTP 网关**：`GET /v1/models`、`POST /v1/chat/completions`（+SSE 流式）、可选 `/v1/responses`。
2. **Model Router**：`modelRegistry(modelId → providerId)` + 每 provider 模型目录并入。
3. **请求级并发安全**：账号池加锁、原子状态机。
4. **Quota 拦截**（若需要"余额耗尽自动拒发"）。
5. **独立持久化层（SQLite）+ 多容器部署 + Docker 全链路**。
6. **错误归一化层**（统一 UpstreamError 分类驱动 retry/refresh/cooldown/switch）。
7. **账户管理 API**（原项目只有 Jet Hub 前端 RPC，无公开 REST）。

---

## 11. 推荐的 Gateway 架构（对应第二阶段）

```
                 ┌────────────────────────────────────────┐
   Client       │              Gateway (Node/TS)          │
   HTTP API ───▶│  OpenAI-compat HTTP server (/v1/*)       │
    /v1/models  │        ┌──────────────────────────────┐  │
    /v1/chat    │  ───▶  │ Model Router                 │  │
                │        │  modelId → providerId → pool  │  │
                │        └───────────┬──────────────────┘  │
                │        ┌───────────▼──────────────────┐  │
                │        │ Provider Router + Account Pool│  │
                │        │ (health/cooldown/ratelimit)   │  │
                │        └───────────┬──────────────────┘  │
                │        ┌───────────▼──────────────────┐  │
                │        │ Provider Adapter             │  │
                │        │ (Authenticate/Refresh/Chat/  │  │
                │        │  ListModels/GetQuota/Claim)  │  │
                │        └───────────┬──────────────────┘  │
                │        ┌───────────▼──────────────────┐  │
                │        │ Credential + Token Store     │  │
                │        │ (SQLite, /data, at-rest enc) │  │
                │        └──────────────────────────────┘  │
                │   Background worker: refresh-loop,       │
                │   quota/checkin scheduler, rate-sweeper   │
                └────────────────────────────────────────┘
                                     │
                         CodeArts / CodeBuddy / WorkBuddy / 其他 upstream
```

### MVP（第一阶段可跑通，不多做）
- Node + TS，HTTP 用 **Fastify**（或原生 http）实现 `GET /v1/models`、`POST /v1/chat/completions`（支持 SSE 流）。
- 持久化用 **SQLite**（better-sqlite3，WAL，单文件挂 `/data`）。
- Provider：先收敛到 **CodeArts 一个**打通端到端，再横向加 CodeBuddy/WorkBuddy（因为他们的协议模块已就绪）。
- 复用：`oauth.ts`/`sign.ts`/`buddy-oauth.ts`（协议）、`openai-compat.ts`（序列化）、`refresh.ts` 语义（调度）。
- 新写：`modelRegistry.ts`、`accountStore.ts`、`gateway.http.ts`、`errorClassifier.ts`。

---

## 12. 推荐的目录结构（对应交付项 11）

```
gateway/
├─ package.json / tsconfig.json
├─ Dockerfile / docker-compose.yml / .env.example / README.md / LICENSE
├─ src/
│  ├─ server/            # HTTP 网关
│  │  ├─ index.ts        # bootstrap
│  │  ├─ routes/models.ts / routes/chat.ts / routes/responses.ts(可选)
│  │  ├─ sse.ts          # SSE 响应封装
│  │  └─ openai-compat/  # 消息序列化 + 错误归类（从 openai-compat.ts/sse.ts 移植）
│  ├─ core/
│  │  ├─ provider/       # Provider 接口 + 各 adapter（codearts/buddy/workbuddy/…）
│  │  ├─ router/         # ModelRouter / ProviderRouter
│  │  ├─ pool/           # AccountPool + 状态机 + 冷却
│  │  ├─ errors.ts       # UpstreamError 归一化
│  │  └─ worker/         # refresh-loop / checkin-scheduler / rate-sweeper
│  ├─ store/
│  │  ├─ db.ts           # SQLite 连接
│  │  ├─ accounts.ts     # account/credential 表
│  │  ├─ models.ts       # 模型目录缓存
│  │  └─ crypto.ts       # at-rest 加密
│  └─ providers/         # 移植：oauth.ts / sign.ts / buddy-oauth.ts / credits.ts …
└─ .github/workflows/    # build-push ghcr
```

---

## 13. 第一阶段应改哪些文件 + 风险（对应交付项 12/13）

> 注意：现在是**审计阶段，不实际改**。下面列出"一旦进入实现、从哪开始"的优先级。

| 优先级 | 动作 | 风险 |
|---|---|---|
| P0 | 新建 repo/gateway 骨架（server+store+provider 接口），**不动原仓库** | 无（绿地） |
| P0 | 移植 `oauth.ts`/`sign.ts`/`buddy-oauth.ts`/`openai-compat.ts`/`message-shape.ts` 为内部库 | 低：纯协议，需补单测对拍 |
| P1 | `AccountPool` 去 DSH 化 → 用自己的 `AccountStore`（SQLite） | 中：并发/lock 语义要重建 |
| P1 | `refresh.ts`/`expiry-sync.ts` 改成注入 credential+store | 低 |
| P2 | 写 ModelRouter + `/v1/chat/completions` + SSE | 中：OpenAI 边界细节 |
| P2 | 写错误归一化 + 换号/冷却状态机 | 中 |
| P3 | CodeBuddy/WorkBuddy adapter 接进 Provider 接口 | 低（协议已就绪） |
| P3 | Worker：自动签到/余额刷新 | 低 |

**主要风险**
- R1 并发安全（跨进程 token 刷新锁）——原项目靠 DSH `modifyRecord`，需自行实现 DB 事务/锁。
- R2 首次登录依赖浏览器 → Docker 场景要暴露登录链接（QR / DEVICE code / auth URL），不能真开浏览器。
- R3 上游协议是逆向自 IDE 客户端，可能随平台演进失效（风险在 upstream，非我们的代码）。
- R4 CodeArts 本地回调服务器绑定 `127.0.0.1`（`login.ts`）——Docker 内跑 HTTP 授权回调要设计成"remote 登录 + 轮询"模式。
- R5 明文 secret → 必须 at-rest 加密 + `/data` 权限 + 不写镜像。

---

## 14. 需要你确认的设计决策（对应交付项 14）

1. **技术栈**：Node+TS（复用原代码最省）？还是 Go？（dsh-provider-hub 是 sidecar JS。推荐 Node+TS 最大化复用。）
2. **HTTP 框架**：Fastify / Express / 原生 http？（推荐 Fastify，SSE 好处理。）
3. **持久化**：SQLite（better-sqlite3, WAL）是否接受？还是想 YAML/JSON 简单起步？
4. **Provider 取舍**：MVP 先只做 **CodeArts**，还是三个平台（CodeArts / CodeBuddy / WorkBuddy）一起？原项目还有 qoder/trae/cline/loomy/raccoon/lobsterai/minimax/zcode——是否都要，还是只保留你点名的 3 个？
5. **每日签到自动执行**：是否需要后台 worker 实现"每日自动签到"（平台允许的正常签到）？原项目只有手动 RPC，无自动调度。
6. **Quota 拦截**：是否需要"余额耗尽自动拒绝请求"并切号？还是仅提供余额查询+手动开关？（原项目不作拦截。）
7. **OpenAI 范围**：MVP 只要 `/v1/models` + `/v1/chat/completions`（流式）？`/v1/responses` 是否要？工具调用/图片输入是否首批支持？
8. **登录流程（Docker 关键）**：接受"首次登录 = 生成登录 URL/设备码 → 用户在浏览器完成 → 网关后台轮询 token"这种 no-browser 模式吗？（这是把浏览器登录搬进 Docker 的推荐方式。）
9. **Token at-rest 加密**：需要服务端加密（如用 env secret 派生的 key 加密 SQLite 里的 token）吗？默认建议开启。
10. **对外暴露**：是否要给 `/v1` 网关加 API key 鉴权（客户端→网关的密钥）？
11. **GHCR/发布**：镜像名、是否同时支持 arm64/amd64、版本标签策略。

---

## 附：一手依据（供复核）
- 全部结论基于对 `/workspace/deepseek-harness-codearts/src` 的读取，未使用推测。
- 登录均为 `openBrowser()` + 本地/轮询回调，无 Cookie 触达（签到用签名/Bearer）。
- `$DSH_HOME/.credentials.yaml` 落盘由 `@deepseek-ai/dsh-credentials-local` 证实（`packages/credentials/credentials-local/src/index.ts`）。
- 多账号续期、含停用账号刷新、lead-time 过滤：`expiry-sync.ts:refreshAccountWithReconcile`、`index.ts:refreshTargets`。

---
*报告完。下一步：等你确认第 14 节的决策清单后，再进入第二阶段（MVP 设计）与实现。*
