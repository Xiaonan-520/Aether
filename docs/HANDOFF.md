# Project Handoff

> 生成时间：开发迁移节点。给下一位 Agent / 下一次会话阅读。
> 原则：只记录**实际存在**的事实，不猜。

---

## 1. Project Goal

**Multi-Provider AI Account Gateway**（自托管、OpenAI-compatible）。

把原项目 `deepseek-harness-codearts` 中的 Provider / OAuth / credential / quota / credit
能力逐步抽离，做成一个独立的 Docker 化 Gateway，对外只暴露一个

```
http://<server>:8080/v1
```

端点，内部统一处理：

- Multi-provider（CodeArts / CodeBuddy / WorkBuddy / ZCode / …）
- Multi-account（跨 provider 统一账号池）
- Token refresh（后台自动提前续期）
- Quota-aware routing（quota 作为选号信号，非硬门槛）
- Failover（按错误语义安全切号 / 刷新 / 冷却，不无脑重试）
- Scheduler（token_refresh / quota_sync / credit_claim / health_check）
- Credit claim（只使用平台正常提供的合法接口）
- OpenAI-compatible API：至少 `GET /v1/models`、`POST /v1/chat/completions`（stream）

最终单一入口供 RikkaHub / OpenCode / DeepSeek Harness / 其它 OpenAI client 使用。

---

## 2. Source Repository

- 原项目：`https://gitee.com/iJetLi/deepseek-harness-codearts`（本地克隆于 `/workspace/deepseek-harness-codearts`，已审计，未修改）
- 官方 harness：`https://github.com/deepseek-ai/deepseek-harness`（本地 `/workspace/deepseek-harness`）
- 参考（架构/协议参考，**不直接复制代码**）：
  - `https://github.com/LuckyWithLab/zcode_proxy`
  - `https://github.com/TriDefender/zcode-api`
  - `https://github.com/hawchou1995/zcode-workbuddy-connect`（本地 `/workspace/zcode-workbuddy-connect`）
  - `https://gitcode.com/fork/dsh-provider-auth`（本地 `/workspace/dsh-provider-auth`，早期快照）
  - `https://github.com/HeWhenJay/dsh-provider-hub`（本地 `/workspace/dsh-provider-hub`，sidecar 参考）

> 许可证：不得把第三方项目代码未经许可直接复制进本仓库。原项目为 MIT。

---

## 3. Current Architecture（实际已创建的模块）

> 当前只是 **Phase 3A 起步**：已建立分层骨架与核心类型，尚未实现 Provider/Service/HTTP。

```
gateway/                    # 新 Gateway 仓库（位于 /workspace/gateway）
├─ package.json             # ESM, Node >= 18
├─ tsconfig.json            # module NodeNext, outDir dist
├─ vitest.config.ts
├─ .env.example             # GATEWAY_API_KEY / GATEWAY_SECRET / ADMIN_TOKEN / TZ …
├─ .npmrc                   # registry = registry.npmmirror.com
├─ .gitignore               # 忽略 node_modules/dist/data/*.db/.env/secrets 等
├─ docs/
│  ├─ HANDOFF.md            # 本文件
│  ├─ AUDIT_REPORT.md       # 第一阶段审计（复制自 deliverables）
│  └─ DESIGN_PHASE2.md      # 第二阶段设计（复制自 deliverables）
├─ src/
│  ├─ config/               # (尚未实现) 配置加载
│  ├─ core/
│  │  ├─ types.ts           # 领域类型: Account/AccountStatus/ModelEntry/Quota/ChatMessage/ChatChunk…
│  │  ├─ errors/upstream-error.ts   # UpstreamError 分类器 (AUTH/RATE/QUOTA/TIMEOUT/TERMINAL/NEEDS_CAPTCHA…)
│  │  ├─ registry/provider.ts        # Provider 抽象接口 (auth/ops/chat + capabilities)
│  │  ├─ registry/provider-registry.ts
│  │  └─ router/model-router.ts      # modelId → provider + upstream (支持 provider::model)
│  ├─ store/
│  │  ├─ types.ts           # StoreGateway 抽象接口 (accounts/credentials/models/quotas/claims/jobs/events/settings)
│  │  ├─ crypto.ts          # AES-256-GCM at-rest 加密（密钥从 GATEWAY_SECRET 派生）
│  │  └─ (memory-store.ts 尚未实现，见第 10 节)
│  ├─ protocol/             # (尚未实现) openai / anthropic / oauth / hmac / sse 归一化
│  ├─ providers/            # (尚未实现) codearts / buddy / workbuddy / zcode / …
│  ├─ service/              # (尚未实现) chat / models / accounts 服务层
│  └─ http/                 # (尚未实现) Hono 薄层: routes/middleware
└─ tests/                   # (空) unit / mockupstream
```

