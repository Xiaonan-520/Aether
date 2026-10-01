# Multi-Provider AI Account Gateway — 第二阶段设计（只读 · 未写代码）

> 在完成第一阶段审计（`AUDIT_REPORT.md`）后，针对你重新定义的最终目标输出本篇 16 项设计。
> **本文件是设计稿，不含实现代码；任何动手前需你确认。**

## 0. 定位修正（按你的最新要求）

最终产物是 **Multi-Provider AI Account Gateway**（不是 "CodeArts proxy"），对外只有一个
OpenAI-compatible 入口 `http://server:8080/v1`，对内承载原项目数得出的 **13 个 provider 路由**
中的全部可继承资产。Provider **插件化**，账号池**跨 provider 统一**，Token/Quota/Credits/限流/
故障转移全部集中在 Gateway。**ZCode 视为一等公民**（你正在使用）。

---

## 1. 全 Provider 能力矩阵（对应交付项 1）

> 依据：逐文件审计。`√`=已实现/可复用；`⭘`=需改造成 Gateway；`✗`=无/不可自动；`⚠`=有风险。

| Provider | 登录方式 | Token 生命周期 | Chat | Stream | Models | Quota | Credits(签到) | 多账号 | Refresh | 上游 Base | 协议输出 | Docker 难度 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **codearts** | 浏览器 OAuth＋PKCE＋DPoP | AK/SK/STS(~2h)＋`refresh_token` 静默续期 | √ | √ | √远端+静态 | √ | √(HMAC 3步) | √ | √ | `snap-access.cn-north-4.myhuaweicloud.com` | OpenAI Chat | ⚠本地回调服务器 |
| **buddy**(CodeBuddy) | external-link-v2 轮询(浏览器) | `access_token`＋`refresh_token` | √ | √ | √远端+兜底 | √余额 | √每日签到+锁永久 | √ | √ | `copilot.tencent.com` | OpenAI Chat | 浏览器(可改 no-head) |
| **workbuddy** | 同上(换 endpoint) | 同上 | √ | √ | √远端+兜底 | √余额 | ✗无签到(仅余额+锁永久) | √ | √ | `www.workbuddy.ai` | OpenAI Chat | 浏览器(可改) |
| **lobsterai** | 本地回调+authCode | `refresh_token` | √ | √ | √ | √ | √签名 | √ | √ | `lobsterai-server.youdao.com` | OpenAI Chat | ⚠本地回调 |
| **qoder**(国际) | PKCE 设备码 | `access_token`＋`refresh_token`(需`machine_id`) | √ | √ | √ | √每日100 | √每日100 | √ | √ | `openapi.qoder.sh`/`api2-v2.qoder.sh` | OpenAI Chat | ⚠WASM 请求体加密 |
| **qodercn**(中国) | 同上 | 同上 | √ | √ | √ | √ | √ | √ | √ | `qoder.cn`/`gateway.qoder.com.cn` | OpenAI Chat | ⚠WASM 加密 |
| **trae** | OAuth(ExchangeToken 轮换) | `refresh_token` 轮换＋`machine_id/device_id` | √ | √ | √ | √ | √签到(device轮换) | √ | √ | `trae-api-cn.mchost.guru`/`api.trae.cn` | OpenAI Chat | 浏览器 |
| **cline** | WorkOS 设备码 | Bearer `workos:<jwt>`＋refresh | √ | √ | √远端(/api/v1/models) | √ | √ | √ | √ | `api.cline.bot` + `api.workos.com` | OpenAI Chat | 浏览器 |
| **loomy** | 短信验证码 / 微信 | `access_token` **✗不可续期** | √ | √ | √ | √两池 | √签到+新手任务+锁永久 | √ | ✗(只探测有效性) | `loomyad.xunfei.cn/api/v1`+`account.xfinfr.com` | OpenAI Chat | ⚠短信验证码(需人工) |
| **raccoon** | 本地回调弹窗 | `refresh_token` 轮换 | √ | √ | √ | √ | √ | √ | √ | `xiaohuanxiong.com` | OpenAI Chat | ⚠本地回调 |
| **minimax** | OAuth 设备码＋PKCE | `refresh_token` grant | √ | √ | √ | √ | √签到 | √授权轮换 | √ | `agent.minimax.cn`/`account.minimax.cn` | **Anthropic Messages** | 浏览器 |
| **zcode** | **读官方客户端磁盘凭据**(自动解密) | **✗ZCODE_REFRESHABLE=false 不可刷新** | √ | √ | √(client/configs) | √balance | √claim+激活上报 | √ | ✗(静态凭据+回写) | `zcode.z.ai` | **Anthropic Messages** | ⚠⚠⚠**每请求产 Aliyun captcha,需浏览器/headful** |
| **zcode(备) workbuddy-connect 参考** | 读桌面 App 签名 | refresh 自存副本 | 仅serveloop | √ | √ | √billing | — | — | √ | `copilot.tencent.com`(WorkBuddy) | OpenAI Chat(loopback) | 桌面依赖 |