分层原则（已定）：`HTTP(Hono) → Service → Model Router → Account Pool → Provider Adapter → Upstream`。
Provider-specific 实现禁止污染 Gateway Core。

---

## 4. Current Implementation Status

> 以当前源码实际为准（仅 7 个 ts 文件、共约 602 行）。

| 组件 | 状态 | 说明 |
|---|---|---|
| HTTP framework | NOT STARTED | Hono + @hono/node-server 已入依赖，未写 server/路由 |
| Hono 薄层 | NOT STARTED | 无 http/ |
| OpenAI API | NOT STARTED | 无 /v1/models、/v1/chat/completions |
| Account Manager | PARTIAL | 仅领域类型 core/types.ts:Account/AccountStatus/AccountPatch；无实现 |
| Account Pool | PARTIAL | 仅 ModelRouter 雏形；选号/冷却/失败转移逻辑未实现 |
| Provider Registry | PARTIAL | provider.ts 抽象 + provider-registry.ts 已写；0 个真实 provider |
| Model Registry | PARTIAL | core/types.ts:ModelEntry + model-router.ts 已写；无 models 表/种子 |
| SQLite | NOT STARTED | better-sqlite3 在 optionalDependencies（本机省略安装）；无 SQLiteStore |
| Scheduler | NOT STARTED | 无 jobs 实现（StoreGateway 已含 createJob/listJobs/nextDueJobs 接口） |
| Token Manager | NOT STARTED | crypto.ts（at-rest 加密）已写；无 token 生命周期逻辑 |
| Quota | NOT STARTED | QuotaSnapshot / getQuota/setQuota 接口已定义；无 provider 实现 |
| Credit Claim | NOT STARTED | ClaimOutcome 类型 + recordClaim/isClaimedToday 接口已定义；无实现 |
| Docker | NOT STARTED | 无 Dockerfile / compose |
| Tests | NOT STARTED | tests/ 为空；vitest 已配置但无测试用例 |

---

## 5. Provider Status

> 状态来自第一阶段源码审计（原项目 `/workspace/deepseek-harness-codearts`）。
> 本 Gateway 仓库中 **0 个 provider 已实现**；下表描述的是「原项目已有的能力」，
> 供下一位 Agent 迁移时参考。

| Provider | 原项目能力 | Authentication | Refresh | Chat | Stream | Quota | Credits | Notes |
|---|---|---|---|---|---|---|---|---|
| CodeArts | 完整 | 浏览器 OAuth + PKCE + DPoP | 是(refresh_token) | 是 | 是 | 是 | 是(HMAC 3步) | 本地回调服务器；MVP 第一批 |
| CodeBuddy | 完整 | external-link-v2 轮询 | 是 | 是 | 是 | 是 | 是(每日签到) | 与 WorkBuddy 同协议；MVP 第一批 |
| WorkBuddy | 完整 | 同 CodeBuddy | 是 | 是 | 是 | 是(余额) | 否(仅余额+锁永久) | 国际版 endpoint 不同；MVP 第一批 |
| ZCode | 完整 | 磁盘凭据(AES-GCM 解密) | 否(static) | 是 | 是 | 是 | 是(claim,需 captcha) | Anthropic Messages；MVP 第一批；captcha 不自动 |
| Cline | 完整 | WorkOS 设备码 | 是 | 是 | 是 | 是 | 是 | 第二批 |
| MiniMax | 完整 | OAuth 设备码 + PKCE | 是 | 是 | 是 | 是 | 是 | Anthropic Messages；第二批 |
| Raccoon | 完整 | 本地回调弹窗 | 是(轮换) | 是 | 是 | 是 | 是 | 第二批 |
| Qoder | 完整 | PKCE 设备码 | 是(+machine_id) | 是 | 是 | 是 | 是(每日100) | WASM 请求体加密；第三批 |
| QoderCN | 完整 | 同 Qoder | 是 | 是 | 是 | 是 | 是 | 第三批 |
| TRAE | 完整 | OAuth(ExchangeToken) | 是(轮换) | 是 | 是 | 是 | 是(device 轮换) | 第三批 |
| LobsterAI | 完整 | 本地回调 + authCode | 是 | 是 | 是 | 是 | 是 | 第三批 |
| Loomy | 完整 | 短信 / 微信 | 否(仅探测) | 是 | 是 | 是 | 是(签到+新手) | 需人工验证码；最后 |