> 另注：原项目 README 与 index 实际注册 provider 共 13 个（含 qodercn），能力矩阵已全列，无省略。

---

## 2. Provider 分级（对应交付项 2 · 按技术完成度，非重要性）

| Tier | 定义 | Provider | 说明 |
|---|---|---|---|
| **Tier 1** | 可几乎零改抽离，DSH 依赖最薄 | `oauth.ts`/`sign.ts`/`buddy-oauth.ts`/`openai-compat`/`sse`/`refresh`/`expiry-sync` 下对应的 **protocol modules** | 纯协议库 |
| **Tier 1a** | provider 本身可较快接入 Gateway | **codearts、buddy、workbuddy、cline、minimax、raccoon** | 认证/续期/协议齐全，多账号已就绪 |
| **Tier 2** | 需少量改造 | **qoder、qodercn、trae、lobsterai** | 有 WASM 加密 / 循环细节 / device 轮换需封装 |
| **Tier 3** | 严重依赖 DSH 或特殊机制，需重写/定制 | **loomy**（短信验证码人工介入）、**zcode**（磁盘凭据＋captcha） | 见 ZCode 专节 |
| **Tier 4** | 当前不适合纯 headless Docker | **zcode(自动 captcha 路径)** | 除非接受容器内跑浏览器（不推荐的灰色地带） |

> **MVP 建议先取 Tier 1a 中的 2-3 个（codearts + buddy/workbuddy）+ Tier 2 qoder 打通链路**，
> ZCode 单独作为 Tier 3 特例推进（见第 15 节）。

---

## 3. 统一 Provider Interface（对应交付项 3）

> 关键设计点（避免巨型 interface）：用**能力位(ProviderCapabilities) + 可选方法**，不强迫实现
> 不适用项。区分「登录」「运行期 chat」「运行期刷新」「额度/签到」四类能力。

```ts
// 能力声明（声明式，非强制）
type ProviderCapabilities = {
  supportsOAuth: boolean
  supportsRefreshToken: boolean     // 是否可静默续期
  supportsQuota: boolean
  supportsCredits: boolean          // 平台提供正常签到/领取
  supportsStreaming: boolean
  supportsVision: boolean
  supportsToolCall: boolean
  supportsMultipleAccounts: boolean
  loginMode: 'oauth' | 'device-code' | 'sms' | 'disk-credential' | 'local-callback'
  protocol: 'openai-chat' | 'anthropic-messages'   // 上游协议族（归一化层按此处理）
  needsCaptcha: boolean              // 若 true → 标记为需要人工/headful，不设计绕过
}

// Login 生命周期（Docker 无浏览器 → 产出授权 URL/设备码，用户浏览器完成，后台轮询）
interface ProviderAuth {
  beginLogin(req: BeginLoginReq): Promise<BeginLoginResult>
      // BeginLoginResult = { loginUrl?, deviceCode?, verificationUriComplete?, expiresIn, pollInterval }
  pollLogin(sessionId: string): Promise<PollLoginResult>   // done/success/error
  // 不暴露/不缓存明文 secret 到日志
}

// 运行期（上游调用）
interface ProviderChat {
  listModels(ctx): Promise<ModelInfo[]>
  chat(req: ChatRequest, account: SelectedAccount): AsyncIterable<ChatChunk>  // 内部做协议→内部 canonical 消息
  getQuota?(account): Promise<QuotaSnapshot | undefined>
  claimCredits?(account): Promise<ClaimResult | undefined>   // 仅 when supportsCredits
}

// Refresh（仅 when supportsRefreshToken）
interface ProviderRefresh {
  refreshToken(account): Promise<RefreshResult>   // 幂等；终端失败抛 TerminalError
}
```
每 provider 一个文件实现，注册进 `ProviderRegistry`（按 id 查找），**不用 if/else 链**。
ANTHROPIC 与 OpenAI 的差异收敛在**协议归一化层**（`openai-compat.ts` 移植 + anthropic 归一化器）。