---

## 6. Important Design Decisions

- **HTTP**：使用 **Hono**（薄 HTTP Adapter）。Provider / Account / Scheduler / DB 完全不知道 Hono 的存在。
- **Gateway**：OpenAI-compatible；至少 `GET /v1/models`、`POST /v1/chat/completions`；支持 streaming（`data: {...}` … `data: [DONE]`）。
- **Architecture**：`HTTP layer → Service layer → Model Router → Account Pool → Provider Adapter → Upstream`。Provider-specific 实现不许污染 Gateway Core。
- **ZCode**：是正式 MVP Provider。上游使用 **Anthropic Messages**；Gateway 对外统一 OpenAI-compatible，不把 Anthropic 协议暴露给客户端。
- **ZCode captcha**：**不得在本项目中实现、复制或扩展验证码绕过/自动求解**。若需要 captcha，返回 `needs_captcha` / `manual_required`，保留账号状态供管理员处理。
- **MVP 批次**：
  1. CodeArts / CodeBuddy / WorkBuddy / ZCode
  2. Cline / MiniMax / Raccoon
  3. Qoder / QoderCN / TRAE / LobsterAI
  4. Loomy / 其它需人工交互的 Provider
- **Quota**：Quota-aware routing；quota 是 routing signal，不是绝对实时硬门槛；支持 `quota_unknown` 时仍允许请求。
- **Scheduler**：必须有；负责 Token Refresh / Quota Sync / Credit Claim / Health Check；幂等、可重试、指数退避、并发限制、审计。
- **Credit Claim**：只使用平台正常提供的合法接口；当日已领取不重复调用；无接口则标记 `manual_required`。
- **存储**：抽象 `StoreGateway` + 内存实现（单测/mock/无 SQLite 兜底）+ SQLite 实现（Docker）。核心逻辑不依赖具体存储。
- **凭据安全**：token 以 AES-256-GCM 加密 at rest（密钥从 `GATEWAY_SECRET` 派生）；绝不进 API / 日志 / `/v1/models`。

---

## 7. Safety / Compliance Boundary

允许：
- 正常 OAuth、正常账号登录、refresh token
- 官方 API、正常 quota 查询
- 正常每日签到、正常积分领取
- 多账号池、failover

禁止：
- 验证码绕过 / 破解 CAPTCHA / 自动求解
- 绕过身份验证
- 伪造额度 / 篡改服务端状态 / 绕过平台限制

特别记录：**ZCode captcha 是当前已知边界**——不自动处理，返回结构化状态。

---

## 8. Files Changed

> 本 Gateway 仓库尚无 Git 历史（见第 13 节），以下为「本仓库将首次提交的文件」。
> 获取实时清单请运行 `git status`（init 之后）。

- `package.json`：项目定义、依赖、脚本（build/typecheck/test/dev/start/migrate）。
- `tsconfig.json`：TypeScript 编译配置（NodeNext）。
- `vitest.config.ts`：测试配置。
- `.env.example`：环境变量样例（无真实值）。
- `.npmrc`：npm registry 指向 npmmirror。
- `.gitignore`：忽略依赖/构建/数据/密钥/日志等。
- `docs/HANDOFF.md`、`docs/AUDIT_REPORT.md`、`docs/DESIGN_PHASE2.md`：交接与设计文档。
- `src/core/types.ts`：领域类型。
- `src/core/errors/upstream-error.ts`：错误归一化分类器。
- `src/core/registry/provider.ts`：Provider 抽象接口。
- `src/core/registry/provider-registry.ts`：Provider 注册表。
- `src/core/router/model-router.ts`：模型路由。
- `src/store/types.ts`：存储抽象接口。
- `src/store/crypto.ts`：凭据 at-rest 加密。