---

## 4. Account 数据模型（对应交付项 4）

> 依据原项目 `ProviderAccountEntry`（`types.ts`）扩展。**secret 绝不进/绝不序列化到日志与 /v1/models。**

```ts
type AccountStatus =
  | 'active'                // 健康，可用
  | 'cooldown'              // 冷却中（cooldown_until，不参与选号）
  | 'unhealthy'             // 连续失败 / refresh 失败后待人工
  | 'disabled'              // 用户停用（不选号，但仍可被 worker 被动续期——遵循原项目约定）
  | 'needs_relogin'         // credential 终态失效

type Account = {
  id: string                // "{provider}-{shortid}"
  provider: string
  display_name: string
  status: AccountStatus
  enabled: boolean
  authenticated: boolean
  token_expiry_et?: Date    // access token 过期（原项目存毫秒 expiresAt）
  refreshable: boolean      // supportsRefreshToken && 有 refresh_token
  credential_ref: string    // 内部 token 表外键（不存明文在这）
  // 健康/失败
  failure_count: number
  last_success: Date | null
  last_failure: Date | null
  last_error: string | null
  cooldown_until: Date | null
  // 限流（滚动窗口，移植 updateModelRateLimit）
  model_rate_limits: Record<modelId, resetAtMs>
  // 额度
  quota_json?: string       // 序列化 QuotaSnapshot
  last_quota_at: Date | null
  last_credit_claim_at: Date | null
  quota_manual_required: boolean   // 平台无自动领取 → 标记需手
  // 元信息
  provider_metadata: string // 如 trae device_generation、zcode 区域等
  created_at: Date
  updated_at: Date
}
```

### 迁移映射（原 DSH → Gateway DB）
| 原 DSH | Gateway |
|---|---|
| `$DSH_HOME/.credentials.yaml` (`ctx.credentials`) | `credentials` 表（`credential_ref → ciphertext`） |
| `$DSH_HOME/jet-hub/state.json` accounts | `accounts` 表 |
| `modelRateLimits` (account 内) | `accounts.model_rate_limits` JSON 列 |
| `permanent-locks.json` | `settings` 表 |
| `~/.cache/deveco/*.json` 模型缓存 | `models` 表 |

---

## 5. SQLite schema 草案（对应交付项 5）

> SQLite + `better-sqlite3`（WAL），单文件 `/data/gateway.db`。**credentials 表加密 at rest。**

```sql
PRAGMA journal_mode=WAL;

-- providers: 已注册 provider 及能力位（快速过滤）
CREATE TABLE providers (
  id TEXT PRIMARY KEY,              -- 'codearts','buddy','zcode',…
  display_name TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,  -- ProviderCapabilities
  enabled INTEGER NOT NULL DEFAULT 1
);

-- accounts: 索引（不含明文 secret；model_rate_limits 用 JSON 列）
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL REFERENCES providers(id),
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active',        -- AccountStatus
  enabled INTEGER NOT NULL DEFAULT 1,
  authenticated INTEGER NOT NULL DEFAULT 0,
  token_expiry_et TEXT,             -- ISO; 可空
  refreshable INTEGER NOT NULL DEFAULT 0,
  credential_key TEXT NOT NULL,     -- credentials.credential_key 外键
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_success TEXT, last_failure TEXT, last_error TEXT,
  cooldown_until TEXT,
  model_rate_limits_json TEXT,      -- '{"deepseek-v4-flash":1234567890}'
  quota_json TEXT, last_quota_at TEXT, last_credit_claim_at TEXT,
  quota_manual_required INTEGER NOT NULL DEFAULT 0,
  provider_metadata_json TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX ix_accounts_provider ON accounts(provider);
CREATE INDEX ix_accounts_status ON accounts(status);

-- credentials: 加密 at-rest 的 secret（AES-256-GCM，密钥由 GATEWAY_SECRET 派生）
CREATE TABLE credentials (
  credential_key TEXT PRIMARY KEY,  -- 形如 {PROVIDER}_ACCOUNT_{XXX}
  ciphertext BLOB NOT NULL,        -- 非明文；绝不外泄到 API/日志
  enc_iv BLOB NOT NULL,
  enc_tag BLOB NOT NULL,
  algorithm TEXT NOT NULL DEFAULT 'aes-256-gcm',
  updated_at TEXT NOT NULL
);

-- models: ModelRegistry（见 §8）
CREATE TABLE models (
  model_id TEXT NOT NULL,
  provider TEXT NOT NULL REFERENCES providers(id),
  upstream_model TEXT NOT NULL,
  capabilities_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT,
  PRIMARY KEY (model_id, provider)
);

-- quotas: 额度快照（每账号）
CREATE TABLE quotas (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  provider TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  payload_json TEXT,               -- 平台私有余额明细（如 credit packages）
  total REAL, used REAL
);

-- credit_claims: 签到/领取记录（幂等保护）
CREATE TABLE credit_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  provider TEXT NOT NULL,
  claim_type TEXT NOT NULL,        -- 'daily'|'onboarding'|'claim-plan'
  claimed_at TEXT NOT NULL,
  credit REAL, status TEXT, message TEXT,
  UNIQUE(account_id, claim_type, date(claimed_at))
);

-- jobs: Scheduler 任务表（幂等 · 可重试）
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL, account_id TEXT,
  job_type TEXT NOT NULL,           -- 'token_refresh'|'quota_sync'|'credit_claim'
  scheduled_at TEXT, started_at TEXT, finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|running|done|failed|cancelled
  error TEXT, result_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_jobs_status ON jobs(status, scheduled_at);

-- events: 审计日志
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL, level TEXT NOT NULL,
  provider TEXT, account_id TEXT, job_id TEXT,
  kind TEXT NOT NULL, message TEXT, payload_json TEXT
);

-- settings: 全局配置（gateway api key 哈希、时区、各 provider enabled、永久锁等）
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);
```

### 安全要点
- `GATEWAY_SECRET`（Docker env / secret file → `/data/secrets/gateway.key`）派生 AES 密钥加密 credentials。
- API/日志/`/v1/models` 一律不输出 credential 明文；`/v1/models` 只返回模型能力与 `available`。
- 数据库文件权限 0600，owner = non-root 容器用户。

---

## 6. Scheduler / 任务系统设计（对应交付项 6）

> 统一后台 worker，独立于 Chat 请求；每任务在 jobs 表记录即可幂等/重试/审计。

```
调度器进程内（setInterval / 分片 cron）：
  [每 5 分钟]   token_refresh 扫描
  [每 15 分钟]  quota_sync 扫描
  [每天 00:30/按各平台激活时区] credit_claim 签到扫描
  [每 2 分钟]   rate_sweeper 清理过期 model_rate_limits
```

### 任务类型与语义
- **token_refresh**：对 `refreshable && (expiry - now <= 1h)` 的账号调 `refreshToken`；
  失败→`unhealthy`+`cooldown`+记录 `last_error`；`RefreshTokenExpiredError`（终态）→
  `status=needs_relogin`，**不删除账号**，保留人工重登入口。并发用**每 provider 信号量**限流。
- **quota_sync**：对 `supportsQuota` 账号拉余额 → 写 `quotas` → 更新 `quota_json`。
- **credit_claim**：对 `supportsCredits && 未今日领取` 账号调 `claimCredits`；写 `credit_claims`
  （`UNIQUE(account,type,date)` 幂等）；结果 `already_claimed/failed/manual_required`。
  **严格遵守"平台正常接口"**，若响应提示需人工（captcha/短信）→ `quota_manual_required=1` 并停止自动重试。

### 幂等 / 重试 / 并发
- 幂等键：`job_type + account_id + 周期`；DB 唯一约束兜底。
- 重试：指数退避（base 1m / *2 / cap 30m），`attempts` 计数。
- 并发限制：每 provider 一个 `Semaphore`（token 刷新与 chat 分开计数），**后台任务不挤占 Chat**。

---

## 7. Account Pool 算法（对应交付项 7）

> 移植 `AccountPool.getAvailableAccount`（`account-pool.ts:698`）语义，但加状态机与冷却。