---

## 9. Tests

> 迁移节点实测结果（真实，未伪造）：

- `npm run typecheck`（`tsc --noEmit`）：**PASS**（exit 0，无错误）。
- `npm run build`（`tsc`）：**PASS**（exit 0；产物写入 `dist/`：
  `dist/core/types.js`、`dist/core/errors/upstream-error.js`、`dist/core/registry/*.js`、
  `dist/core/router/model-router.js`、`dist/store/*.js`）。
- `npm test`（`vitest run`）：**FAIL（环境问题，非代码问题）**。
  报错 `MODULE_NOT_FOUND`（`node_modules/rollup/dist/native.js`），原因是本机安装时用了
  `--omit=optional`，跳过了 rollup 的平台原生二进制。`tests/` 目前也是空的（无用例）。
  下一位 Agent 修复：在有网络的环境执行 `npm install`（不省略 optional），或
  `npm install @rollup/rollup-linux-arm64-gnu`。
- lint：**未配置**。

---

## 10. Known Problems

- `src/store/memory-store.ts` **尚未实现**（StoreGateway 的内存实现缺失）。
- Provider Adapter：一个都没有（codearts/buddy/workbuddy/zcode 未开始）。
- HTTP / Service / protocol 层未开始。
- Scheduler、Account Pool 逻辑未实现。
- SQLite 实现未开始；better-sqlite3 为 optional，本机未安装（Docker 阶段再编）。
- 无 Dockerfile / docker-compose / GitHub Actions。
- 无 `src/config/`（配置加载）。
- `package.json` 的 `start`/`main` 指向 `dist/http/index.js`，该文件尚不存在。

---

## 11. Next Steps

1. 检查当前 Git commit（`git log --oneline`）。
2. 阅读 `docs/HANDOFF.md`、`docs/DESIGN_PHASE2.md`、`docs/AUDIT_REPORT.md`。
3. 补 `src/store/memory-store.ts`（实现 StoreGateway，用于单测/mock）。
4. 实现 `src/config/`（读 .env：GATEWAY_API_KEY / GATEWAY_SECRET / ADMIN_TOKEN / TZ / HTTP_PORT）。
5. 实现 `src/protocol/openai/`（canonical 消息 ↔ OpenAI JSON 序列化 + SSE writer）。
6. 实现 `src/core/pool/account-pool.ts`（选号/状态机/冷却/失败转移）。
7. 实现 `src/service/chat-service.ts`、`src/service/model-service.ts`。
8. 实现 `src/http/`（Hono app：/healthz、/v1/models、/v1/chat/completions、/api/*）。
9. 实现 CodeArts adapter（`src/providers/codearts/`），可复用原项目 `oauth.ts`/`sign.ts` 逻辑（重写为独立库，去 DSH 依赖）。
10. 实现 CodeBuddy / WorkBuddy adapter。
11. 实现 ZCode adapter（Anthropic→OpenAI 归一化；captcha 返回 needs_captcha）。
12. mock upstream tests（vitest）+ Dockerfile（multi-stage）+ docker-compose。
13. 真实账号集成测试（由用户手动配置，不在 Agent 中执行）。

---

## 12. Important Documents

- `/workspace/gateway/docs/AUDIT_REPORT.md`（= 副本 `/workspace/deliverables/AUDIT_REPORT.md`）
- `/workspace/gateway/docs/DESIGN_PHASE2.md`（= 副本 `/workspace/deliverables/DESIGN_PHASE2.md`）
- `/workspace/gateway/docs/HANDOFF.md`（本文件）

> 原始文件仍保留在 `/workspace/deliverables/`（未删除）。

---

## 13. Git Information

- 仓库位置：`/workspace/gateway`
- 当前 branch：`<init 后见 git branch>`
- 当前 commit：`<init 后见 git log>`
- remote：`<尚未配置>`
- 备注：本仓库在本次 Handoff 中**首次 git init 并提交**；不 amend 既有历史（此前无历史）。

---

## 14. Compliance Checklist（commit 前）

- [ ] 无真实 token / credential
- [ ] 无 .env（仅 .env.example）
- [ ] 无数据库真实账号 / cookies / 私钥 / 浏览器 profile
- [ ] 未提交 node_modules / 构建缓存
- [ ] .gitignore 覆盖以上