```
selectAccount(provider, modelId):
  1. 候选 = filter(provider == P && enabled && status == 'active'|[cooldown ok] )
  2. 限流豁免 = modelId 存在于 model_rate_limits 且 resetAt <= now，否则剔除
  3. 冷却豁免 = cooldown_until 为空 或 cooldown_until <= now
  4. 排序 = 用户手动顺序优先（优先级字段）/ 其次最近最少使用（last_success 升序）
  5. 逐个解析该账号 credential：
       - 无 credential / 损坏 → 跳过并记录
       - token 过期 && refreshable → 触发 refresh（异步/在此槽）
       - 返回第一个可用的 {entry, credential}

失败分类驱动（见 §9 Error normalization）：
  - 429/quota → 该账号冷却 + 记录 model_rate_limits → 换下一候选（exclude 同账号）
  - 401 → refresh 一次 → 重试同账号；refresh 失败 → unhealthy → 换候选
  - 5xx/timeout/network → 该账号记一次失败（不做限流冷标记）→ 换候选（但尊重 cooldown）
  - provider 全不可用 → 返回 503（模型在 /v1/models 标 unavailable）
```


---

## 8. Model Registry（对应交付项 8）

```ts
type ModelEntry = {
  model_id: string        // 对外暴露的 OpenAI model string（可含 provider 前缀）
  provider: string        // 路由目标 provider
  upstream_model: string  // 发送给上游的真实 model id
  capabilities: { vision: boolean; tool_call: boolean; streaming: boolean; reasoning_efforts?: string[] }
  enabled: boolean
  priority: number        // 同名模型跨 provider 的优先级
  metadata: unknown       // 上下文窗口 / max_tokens 等
}
```
- `GET /v1/models` 返回 **enabled && 该 provider 至少一个可用账号** 的模型；全失效 → `unavailable: true`。
- **同名跨 provider**：`codearts/deepseek-v4-flash` 与 `workbuddy/deepseek-v4-flash` 并存，查询时 `model_id` 缺省由 ModelRouter 按优先级/策略选。支持 `provider::model` 显式路由语法。
- 目录来源：每个 provider 的 `listModels()`（远端 + 兜底表，移植各 `*-product.ts` 的 fallback/远端合并）。
- 动态刷新由 `quota_sync/模型拉取 worker` 触发，不入 requests 关键路径（缓存于 `models` 表）。

---

## 9. Error normalization（对应交付项 10 / 故障转移支撑 九）

> 统一 `UpstreamError` 分类器（移植 `llm-adapter.ts` 的 `httpErrorCode/isAuthError/isQueueError/isSseQueueErrorCode`、`refresh.ts:isAbnormalNetworkError/isRefreshTokenExpired`，抽象成一张表）。

```ts
type ErrorKind =
  | 'AUTH_INVALID'        // 401/403 → 试 refresh 一次
  | 'TOKEN_EXPIRED'       // token 已过期 → refresh
  | 'RATE_LIMIT'          // 429/排队(81111/3009/1005) → cooldown/换号
  | 'QUOTA_EXHAUSTED'     // 余额不足 → 禁该账号 → 换号
  | 'TIMEOUT'             // 首 token/分块空闲超时 → 可重试
  | 'TRANSPORT'           // 网络/上游不可达 → 可重试（更快间隔）
  | 'UPSTREAM_5XX'        // 临时服务端错误 → 有限重试
  | 'TERMINAL'            // 终态（业务拒绝/参数错）→ 不回退直失败
  | 'EMPTY_RESPONSE'
```

#### 每错误源的处理（对应你的 九）
| 信号 | 判定 | 动作 |
|---|---|---|
| HTTP 401 | AUTH_INVALID | 同号 refresh→重试1次；refresh 失败→unhealthy→换号 |
| HTTP 403 | AUTH_INVALID（zcode 等平台安全拦 403）| 同上；若属风控/验证码类 → TERMINAL/manual |
| HTTP 429 | RATE_LIMIT | 该号冷却 + 写 model_rate_limits → 换号；全受限→503 |
| code 1005/1113/3009（quota/concurrency）| QUOTA_EXHAUSTED 或 RATE_LIMIT | 1005/1113→禁号换号；3009→退避重试 |
| token expired | TOKEN_EXPIRED | refresh→重试同号；refresh 失败→next |
| refresh failed(终态) | TERMINAL(needs_relogin) | 停止调度 + 标记手动 |
| upstream timeout | TIMEOUT | 按 provider 重试预算重发（安全：SSE 半途则取消）|
| network/ENOTFOUND | TRANSPORT | 快速重试（1m）|
| 5xx | UPSTREAM_5XX | 每号有限重试，再换号 |

> ⚠ 不无脑重试：**401 只 refresh 一次**、**429 只换一次且写冷却**、**terminal 不回退**。
> 每 provider 定义 `retryBudget`（max attempts / 每次退避），账号级/上游级双限。

---

## 10. OpenAI-compatible Gateway API（对应交付项 9）

```
GET  /v1/models         → { object:"list", data:[{id,object,created,owned_by,capabilities?,available?}] }
POST /v1/chat/completions → 单次 + stream=true（SSE `data:` 帧，标准 OpenAI 结尾 `[DONE]`）
（可选）POST /v1/responses
健康: GET /healthz（Docker healthcheck）
管理(内部/受保护): /api/providers /api/accounts(CRUD) /api/accounts/:id/refresh|quota|claim /api/jobs /api/events
```

- 鉴权：外部 `/v1` 要求 `Authorization: Bearer <GATEWAY_API_KEY>`（settings 表存哈希）；管理 API 用独立 admin token。
- 请求流：
```
curl → /v1/chat/completions
→ 鉴权(GATEWAY_API_KEY)
→ Model Router (model_id → provider 候选)
→ Provider Router → Account Pool 选号
→ Provider Adapter:
     openai-chat  → openai-compat(移植 openai-compat.ts/sse.ts)
     anthropic    → anthropic-normalizer (移植 zcode-anthropic.ts / minimax-messages.ts)
→ 上游请求(+refresh/captcha/签名/轮换/时机)
→ 归一化 → OpenAI ChatCompletion / SSE
```
- 返回统一 OpenAI，不泄漏任意 provider 私有格式/字段；SECRET 永不进响应。

---

## 11. Docker 架构（对应交付项 11 / 你的第六七阶段目标）

```
compose:
  gateway:
    build: .   # multi-stage: node → slim runtime，non-root USER
    ports: ["8080:8080"]
    volumes: [ "./data:/data" ]
    environment:
      GATEWAY_API_KEY=...        # 或 secret file
      GATEWAY_SECRET=...         # 派生 enc key（DB 加密）——绝不写入 image
      TZ=Asia/Shanghai           # 各平台积分/签到按本地时区
      GATEWAY_LOG_LEVEL=info
    healthcheck:  curl -f http://127.0.0.1:8080/healthz || exit 1
    stop_grace_period: 30s       # Scheduler graceful drain
    restart: unless-stopped
```
- **无 GUI 浏览器**：登录 = `beginLogin()` 返回 `loginUrl/deviceCode`；用户在**自己浏览器**完成；
  gateway 后台 poll。`loginMode:'sms'`(loomy) → 提供 admin API 手动提交验证码。
- **ZCode 例外**（见专节）：凭据来自官方客户端磁盘（本机），captcha 需浏览器 → 在 host 侧用官方 App 登录，
  gateway 读其凭据或通过受控方式导入，不内置破解 captcha。
- 资源：非 root USER，token 不写镜像（/data volume 才持久），丢容器不丢数据。
- 升级：schema version 表 + 迁移；`/data` 兼容。

---

## 12. 哪些原代码可直接抽离（对应交付项 12）
- `src/oauth.ts`（codearts PKCE/DPoP）、`src/sign.ts`（华为 HMAC）
- `src/buddy.ts`+`buddy-oauth.ts`（buddy/workbuddy 全协议）、`src/credits.ts`（签到/余额结构）
- `src/refresh.ts`、`src/expiry-sync.ts`（续期语义，注参与）
- `src/openai-compat.ts`、`src/sse.ts`、`src/message-shape.ts`（OpenAI/SSE/消息归一化）
- `src/models.ts`（远端模型拉取+缓存）
- 各 `*-product.ts` 的产品差异配置（作 ProviderCapabilities/metadata）

## 13. 哪些代码需要重写（对应交付项 13）
- OpenAI HTTP 网关（`/v1/models` `/v1/chat/completions` SSE）——原没有
- Model Router / Provider Resolver
- 账号池并发安全 + 冷却状态机 + 审计
- SQLite 数据层 + 迁移 + at-rest 加密
- Scheduler/jobs 系统
- 错误归一化层
- 管理 REST API
- `LlmAdapter`/`LlmError`/`StreamChunk`/Cordis 相关全部去除

---

## 14. Provider 风险 / 阻碍（对应交付项 14）
| Provider | 风险 |
|---|---|
| zcode | ⚠⚠ **每请求须产 Aliyun captcha**、凭据仅来自官方磁盘、不可刷新、Anthropic 协议。Docker 里自动解 captcha 属于灰色地带，**不建议自动**。**
| loomy | 短信/微信人工验证码，无 refresh；Docker 需人工参与或暂缓 |
| qoder/qodercn | WASM 请求体加密（`qoder-wasm.ts`）需带 wasm 运行时可移植；中国版端点易变 |
| trae | 签到 device_id 轮换逻辑 MIME 复杂；SOLO 端口稳定性未知 |
| 所有浏览器 OAuth | 需 no-head 登录模式改造（beginLogin/poll），但续期无需浏览器 |
| 上游协议逆向 | 均基于实测逆向，平台升级可能破（风险在上游，非代码）|

---

## 15. ZCode 专项（对应交付项 14 的 ZCode / 你的特别检查）
> 你正在用 ZCode，单独分析。结论基于 `src/zcode*.ts` 与 `zcode-workbuddy-connect` 参考。

- **authentication**：非 OAuth。凭据存于 `~/.zcode/v2/credentials.json`，`AES-256-GCM` 加密，
  密钥=sha256(`zcode-credential-fallback:{platform}:{homedir}:{username}`)，`zcode.ts` 纯 Node 可解密。
  Docker 里**没有该磁盘凭据** → 需要「导入/代理」机制（见下）。
- **token**：静态 token（`ZCODE_REFRESHABLE=false`，`zcode.ts:454`）；`refreshAll` 只做「把磁盘上更新
  的凭据回写到池」（原项目语义）。**无自动续期**。
- **API**：`https://zcode.z.ai`。推理 Anthropic Messages
  `/api/v1/zcode-plan/anthropic/v1/messages`；额度 `/billing/balance`；活动 `/billing/preview`+`/claim`；
  配置 `/client/configs`；活跃上报 `/event/report`。
- **model list**：`client/configs` 的 `builtinModels`（真实值如 GLM-5.3 / GLM-5.3-Flash，context 1M）、
  `startPlanPreview.entitlements`；兜底表在 `zcode-product.ts`。
- **quota/credit**：balance + claim（claim 需 `Authorization` + **captcha 头** + 先补事件上报）。
- **refresh**：无（静态）。**streaming**：Anthropic SSE streaming 已实现（`zcode-adapter.ts:stream`）。
- **account switching**：支持多账号（池），额度类错误 `1005/1113` 走 `quotaSwitchMax` 换号。
- **OpenAI-compatible shim？**：原项目 **内部没有独立 OpenAI HTTP shim**——ZCode adapter 面向 dsh-llm
  输出的是**内部 canonical（Anthropic 形状）**。`zcode-workbuddy-connect` 那**不是 ZCode 的 shim**，
  是把 WorkBuddy 暴露成 OpenAI loopback 给 ZCode 用（方向相反）。→ **你的 Gateway 需要自写的
  anthropic→OpenAI 归一化器**（可移植 `zcode-anthropic.ts` 的序列化+反序列化，或简化用 OpenAI Chat 直连）。

### ZCode 在 Gateway 的落地方案（合规、不破解）
- **推荐**：Gateway 提供 `POST /api/accounts`(zcode) 的**凭据导入**（admin 上传 `credentials.json`
  内解密后的字段 / 或 `ZCODE_CREDENTIAL_SECRET`），存加密 DB；authorized 用户在官方 App 登录后，
  gateway 经 `/api/accounts/:id/import-credential` 导入。可做「host 侧官方客户端 → 磁盘凭据 → 导入」。
- **captcha**：不自动破解。若走 claim/每日领取，`needsCaptcha=true` 标记为 manual；
  或仅在 host 官方客户端内完成领取、gateway 只读 balance（`/billing/balance` 无需 captcha）。
- **推理**：普通 chat 每请求也需 captcha param（`zcode-adapter.ts:30` 明示每请求 mint、不可复用）。
  → 若坚持在 Docker 用 ZCode 聊天，就**必须 headful 浏览器产 captcha**（重阻抗、且接近自动绕验）。
  **明确建议**：MVP 阶段 **ZCode 优先作为「额度/模型/余额管理」集成 + 容器内走官方客户端旁路**，
  自动 captcha 路径列为后续需你单独拍板（此点最重要）。

---

## 16. MVP 应该包含哪些 Provider + 后续接入顺序（对应交付项 15/16）

### MVP（目标：端到端打通的 3 个）
1. **codearts**（协议最完整、HMAC 签到现成）
2. **buddy**（+ 顺带 workbuddy，同一协议/同一 adapter）
3. **qoder**（PKCE + WASM，验证复杂 provider 接入）

打通 `GET /v1/models` + `POST /v1/chat/completions`(stream) + refresh worker + SQLite + /v1 鉴权 + 管理 API。

### 后续（Tier 逐步接入）
- 第二批：**cline / minimax / raccoon / lobsterai**（Tier 1a，认证齐）
- 第三批：**trae**（设备轮换签到），**qodercn**
- 特例：**loomy**（人工短信），**zcode**（凭据导入 + captcha 决策后）

每接一个 = 新增一个文件实现 `ProviderAuth+ProviderChat+ProviderRefresh(可选)+capabilities`，注册进 registry，
为 models 表加目录，`/v1/models` 自动出现。**不再改网关核心。**

---

## 17. 推荐项目目录结构（对应交付项 7 的最后一项 / 你的 二阶段目标）

```
gateway/
├─ package.json  tsconfig.json  .env.example  README.md  LICENSE
├─ Dockerfile  docker-compose.yml
├─ .github/workflows/publish.yml          # build github actions (linux/amd64+arm64 → ghcr)
├─ src/
│  ├─ server/
│  │  ├─ index.ts            # bootstrap (http server → 路由)
│  │  ├─ auth.ts             # GATEWAY_API_KEY / admin token 中间件
│  │  ├─ routes/
│  │  │  ├─ models.ts  chat.ts  responses.ts(可选)  health.ts
│  │  │  └─ api-proxy.ts     # /api accounts/jobs/events 管理
│  │  └─ sse.ts              # OpenAI SSE 输出封装（移植 src/sse.ts）
│  ├─ core/
│  │  ├─ registry/provider-registry.ts
│  │  ├─ router/model-router.ts  provider-router.ts
│  │  ├─ pool/account-pool.ts account-state-machine.ts
│  │  ├─ errors/upstream-error.ts normalizer.ts
│  │  ├─ worker/scheduler.ts worker-pool.ts
│  │  └─ jobs/
│  ├─ protocol/              # 可复用库
│  │  ├─ openai/  (openai-compat.ts, sse.ts, message-shape.ts 移植)
│  │  ├─ anthropic/ (zcode-anthropic.ts, minimax-messages.ts 移植)
│  │  ├─ oauth/  (oauth.ts, buddy-oauth.ts 移植)
│  │  ├─ hmac/   (sign.ts 移植)
│  │  └─ credits/(credits.ts 移植)
│  ├─ store/
│  │  ├─ db.ts  schema.ts  migrate.ts  crypto.ts
│  │  └─ repos/(accounts, credentials, models, quotas, jobs, events, settings)
│  ├─ providers/
│  │  ├─ codearts.ts buddy.ts workbuddy.ts qoder.ts cline.ts minimax.ts
│  │  ├─ raccoon.ts lobsterai.ts trae.ts loomy.ts zcode.ts
│  │  └─ common/ (auth-login.ts poll.ts 等)
│  └─ config.ts
└─ tools/  # 原仓库迁移脚本工具（读 $DSH_HOME → 生成 SQLite 导入 SQL）
```

---

## 18. 待你确认的决策点（写代码前）
1. **技术栈**：Node+TS（推荐，协议全复用）？
2. **HTTP 框架**：Fastify？
3. **MVP provider 范围**：codearts+buddy/workbuddy+qoder？（建议）
4. **ZCode 策略**：MVP 先「凭据导入+模型/余额集成」，**captcha 自动路径待你单独拍板**（合规红线，不默认做）。
5. **Quota 拦截**：仅展示与账号健康，还是"耗尽自动换号并拒发"？（原项目不拦截；若要建议开`quota_intercept`开关）
6. **每日自动签到**：是否要 Scheduler 自动跑"平台正常签到"？（建议：CodeArts/Buddy/Qoder 自动；ZCode/Loomy 标记 manual）
7. **Docker secret**：GATEWAY_API_KEY 与 GATEWAY_SECRET 用 env 还是 secret file？
8. **/v1 之外是否要管理 UI**：先只有管理 REST API（不做前端）？
9. **发布**：ghcr 镜像名、arm64+amd64、版本标签策略？

---

*设计完。等你确认第 18 节决策后进入第三阶段实现（届时才写代码）。*
