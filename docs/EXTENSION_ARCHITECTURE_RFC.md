# Extension Architecture RFC

- **状态**: Draft v2（Phase 0 — 第二轮架构评审定稿；本文档不伴随任何代码变更）
- **日期**: 2026-10-03（R2 评审修订：§3.5 / §7.1 / §9.1 / §10.2–10.4 / §12.1–12.2 / §16.4 / §17.2 / §19.1 / §19.4–19.5 / §20 / §20.3 / §22 / §22.1 / §24.4 / §25 / §25.4 / §26 / §27 / 文档头）
- **对象版本**: v0.1.0 (`aa8afe6`)
- **作者**: Gateway 维护者

> **R2 评审基线**：整体架构方向维持不变（Gateway Core → Extension Manager → Independent Docker Extensions）。本轮修订是在既有 27 节设计之上补强硬边界：**账号权威（§3.5）、凭据红线（§10.3）、Manager 自身边界（§19.5）、声明与强制分离（§12.2/§20.3）、命名空间（§9.1）**，并把 Conformance 设计前置到 Phase 2/3（§22.1）。新增四条全程不可违反的设计红线：
> 1. **账号权威唯一**：Extension 是账号/凭据/生命周期的权威事实源，Core 不成为第二个可写事实源（§3.5）。
> 2. **凭据明文红线**：凭据明文永不流经 Core——协议层不存在携带 token/密码字段的账号创建接口（§10.3）。
> 3. **声明≠强制**：Manifest 的 permission 声明仅用于安装展示与审计，v1 不构成任何运行时隔离承诺（§12.2）。
> 4. **Action 非通用 RPC**：Action 是窄口面的交互通道，非法外入 Docker/host 控制面（§16.4）。

---

## 1. 摘要与目标

本 RFC 提出把 Gateway 从"单进程单体内置全部 Provider"演进为 **Gateway Core + Extension Manager + 独立容器化 Provider Extension** 的三层架构。演进完成后：

- Core 不再编译期依赖任何具体 Provider，不再认识 zcode captcha、qoder WASM、trae 签名等任何上游细节；
- 每个 Provider（或同族 Provider 组）运行在独立容器中，通过统一的 **Extension Protocol v1**（HTTP + JSON + SSE）接入 Core；
- Extension 通过 **Extension Manager** 安装、更新、回滚，分发走 GitHub Release → `extension.yaml` → GHCR 镜像的标准链路；
- 第三方 Extension 与官方 Extension 走同一套协议与分发机制。

核心判断（基于对现有代码的审计，见 §3–§4）：现有 `src/core/registry/provider.ts` 的 `Provider` 适配器接口已经非常接近 Extension Protocol 的语义雏形——`authenticate / refresh / models / chat / stream / quota / claim / health` 八个面与协议端点一一对应。**迁移的本质不是重写架构，而是把进程内函数调用变成跨进程 HTTP 调用，并把散落在 Core 里的 6 处 Provider 具体知识清理出去。**

### 目标

1. Core 与任何具体 Provider 零耦合（无 import、无分支、无特判）。
2. Provider 以独立容器分发，可独立安装/升级/回滚，Core 无需重新构建。
3. 协议契约显式化、可版本化，第三方可按文档实现 Extension。
4. ZCode CAPTCHA（人工完成）、Qoder WASM（本地外部文件）等敏感/本地化能力完全收敛在各自 Extension 内。
5. 安全边界明确：Core 永不持有 Docker socket；Extension 永不接触 Core 数据库。

### 非目标（Non-Goals）

- 不改变对外 OpenAI 兼容 API 的任何行为（`/v1/chat/completions`、`/v1/models`、admin `/api/*` 的外部语义保持不变）。
- 不引入 Kubernetes / service mesh 等重型基础设施；目标部署形态仍是单机 Docker Compose。
- 不做 Extension 之间的互相调用；Extension 只与 Core、Manager 通信。
- 不在本 RFC 阶段写任何代码（见 §2）。

---

## 2. 范围与约束

本文档是 Phase 0 交付物，**不伴随任何代码变更**。允许的分析手段仅限读取仓库代码与 `/tmp` 下的一次性实验。

硬约束（继承自既有决策）：

- 合规边界：CAPTCHA 永不自动求解，只能通过官方组件 + 人工完成（ZCode Extension 的 `needs_manual_action` 流程是合规设计的一部分，不是缺陷）。
- Qoder WASM 是专有二进制，**永不进入公开 Core 或公开 Extension 镜像**，只能由运营者在运行时以本地文件/卷方式提供（延续 `QODER_WASM_PATH` 机制，见 §24.7）。
- 公开资产（仓库、镜像、文档）不得包含真实 IP、token、账号。
- 现有 homeserver 生产部署（内网容器 `ai-gateway`）的迁移必须平滑，DB schema 变更需兼容既有数据。

---

## 3. 现状架构审计（真实代码）

### 3.5 账号数据所有权（Ownership Matrix）

> 本节为 R2 新增，是 §4（Account Contract）与 §25（存储边界）的权威前提。**原则：谁产生事实，谁是唯一可写权威（single writable authority）；其他组件只能持有派生投影（derived projection），且投影只读、可随时删除重建（rebuildable）。**

先固定四个标识符的语义（详见 §9.1）：`extension_id`（容器/安装单元）、`provider_id`（协议能力单元，多对一属于 extension）、`account_id`（**全局唯一**，Core 分配的不透明标识，完整凭据 opaque）、上游账号 ID（**provider 命名空间**，仅 Extension 可解释）。

| 数据项 | Authoritative source（唯一可写） | Core 持有什么 | Extension 持有什么 | 理由 / 说明 |
|--------|--------------------------------|--------------|--------------------|------------|
| **credential（凭据明文及加密形态）** | Extension（自有卷 + SDK 加密） | **什么都不持久化**；运行中也永远不见明文（§10.3） | 加密存储（AES-GCM，`GATEWAY_EXTENSION_SECRET`） | 凭据是上游会话密钥，只有 Extension 需要它；Core 持有=攻击面与合规双重倒退 |
| **上游账号 ID（upstream account id）** | Extension | 无（不解释其格式） | 原样 + 与 `account_id` 的映射 | Provider 私有命名空间（邮箱/uid/site_id…），Core 只透传 `account_id` |
| **OAuth session / 登录会话** | Extension（卷持久化） | 无 | 会话与 nonce 全集 | 消解现状 C6：重启不丢；Core 无感知 |
| **provider-specific status（细分状态）** | Extension | 无 | 自由内部状态机 | 对外只投影为 §10.1 的 9 个标准状态 |
| **quota raw data（上游原始配额响应）** | Extension | 无 | 原始 JSON，供自身审计/调试 | Core 不承载原始载荷 |
| **quota normalized snapshot（§13 规范快照）** | Extension（产生）→ Core（镜像） | 只读投影：`resources[]` 镜像表 | 权威值 + 上报 | Core 投影仅供路由/UI；**上游同步以 Extension 为准，Core 表可 drop 重建** |
| **account status（9 态标准状态）** | Extension（产生）→ Core（镜像） | 只读投影（accounts 镜像行） | 权威值 | 例外：`disabled` 与 `cooldown` 见下两行，是 Core 侧的本地叠加态，不回写 Extension |
| **routing eligibility（路由资格）** | **Core** | 权威（enabled 开关 + 投影状态合成） | 建议（上报状态） | 资格 = Extension 投影 ∩ Core 本地态（enabled/disabled/cooldown），合成权在 Core |
| **cooldown（失败冷却）** | **Core（AccountPool）** | 权威（内存 + 退避计算） | 无 | 调度内部态；对 Extension 只表现为"一段时间不被派单" |
| **failover state（聊天内转移状态）** | **Core（ChatService）** | 权威（请求级内存态） | 无 | MAX_ACCOUNT_ATTEMPTS、流后不转移等规则全在 Core |
| **scheduler state（调度游标/执行记录）** | **Core（jobs 表）** | 权威（Core 级任务，如 health_check 兑底巡检） | Extension 自有周期任务的状态归 Extension 卷 | v1 后 token_refresh/quota_sync/credit_claim 移入 Extension 自有调度（§25.3 jobs 行），其游标随迁移归属 Extension |

**三条纪律**：① Core 永不基于投影做反向写回权威（唯一例外是 `disabled`——运营者经 Core 设置，经 §10.4 的 enable/disable 端点下推 Extension，双向确认）；② 投影不可用时降级为"暂不派单"，绝不把投影当权威用；③ Extension 重装/数据卷清空后，Core 侧全部投影可安全清重建，不丢失任何唯一事实。

### 3.1 分层现状

```
src/
├── config/            env 加载（zod）
├── core/              ★ 与 Provider 无关的通用核心
│   ├── apikeys/       API key 哈希/校验
│   ├── errors/        UpstreamError（11 种 kind）+ normalizer
│   ├── pool/          AccountPool（账号选择、冷却、限流状态机）
│   ├── registry/      Provider 接口 + ProviderRegistry（Map）
│   ├── router/        ModelRouter（model / provider::model 解析）
│   ├── types.ts       AccountStatus(9)、ModelEntry、QuotaSnapshot 等
│   └── worker/        Scheduler（4 类周期任务）
├── http/              Hono app：/v1/*（OpenAI 兼容）+ /api/*（admin）
├── protocol/openai/   外部协议 parse/serialize/sse
├── providers/         ★ 14 个 Provider 适配器（4 buddy 族共享 shared/buddy）
├── service/           ChatService / LoginService / ModelService / 调度执行器
└── store/             StoreGateway 接口 + SQLite(10 表) / MemoryStore
```

### 3.2 已存在的干净接缝

`src/core/registry/provider.ts` 已定义 `Provider` 接口：

- `chat`: `listModels / chat / stream`
- `ops`: `refreshAccount / getQuota / claimCredit / healthCheck`
- `auth`: `beginLogin / pollLogin / submitCredential`（`BeginLoginInput` 含可选 `phone`，覆盖 sms 模式）
- `capabilities`: `ProviderCapabilities`（supportsOAuth/RefreshToken/Quota/Credits/Streaming/Vision/ToolCall/MultipleAccounts、needsCaptcha、loginMode、protocol）
- `ProviderCtx`: 适配器唯一的宿主回调（当前只有 `resolveCredential`）

`AccountPool` 只依赖注入回调和归一化后的 `UpstreamError.kind`，完全不知道 Provider 是谁。`ChatService` 的故障转移规则（AUTH 刷新一次→切换账号；RATE_LIMIT/QUOTA/传输错误→切换；TERMINAL/NEEDS_CAPTCHA/NEEDS_MANUAL→立即失败；首块流后不再转移）全部建立在 kind 之上。**这些语义可以直接升格为 Extension Protocol 的 Chat/Account/Error Contract。**

### 3.3 关键运行时事实

- **注册**：`src/providers/register.ts` 编译期 import 全部 14 个适配器工厂，`registry.register()` 逐个入 Map；返回 `{ captcha }` 把 zcode 类型带出 providers 层。
- **登录**：`src/service/login-service.ts` 通过 `adapter.auth.beginLogin/pollLogin/submitCredential` 驱动，pending 登录=一条 `pending` 状态的 account 行；zcode 的 OAuth 会话 Map 存在 provider 进程内存（`src/providers/zcode/provider.ts:95`）。
- **模型目录**：登录成功后 `syncModels()` 拉取一次 `adapter.chat.listModels` 写入 models 表；之后 `/v1/models` 完全读本地表（push 模型，无周期拉取）。
- **调度**：`src/core/worker/scheduler.ts` 周期入队 `token_refresh`(5min 扫描) / `quota_sync`(15min) / `credit_claim`(30min) / `health_check`(30min)，执行器回调 `adapter.ops.*`。
- **配额**：`QuotaSnapshot` 单资源（known/remaining/total/resetAt/rawJson）；`src/providers/cline/credits.ts` 已自造 `unit: 'raw'` 规避语义不适配——多资源契约的现实证据。
- **存储**：SQLite 10 表（providers, accounts, credentials, models, quotas, credit_claims, jobs, events, settings, api_keys）。accounts 表完全 provider 无关（逃生舱 `provider_metadata_json`）；凭据以 `GATEWAY_SECRET` AES-GCM 加密存 `credentials` 表。
- **HTTP**：`/v1/chat/completions`（JSON/SSE）、`/v1/models`、`/v1/api-keys`、`/api/providers|accounts|quotas|events|jobs|settings`、登录三端点、**zcode captcha 两个特判端点**（见 §4）。
- **测试**：32 个 spec 文件、408 通过 + 2 跳过用例，provider 测试用 fetch stub，与实现解耦良好。

---

## 4. Provider↔Core 耦合点清单与成因

审计 `src/service`、`src/core`、`src/http`、`src/store`、`src/protocol` 全部源码：**业务逻辑层（pool/router/chat-service/login-service/scheduler）中 `provider === 'xxx'` 式分支为零**。全部耦合集中在以下 6 处，且都是"单体内为了走通而抄近路"，不是架构必然：

| # | 位置 | 内容 | 为什么存在 |
|---|------|------|-----------|
| C1 | `src/providers/register.ts` | 编译期 import 全部 14 个适配器；`RegisteredProviders.captcha: ZCodeCaptchaManager`、`RegisterOptions.captcha` 以具体类型泄漏到引导层 | 单体进程必须实例化一切；zcode 的 captcha manager 需要"注册时创建、注入 provider、暴露给 HTTP 层"三方共享，最省事的做法就是把它作为 register 返回值传出去 |
| C2 | `src/http/app.ts` | `import { renderAuthorizePage, widgetParams } from '../providers/zcode/captcha'`；`POST /api/accounts/:provider/captcha` 内 `if (provider !== 'zcode')` 字面量拒绝；`GET /captcha/zcode` 人工页面硬编码 | captcha 是**人在浏览器里完成的交互流程**，需要服务端渲染页与 widget 参数下发。现有 `Provider` 接口只有数据面（chat/quota/auth），没有"交互式 UI 通道"，于是在 HTTP 层直接抄近路 |
| C3 | `src/service/context.ts:12` | `ServiceContext.captcha: ZCodeCaptchaManager` —— 核心服务上下文依赖具体 Provider 类型 | C1 的连带：captcha 要被 admin 端点读取状态，就得放进 ctx；没有通用的"provider 提供的服务"概念，只能具体类型硬编码 |
| C4 | `src/core/errors/normalizer.ts` | `registerBusinessCodes()` 全局 Map：适配器在注册时向 Core 进程注入业务码映射 | normalizer 想把 81111/1005/1113 这类厂商业务码翻译成统一 kind，又不愿 import provider；进程内全局注册表是单体下最顺手的接缝 |
| C5 | `src/http/index.ts` + `src/service/context.ts` | `ProviderCtx.resolveCredential` 闭包直接调 `resolveCredentialJson`（cipher 解密）；pool 的 `refreshAccount` 回调在进程内写回加密凭据 | 凭据加密与 SQLite 在同一进程内，闭包传明文最简单。**这是 Extension 化最深的耦合**：跨进程后明文凭据不能过网 |
| C6 | `src/providers/zcode/provider.ts:95`、captcha manager、各适配器登录会话 Map | OAuth 会话、captcha token、登录 nonce 全部存 Gateway 进程 RAM | 单进程假设：重启即丢（登录中断需重来），Extension 化后天然解决（状态归 Extension 自己的卷） |

**结论**：C1/C3/C6 随 Extension 化自然消失（状态与类型归属 Extension）；C2 需要 Protocol 增加"交互式 Action 通道"（§16）；C4 随错误归一化下沉到 Extension 内消失（§14）；C5 需要把凭据所有权移交给 Extension（§25）。Core 现有的 `Provider` 接口、pool 状态机、错误 kind、AccountStatus 枚举全部保留，直接作为 Protocol 契约的蓝本。

---

## 5. Core 与 Extension 职责划分

### 5.1 Core 保留（不变或强化）

| 职责 | 现状 | 目标 |
|------|------|------|
| 对外 OpenAI 兼容 API + SSE | `http/app.ts`, `protocol/openai` | 不变（外部行为零变化） |
| API key 管理 | core/apikeys + api_keys 表 | 不变 |
| 模型路由（`provider::model`、优先级、onlyAvailable） | core/router | 不变；模型目录来源改为"Extension 推送 + Core 拉取合并" |
| 账号池：选择/冷却/限流/失败计数 | core/pool | 不变；状态来源改为 Extension 上报 |
| 聊天编排与故障转移 | service/chat-service | 不变；故障转移依据从内存异常变为 Protocol 错误码 |
| 请求级配置（超时、重试次数） | config | 不变，另增 Extension 调用超时 |
| accounts/models/quotas 镜像、events、settings、api_keys | store | 保留并成为"镜像层"（§25） |
| 健康聚合 | health_check 任务 | 保留；数据源变为 Manager + Extension /health |

### 5.2 移入 Extension

| 职责 | 现位置 | 去向 |
|------|--------|------|
| 上游协议转换（anthropic-messages / openai-chat / 各家私有协议） | providers/* | Extension |
| 凭据存储与加解密 | store/credentials + cipher | Extension 自有卷（§25 决策点 D2） |
| OAuth/设备码/短信/凭据导入登录流程 | providers/*/auth | Extension |
| token 刷新 | scheduler token_refresh → adapter | Extension（自行到期前刷新，Core 不再排队） |
| 配额拉取与签到领 credit | scheduler quota_sync/credit_claim → adapter | Extension（自有周期任务，按 §13 上报多资源快照） |
| CAPTCHA 状态机与人工页面 | zcode/captcha + http/app.ts 特判端点 | zcode Extension + 通用 Action 透传（§16） |
| WASM 加载 | qoder/wasm.ts | qoder Extension（本地卷挂载，缺失→NEEDS_MANUAL 语义不变） |
| 业务码→统一错误映射 | normalizer 的 providerBusinessCodes | Extension 内部（对外只说 Protocol 错误码） |
| 登录会话/captcha token 等进程态 | 各适配器 RAM | Extension 进程 + 自有卷 |

### 5.3 新增组件：Extension Manager

独立容器，职责仅限**容器生命周期管理**：install/update/remove/start/stop/rollback、镜像拉取、握手等待、健康转发。它是唯一挂载 `/var/run/docker.sock` 的组件（§20、§22）。Core 与 Manager 之间是 HTTP API，Core 不感知 Docker。

---

## 6. 目标三层架构总览

```
                        ┌────────────────────────────────────────────┐
  客户端 (CLI/IDE/Web)  │              gateway-front                 │
────────────────────────▶  Gateway Core (:8080, 公开端口)             │
                        │  ┌──────────┐ ┌──────────┐ ┌────────────┐  │
                        │  │ OpenAI   │ │ Admin UI │ │ ModelRouter│  │
                        │  │ /v1 API  │ │ /api/*   │ │ AccountPool│  │
                        │  └──────────┘ └──────────┘ └─────┬──────┘  │
                        │        Extension Registry（镜像）  │         │
                        └───────────────┬──────────────────┼─────────┘
                                        │ Extension Protocol v1 (HTTP/SSE)
                        gateway-ext-net │  (内部 bridge 网络) │
              ┌─────────────────────────┼───────────────────┼──────────┐
              │  ┌──────────────────────▼───┐   ┌───────────▼────────┐ │
   internet ◀─┼─▶│ ext-workbuddy (4 产品)    │   │ ext-manager        │ │
              │  ├──────────────────────────┤   │ (唯一持有 docker    │ │
   internet ◀─┼─▶│ ext-zcode (+captcha 人工) │   │  socket 的组件)     │ │
              │  ├──────────────────────────┤   │  install/update/   │ │
   internet ◀─┼─▶│ ext-qoder (+本地 WASM 卷) │   │  rollback/health   │ │
              │  ├──────────────────────────┤   └───────────┬────────┘ │
   internet ◀─┼─▶│ ext-trae / ext-cline / …  │               │          │
              │  └──────────────────────────┘        docker.sock         │
              │   每个扩展: 自有卷(凭据/状态)          ▼                   │
              └────────────────────────────── Docker daemon ─────────────┘
```

要点：

1. **Core 是唯一对外组件**；Extension 不发布端口，admin 流量由 Core 反向代理到 Extension（§16）。
2. **Manager 与 Core 平级**，Core 通过 Manager API 管理扩展生命周期；也可以在 Compose 里由 Manager 统一拉起 Core（推荐，见 §21 注）。
3. 每个 Extension 自带持久卷，存放凭据与流程状态；Core 的 SQLite 只存镜像数据。
4. Extension 对公网（各家上游 API）直接出站；对内只与 Core、Manager 通信。

---

## 7. Extension Protocol v1 总览

- **传输**: HTTP/1.1，JSON body（UTF-8）；流式聊天与长任务事件用 SSE（`text/event-stream`）。
- **方向**: Core 是唯一客户端；Extension 是服务端，监听容器内端口（默认 `8080`，manifest 可声明）。
- **鉴权**: 安装时 Manager 为每个 Extension 生成随机 token，注入容器环境变量 `GATEWAY_EXTENSION_TOKEN`；Core 每次调用带 `Authorization: Bearer <token>`。Extension→Core 的回调（如事件上报）用 Manager 签发的 `GATEWAY_CORE_TOKEN`。均只在 `gateway-ext-net` 内网传输，且网络层面仅 Core/Manager 的 IP 可达。
- **媒体类型**: `application/json`；SSE 帧 `event:` + `data:`。
- **版本**: manifest 声明 `apiVersion: "1.x"`；语义化兼容规则见 §22。
- **错误信封**: 所有非 2xx 响应返回 §14 定义的统一错误对象（Protocol 层错误也复用它，如 `PROTOCOL_VIOLATION`、`EXTENSION_UNAVAILABLE`）。
- **幂等与超时**: Core 对非流式调用默认 30s 超时；`/v1/chat` 流式首块超时默认 60s（沿用现有 first-token 超时语义）；幂等键 `X-Request-Id` 透传用于追踪。

### 端点一览（Extension 必须实现）

| 方法 | 路径 | 用途 | 对应现有接口语义 |
|------|------|------|-----------------|
| GET | `/manifest` | 声明 providers/models/capabilities/actions | `Provider` 接口 + `capabilities` |
| GET | `/health` | Extension 进程健康（≠ 上游 API 健康） | `ops.healthCheck` 的容器面 |
| GET | `/v1/models` | 实时模型目录（拉取面） | `chat.listModels` |
| GET | `/v1/accounts` | Extension 侧账号清单（含凭据形态摘要，不含凭据） | pool 的 listAccounts |
| POST | `/v1/accounts` | 创建账号（登录流程起点，见 §16） | `auth.beginLogin` |
| GET | `/v1/accounts/:id` | 单账号详情（状态、manual_action） | account 行 |
| POST | `/v1/accounts/:id/refresh` | 主动刷新凭据 | `ops.refreshAccount` |
| GET | `/v1/accounts/:id/quota` | 多资源配额快照（§13） | `ops.getQuota` |
| POST | `/v1/accounts/:id/claim` | 触发签到/领 credit | `ops.claimCredit` |
| POST | `/v1/chat` | 聊天（非流式 JSON / 流式 SSE，`stream` 参数区分） | `chat.chat/stream` |
| POST | `/v1/actions/:action` | 交互式动作透传（captcha 提交、短信码、凭据导入等，§16） | http/app.ts 特判端点的通用化 |

Core 侧回调（Extension→Core，可选实现）：`POST {core}/internal/ext-events`（状态/配额变更推送，v1 允许 Extension 只用轮询而不推送）。

### 7.1 协议属性

- **传输透明 vs 语义透明**：Core 对 Extension 载荷只做路由与镜像，不理解其内容；唯一语义加工点是模型路由（剥离 `provider::` 前缀）与错误码消费。
- **无服务器亲和**：Extension 容器无状态重启可恢复（状态在自有卷），Core 对同一 Extension 的多副本不做假设（v1 单副本）。
- **可见性分级**：凭据/会话（永不离开 Extension）< 上游原始载荷（不出 Extension）< 规范快照（镜像进 Core）< 路由状态（Core 合成）。数据只降级上行，不升权下行。

---

## 8. Manifest 与 Health 端点规范

### GET /manifest

Extension 启动后即可响应、无需凭据。Core 在握手与每次启动同步时调用；响应体必须与 `extension.yaml` 一致（运行时可覆盖 `models` 目录部分）。

```json
{
  "extension": { "id": "zcode", "version": "1.2.0", "apiVersion": "1.0" },
  "providers": [
    {
      "id": "zcode",
      "displayName": "ZCode",
      "protocol": "anthropic-messages",
      "capabilities": {
        "supportsOAuth": true, "supportsRefreshToken": true,
        "supportsQuota": true, "supportsCredits": false,
        "supportsStreaming": true, "supportsVision": false,
        "supportsToolCall": true, "supportsMultipleAccounts": true,
        "needsCaptcha": true, "loginMode": "oauth"
      },
      "actions": [
        { "id": "captcha-widget", "method": "GET",  "title": "Fetch captcha widget params", "auth": "admin" },
        { "id": "captcha-submit", "method": "POST", "title": "Submit captcha verify param", "auth": "admin" }
      ],
      "accountFields": [
        { "name": "email", "required": false, "description": "display hint only" }
      ]
    }
  ]
}
```

`actions` 是 §16 交互通道的声明面：Core 据此渲染 admin UI，不经翻译直接反代到 `/v1/actions/:action`。**Core 永不解释 action 内容**——zcode 的 widget 参数、页面 HTML、verifyParam 全部是 Extension 与浏览器之间的私有事务。

### GET /health

两级健康必须分开（这是与现状 `ops.healthCheck` 混在一起的关键修正）：

- **Extension 进程健康**（本端点）：`healthy` = 进程活着且能服务；`degraded` = 部分账号不可用但仍可服务；`unhealthy` = 无法服务（如必需的本地资源缺失——qoder WASM 缺失时进程健康但所有账号 `needs_manual_action`，Extension 本身仍是 `healthy`）。
- **上游/账号健康**（/v1/accounts 的 per-account 状态 + §18 的聚合视图）：区分容器挂 / 上游 API 挂 / token 过期 / 配额耗尽 / 需人工，见 §15。

```json
{ "status": "healthy", "uptimeSec": 3600, "version": "1.2.0", "accounts": { "total": 3, "usable": 2 } }
```

---

## 9. Model Contract

### 公共模型 ID

延续现状：对外模型 ID 为 `provider::model`（如 `zcode::glm-4.7`）。规则：

- Core 的 ModelRouter 已支持裸 `model`（按优先级选 provider）与 `provider::model` 精确路由，**协议化后语义不变**。
- Extension 只见到裸 `model`（如 `glm-4.7`）；`provider::` 前缀由 Core 剥离——Extension 的 provider 身份来自容器与 manifest，不来自 URL。
- 同一 Extension 可声明多个 provider 条目（buddy 族 4 产品同容器），因此路由键仍是 `provider::model` 而非 `extension::model`；`provider` 与 `extension` 是多对一。

### 9.1 标识符与命名空间（Identifiers & Namespaces）

R2 正式区分四个标识符，**禁止假设 `extension_id === provider_id`**：

```text
extension_id  = buddy            （安装/容器/镜像单元，GHCR 仓库名后缀）
provider_id   = workbuddy        （路由键组成、capabilities/actions 归属单元）
              = workbuddy-cn
              = codebuddy
              = buddy-intl
account_id    = workbuddy-a1b2   （单个上游账号实例，全局唯一）
model_id      = workbuddy::claude-x
              = buddy-intl::claude-x   （同模型可由多 provider 提供）
```

| 标识符 | 命名空间与格式 | 分配者 | 唯一性范围 | 用途 |
|--------|--------------|--------|-----------|------|
| `extension_id` | `[a-z0-9-]+`，GHCR 仓库 `gateway-extension-<id>` 后缀 | Extension 作者，Manager 安装时查重 | 部署内唯一（全局唯一靠索引/注册时冲突检测） | 容器名、Manager 生命周期操作、action 反代路径 `/api/ext/:extensionId/...` |
| `provider_id` | `[a-z0-9-]+`，属于某个 extension 的 providers[] 条目 | Extension 作者 | **部署内全局唯一**（跨 Extension 也不得冲突；Core providers 表主键兑底） | 路由键 `provider::model`、accounts/quotas 镜像行的 provider 列、admin URL |
| `account_id` | 不透明标识；**Core 分配并保证全局唯一**（建议 `provider_id-短随机`，格式仅建议非契约） | **Core** | 全局唯一 | 聊天派单（`account_id`）、镜像行主键、Extension 内部映射到上游账号的本地键 |
| `model_id` | 对外 `provider::model`；Extension 内部只见裸 `model` | Extension 作者定义裸名 | provider 内唯一 | 路由、聊天请求、models 表 |

关系约束：① `provider_id → extension_id` 是 **N:1**（一个容器多个 provider 条目），Core 从注册信息解析归属，无需从 id 猜测；② `account_id → provider_id → extension_id` 链路由 Core 维护（镜像行），Extension 只需维护 `account_id → 上游账号 ID` 的私有映射；③ 同一上游账号在不同 provider_id 下视为不同 account（如 workbuddy 与 workbuddy-cn 各自登录）；④ `extension_id` 永不出现在对外 API（客户端只见 `provider::model`），`provider_id` 永不出现在 Extension 收到的载荷中（容器身份即上下文）。

### 模型发现：push + pull 双通道

| 通道 | 触发 | 流程 | 对应现状 |
|------|------|------|---------|
| **push（静态种子）** | 安装/握手时 | manifest 的 `providers[].models`（可选）→ Core upsert models 表 | `register.ts` 时 registry.list() 写 providers 表 |
| **pull（动态目录）** | 登录成功后；Core 侧手动"同步模型"；Core 每日低频巡检 | Core 调 `GET /v1/models`（带 `account_id`）→ upsert | `login-service.syncModels()` |

设计取舍（备选过的方案）：纯 push（manifest 写死目录）简单但上游加模型要发版；纯 pull（Core 每次实时问）新鲜但启动依赖 Extension 可用。**推荐双通道**：manifest 提供 `fallbackModels` 保底（继承 buddy 的 `fallbackModels` 设计），pull 结果覆盖种子；模型表增加 `source: 'manifest' | 'extension'` 标记便于清理。

```json
// GET /v1/models 响应
{ "models": [
  { "id": "glm-4.7", "displayName": "GLM-4.7", "capabilities": { "vision": false, "toolCall": true, "streaming": true } }
] }
```

---

## 10. Account Contract

### 10.1 统一账号状态

Core 现有 `AccountStatus` 九态**原样升格为协议枚举**（Core 与 Extension 双端同表，Extension 内部可自由使用私有中间态，但对外上报必须映射到以下之一）：

| 状态 | 语义 | 谁产生 |
|------|------|--------|
| `active` | 可用 | Extension |
| `healthy_low_quota` | 可用但余量低（阈值 Extension 自定，默认 20%） | Extension |
| `rate_limited` | 上游限流中（带 `rateLimitedUntil`） | Extension |
| `token_expired` | 凭据过期且自动刷新未成功 | Extension |
| `auth_failed` | 凭据被上游拒绝（刷新也无望） | Extension |
| `quota_exhausted` | 配额/余额耗尽 | Extension |
| `cooldown` | Core 侧失败冷却（pool 状态机，Extension 不可上报此态） | **Core only** |
| `disabled` | 运营者手动停用 | 运营者（经 Core） |
| `needs_manual_action` | **需要人工介入**（captcha / sms / 重新登录 / 本地资源缺失 / 不可领的 credit） | Extension |

两个约束：

1. **`cooldown` 是 Core 的调度内部态**，Extension 不上报；Protocol 错误码 `RATE_LIMIT`/`UPSTREAM_5XX` 触发 Core 现有指数退避（60s→30min），行为与今天完全一致。
2. **`needs_manual_action` 必须携带结构化动作描述**，Core UI 据此渲染，**不允许把 zcode 的 captcha 细节（widget id、scene、verifyParam 字段名）泄漏进 Core**：

```json
{
  "account_id": "zcode-852e463a",
  "status": "needs_manual_action",
  "manual_action": {
    "kind": "captcha",
    "instructions": "Open the verification page, complete the slider, then retry.",
    "actions": [
      { "action_id": "captcha-widget", "label": "Open captcha", "method": "GET", "ui": "browser" },
      { "action_id": "captcha-submit", "label": "Submit result", "method": "POST",
        "input_schema": { "type": "object", "properties": { "verify_param": { "type": "string" } }, "required": ["verify_param"] } }
    ]
  }
}
```

Core 对 `manual_action` 的处理是纯机械的：渲染 `instructions`、把 `actions` 变成按钮、把用户输入按 `input_schema` 反代到 `/v1/actions/:action`。kind 枚举（`captcha | sms | relogin | local_resource | other`）只用于图标与排序。**这是消除 C2 耦合的关键设计**：zcode captcha 从"Core HTTP 层的特判路由"变成"所有 Extension 都可用的通用动作通道的一个实例"。

### 10.2 账号所有权边界

- **Extension 是账号事实源**：凭据、登录流程、per-account 状态都归 Extension（§3.5 Ownership Matrix；Core 侧 accounts 行只是只读投影）。
- **Core 不成为第二个可写账号事实源**：Core 对账号投影的写操作仅限三种——① 镜像同步（来自 Extension 上报）；② `disabled` 开关（运营者意图，经 enable/disable 端点下推，Extension 拒绝则镜像回滚）；③ 清空重建（数据修复）。Core 永不创建/修改凭据字段、永不合成账号状态。

### 10.3 账号开通与凭据红线（Credential Boundary）

**正式规则：Core may orchestrate credential setup but must never inspect credential plaintext.** Core 可以编排开通流程（发起、轮询、转发动作、展示状态），但协议中**不存在**任何让凭据明文流经 Core 的字段或路径。

**禁止的协议形态**（以下形式在 Protocol v1 中不存在，Core 必须拒绝解析并 Manager 拒绝注册声明此类字段的 Extension）：

```http
POST /v1/accounts
{
  "access_token": "..."
}
```

任何把 `access_token` / `refresh_token` / `password` / `api_key` / `secret` / `session_key` / cookie 串作为**账号创建或账号更新请求字段**出现的设计，均违反凭据红线。同理禁止：Core 侧"代填凭据"的表单字段、Core 日志记录动作载荷原文、Core 对 action 载荷做字段级透镜/转存。

**凭据进入系统的唯一合法路径**：凭据从浏览器/运营者终端直达 Extension（经 §16 通用 action 通道或登录流程），全程被 Core 视为 opaque 载荷：

| 开通方式 | 凭据路径 | Core 所见 |
|----------|---------|----------|
| OAuth / device-code / external-link | 浏览器 → Extension 的 authorization flow → Extension 自存 | 仅 authorization_url 与状态 |
| SMS | 浏览器提交验证码 → action `submit-code` → Extension 换取 token 自存 | opaque 载荷 |
| **统一导入（disk-credential / import 合并）** | 浏览器 → action `submit-credential`（字段由 Extension 的 input_schema 定义，例：`{session_key, region}`；约束见 §16.4）→ Extension 校验+加密自存 | opaque 载荷（尺寸受限） |
| 迁移自旧版单体（D2 路径） | 见 §24.4：Core 在迁移窗口内**纯内存转发**旧凭据到 Extension 的 `import` action，转发后清内存、随 Phase 4 删除解密代码路径 | 不解析、不落盘、不写日志 |

约束细节：① action 通道的传输安全由内网 + token 保证（§7）；② action 载荷仅存于请求生命周期内存，Core 不缓存、不落盘、不进 events（events 只记"某账号发生了 submit-credential"这一事实与结果码）；③ Extension 必须在收到后立即校验并加密落卷，响应只返回结果码（如 `IMPORT_OK` / `IMPORT_REJECTED(reason)`），不回显明文；④ input_schema 中不得出现要求 Core 端存储的字段。

> 与现状的关系：今天单体里 `submitCredential` 也是 admin 端点直收凭据——R2 把"admin 终端 → Gateway → Extension"收敛为唯一通道并明确 Core 的 opaque 转发角色；旧单体路径在 Phase 4 随 C5 一并消亡。

- **`POST /v1/accounts`（begin）**：请求 `{ "login_mode": "oauth|device-code|external-link|sms|disk-credential|import", "display_name"?: "...", "phone"?: "..." }`，响应 `{ "account_id", "status": "pending", "authorization_url"?, "expires_in"?, "poll_interval" }`——字段与现有 `LoginBeginResult` 对齐，Core 无需改造登录 UI 数据模型。pending 期账号在 Core 侧仍是一行 `pending` account（现状语义保留）。该请求体只含开通方式与展示信息，**无任何凭据字段**（本节红线）。

### 10.4 账号镜像与开关同步

- **Core 存镜像行**（现有 accounts 表减去敏感列）：id、provider、display name、status、enabled、rateLimitedUntil、lastError（脱敏）、provider_metadata_json。镜像通过两条路同步：Core 轮询 `GET /v1/accounts`（默认 60s，兜底）+ Extension 事件推送 `POST /internal/ext-events`（可选，降低延迟）。
- Core 侧 `enabled/disabled` 开关变化通过 enable/disable 端点下推（1.x 加法，属于 §3.5 所述唯一的"Core 发起、双向确认"写路径）：`POST /v1/accounts/:id/enable|disable`。

---

## 11. Chat Contract

### 11.1 请求与转换层

```json
POST /v1/chat
{
  "account_id": "zcode-852e463a",
  "model": "glm-4.7",
  "messages": [ { "role": "user", "content": "..." } ],
  "tools"?: [...], "tool_choice"?: "...",
  "max_tokens"?: 1024, "temperature"?: 0.7,
  "stream": true,
  "request_id": "req_01J...",
  "deadline_ms": 120000
}
```

- `account_id` 由 Core 指定：**选账号是 Core（pool）的职责，Extension 不做账号选择**。Core 现有 failover 逻辑（先刷新后切换、最多 3 个账号、流开始后不转移）在 Core 层不变，只是每次尝试变成一次 Extension 调用。
- Extension 负责**三层转换**：统一消息格式 → 上游协议体（anthropic-messages / openai-chat / 私有）；上游响应/事件流 → 统一 chunk；上游错误 → §14 错误码。现有 `toAnthropicBody`、`anthropicEventToChunk`、buddy 的 `toUpstreamBody/handleData` 等代码几乎原样平移。
- 流式响应：`200 + text/event-stream`，帧格式：

```
event: chunk
data: {"type":"content","delta":"Hello"}

event: chunk
data: {"type":"tool_call_delta","index":0,"delta":"{\"na"}

event: done
data: {"finish_reason":"stop","usage":{"input_tokens":10,"output_tokens":25}}
```

错误在流内以终止帧表达（`event: error` + §14 错误对象），与现在 `http/app.ts` 的 mid-stream error frame 语义对齐；客户端断连时 Extension 收到连接关闭，自行清理上游（对应现状 `ReadableStream.cancel`）。

- **凭据永不过网到 Core**：Extension 用 `account_id` 解自己的本地凭据（消除 C5 的对外半边）。Extension→上游仍按各 Provider 原样带 token/签名。

### 11.2 非流式

同端点 `stream: false` → `200` JSON：`{ "content": [...], "finish_reason": "...", "usage": {...} }`。语义对齐现有 `ChatResult`。

---

## 12. extension.yaml Manifest 规范

Manifest 是 Extension 的安装声明，随 GitHub Release 资产分发，Manager 安装前校验。完整示例（zcode）：

```yaml
apiVersion: "1.0"                    # 协议主.次版本（§22）
extension:
  id: zcode                          # 全局唯一，[a-z0-9-]
  version: "1.2.0"                   # Extension 自身 semver
  displayName: ZCode Provider
  description: ZCode (z.ai) provider with human-completed captcha flow
  author: xiaonan-520
  license: MIT
  repository: https://github.com/Xiaonan-520/gateway-extension-zcode

distribution:
  image: ghcr.io/xiaonan-520/gateway-extension-zcode
  tag: "1.2.0"                       # Manager 实际拉取 digest 并记录，便于回滚
  digest: sha256:abcd...             # 可选：安装时校验
  releaseUrl: https://github.com/Xiaonan-520/gateway-extension-zcode/releases/tag/v1.2.0

runtime:
  port: 8080                         # 容器内监听端口
  healthPath: /health
  env:                               # 允许运营者注入的键（白名单，§20）
    - name: LOG_LEVEL
      required: false
      default: info
  volumes:                           # 声明式卷，仅限命名卷
    - name: zcode-state
      mountPath: /data
      purpose: credentials + flow state
  resources:
    memory: 256Mi
    cpus: "0.5"

security:
  permissions:                       # 声明面（audit-only），运行时隔离见 §12.2 与 §20.3
    network: ["zcode.z.ai", "chatglm.cn"]   # 出站域名
    filesystem: "named-volumes-only"        # 禁 host bind / 禁 /var/run
    capabilities: "none"                    # cap_drop ALL
    privileged: false
  secrets:                           # 需要运营者提供的机密（安装时输入）
    - name: ZCODE_PORTAL_TOKEN
      description: optional pre-issued portal token (disk-credential mode)
      required: false

providers:                            # 一个容器可暴露多个 provider 条目
  - id: zcode
    displayName: ZCode
    protocol: anthropic-messages
    capabilities: { needsCaptcha: true, loginMode: oauth, supportsStreaming: true,
                    supportsQuota: true, supportsMultipleAccounts: true, ... }
    fallbackModels:                   # 静态种子（§9）
      - { id: glm-4.7, name: "GLM-4.7" }
    actions:                          # 交互通道声明（§16）；字段含 input/output schema + mode + sideEffects
      - { id: captcha-widget, method: GET,  title: "Open captcha",  ui: browser }
      - { id: captcha-submit, method: POST, title: "Submit captcha" }
    accountFields: []
```

校验规则（Manager 落地时实现）：`apiVersion` 大版本必须被 Core 支持；`extension.id` 与镜像 tag 一致性检查；`providers[].id` 全局唯一（不能与已装 Extension 冲突）；`security.volumes` 禁止 `hostPath`；`env` 白名单外拒绝。

### 12.1 权限声明

`security.permissions` 各字段的含义：

```yaml
security:
  permissions:
    network: ["zcode.z.ai", "chatglm.cn"]   # 意图声明的出站域名清单
    filesystem: "named-volumes-only"        # 存储形态承诺（非请求）
    capabilities: "none"                    # 声明不需要任何 Linux capability
    privileged: false                       # 声明不需要特权模式
```

### 12.2 声明 ≠ 强制（Declared Permissions vs Enforced Isolation）

**R2 明确：v1 中 `security.permissions` 是 declaration / audit-only，不是运行时隔离承诺。** 必须避免给用户造成"声明了域名就已经限制了网络访问"的错误印象：

| 面 | v1（声明） | 未来版本（强制） |
|----|-----------|----------------|
| 出站网络 | `permissions.network` 仅在**安装确认页展示**并写入审计日志；运行时 Extension 可访问任意可达域名 | egress proxy / Docker network policy 按 allowlist 强制（§20.3 路线图） |
| 文件系统 | `filesystem: named-volumes-only` 是**安装时契约**：Manager 落盘为命名卷参数并**拒绝声明之外的 mount**（这项在 v1 即强制，因为它由 Manager 侧完全掌控） | 同左（已强制） |
| capabilities / privileged | 声明供审计；Manager 落盘时**一律 drop ALL / 不给特权**，声明值仅用于"作者多要了"时发出警告 | 声明与落盘参数一致性校验，不一致拒绝安装 |
| Docker socket | 无声明面——**任何 Extension 一律不挂**（§19），无例外路径 | 同左 |

因此 R2 措辞统一为：**"v1 的隔离来自 Manager 落盘的容器参数（namespace/capabilities/volumes/无端口）+ 网络位置；manifest 声明用于展示与审计，出站网络在 v1 未被强制约束。"** UI 文案在安装第三方 Extension 时必须原文呈现这句话。

---

## 13. Quota / Credit Contract（多资源）

### 13.1 动机

现状 `QuotaSnapshot` 单资源（remaining/total/resetAt），但真实上游至少有三类并存：buddy 族的"每日签到 gift credits + 付费 credits"，zcode 的"套餐配额 + 现金余额"，cline 已被迫自造 `unit: 'raw'`。多资源模型是 Protocol 化前必须定型的契约（DB 表结构变更见 §25 决策点 D3）。

### 13.2 资源数据结构

```jsonc
// GET /v1/accounts/:id/quota
{
  "account_id": "workbuddy-abc",
  "resources": [
    {
      "id": "gift_credits",                 // 资源实例 id（Extension 命名空间内稳定）
      "kind": "credits",                    // credits | tokens | requests | subscription | custom
      "remaining": 12.5,
      "total": 20,
      "used": 7.5,
      "unit": "credits",                    // 自由字符串：credits / tokens / requests / USD / raw…
      "resetAt": "2026-10-04T00:00:00+08:00",
      "status": "ok",                       // ok | low | exhausted | reset_pending | unclaimable | unknown
      "metadata": { "source": "checkin", "streakDays": 6, "dailyCredit": 20 }
    }
  ],
  "checkedAt": "2026-10-03T12:00:00Z",
  "source": "authoritative"                 // authoritative | cached | estimate
}
```

约束：

- `kind` 是封闭枚举，UI 只按 kind 选图标与排序；**一切数量语义由 `unit` 表达，UI 永不按 provider 分支**（消除现状 `unit: 'raw'` 这类语义逃逸的传染性）。
- `status` 表达资源级状态：`unclaimable` 对应现状 credit_claim 的"活动未开始/今日已领"；`exhausted` 触发 Core 把账号镜像置 `quota_exhausted`。
- `source: authoritative` 表示 Extension 真读了上游（对应现状"适配器先读权威状态"的调度纪律）；Core 调度快照任务改为轮询本端点。
- 未实现配额的 Extension 返回 `{ "resources": [] }`，Core 显示"未知"而不是造假数。
- **规范快照的权威在 Extension 侧**（§3.5）：Core 的 quotas 表只是只读投影，可随时从 Extension 全量重建；Core 侧对投影的任何"修正"都不构成权威变更。

### 13.3 三个真实 Provider 的示例

**WorkBuddy（buddy 族协议，签到 gift + 付费）**：

```json
{ "account_id": "workbuddy-01", "checkedAt": "2026-10-03T09:30:00Z", "source": "authoritative",
  "resources": [
    { "id": "gift_credits", "kind": "credits", "remaining": 20, "total": 20, "used": 0,
      "unit": "credits", "resetAt": "2026-10-04T00:00:00+08:00", "status": "ok",
      "metadata": { "source": "checkin", "todayCheckedIn": true, "streakDays": 6, "isStreakDay": true } },
    { "id": "paid_credits", "kind": "credits", "remaining": 143.5, "total": null, "used": null,
      "unit": "credits", "resetAt": null, "status": "ok", "metadata": { "source": "purchase" } }
  ] }
```

**CodeBuddy（同族协议，capability 关闭 credits 时 gift 资源缺席）**：

```json
{ "account_id": "codebuddy-02", "checkedAt": "2026-10-03T09:31:00Z", "source": "authoritative",
  "resources": [
    { "id": "gift_credits", "kind": "credits", "remaining": 0, "total": 15, "used": 15,
      "unit": "credits", "resetAt": "2026-10-04T00:00:00+08:00", "status": "reset_pending",
      "metadata": { "source": "checkin", "todayCheckedIn": false, "claimStatus": "activity_not_started", "code": 1003 } },
    { "id": "plan_tokens", "kind": "tokens", "remaining": 1250000, "total": 5000000, "used": 3750000,
      "unit": "tokens", "resetAt": "2026-11-01T00:00:00+08:00", "status": "ok", "metadata": {} }
  ] }
```

**ZCode（套餐订阅 + 现金余额，余额来自 billing/balance 双端点）**：

```json
{ "account_id": "zcode-852e463a", "checkedAt": "2026-10-03T09:32:00Z", "source": "authoritative",
  "resources": [
    { "id": "plan_quota", "kind": "subscription", "remaining": 640, "total": 1000, "used": 360,
      "unit": "requests", "resetAt": "2026-10-31T00:00:00+08:00", "status": "low",
      "metadata": { "plan": "pro", "billingEndpointFields": ["remaining", "total"] } },
    { "id": "cash_balance", "kind": "custom", "remaining": 3.17, "total": null, "used": null,
      "unit": "CNY", "resetAt": null, "status": "ok", "metadata": { "source": "balance" } }
  ] }
```

> 兼容说明：Core 的 quotas 表迁移前，v1 实现 可把多资源 JSON 序列化进现有 `raw_json` 列、`remaining/total` 列存第一个资源（渐进迁移路径，避免 Phase 1 就动 schema）。

---

## 14. 统一错误模型（Error Contract）

现状 `UpstreamErrorKind` 11 种**原样升格为协议错误码**（Extension 内部完成业务码→kind 映射，C4 全局注册表随之消亡）：

```jsonc
// HTTP 非 2xx / 流内 error 帧
{
  "error": {
    "kind": "RATE_LIMIT",                 // 11 种之一（下表）
    "message": "human-readable, no secrets",   // 已脱敏（现状纪律保留）
    "http_status": 429,
    "retryable": true,
    "retry_after_ms": 30000,              // 可选；RATE_LIMIT 可带
    "model_reset_at_ms": 1760000000000,   // 可选；per-model 冷却（现状 ModelRateLimit 语义）
    "detail": { /* provider 无关的结构化补充，可选 */ }
  }
}
```

| kind | 语义 | Core 处置（不变） |
|------|------|------------------|
| `AUTH_INVALID` | 401/403 凭据被拒 | 原地刷新一次→重试→换号 |
| `TOKEN_EXPIRED` | 已知过期 | 同上（刷新路径） |
| `RATE_LIMIT` | 429/排队/并发 | 冷却 + 可能换号 |
| `QUOTA_EXHAUSTED` | 余额/配额尽 | 停用账号 + 换号 |
| `TIMEOUT` | 首 token/块间空闲超时 | 可重试 |
| `TRANSPORT` | 网络/DNS/连接 | 快速重试 |
| `UPSTREAM_5XX` | 上游临时故障 | 有限重试 |
| `TERMINAL` | 业务拒绝/参数错误 | 立即失败 |
| `EMPTY_RESPONSE` | 上游空响应 | 可重试 |
| `NEEDS_CAPTCHA` | 需要人工 captcha（zcode 专用语义，但码位通用） | 立即失败 + 账号置 `needs_manual_action` |
| `NEEDS_MANUAL` | 其他人工介入（sms/重登/本地资源） | 同上 |

Protocol 层自身错误（Core↔Extension 通信失败）映射为 `TRANSPORT`（连不上/超时，走换号转移）——这与现状"上游 API 挂了"的处置天然一致。`PROTOCOL_VIOLATION`（响应不合 schema）为协议保留码，Core 记 events 并按 `TERMINAL` 处置该次请求。

---

## 15. Health Contract（五态区分）

Core/Manager 聚合四个信息源，回答"到底哪里坏了"：

| 故障 | 判定来源 | 表现 |
|------|---------|------|
| 容器挂 / Extension 进程挂 | Manager：docker 状态 + `/health` 超时（3 次） | Core 标记该 Extension 全部 provider `unavailable`；UI 显示 "extension down"；聊天请求直接按 `TRANSPORT` 转移 |
| Extension 活着但上游 API 挂 | Extension `/health` 的 `degraded` 或账号级 `TRANSPORT`/`UPSTREAM_5XX` 聚合 | 账号保持 `active` 但带 lastError；Core 继续尝试（现状语义） |
| token 过期 | 账号 `token_expired` | Extension 先自行刷新（§5.2），刷不动才上报 |
| 配额耗尽 | 账号 `quota_exhausted` 或资源 `status: exhausted` | 停止派发该账号 |
| 需人工 | 账号 `needs_manual_action` + `manual_action` | UI 渲染动作按钮（§10.1） |

判定责任分层：**Manager 判"容器面"，Extension 判"上游面"，Core 只做聚合与呈现，不做任何 provider 特判**。现状 `ops.healthCheck`（30min 周期）保留为 Core 的兜底巡检，改为调用 Manager 聚合接口。

---

## 16. 交互式流程 Contract（CAPTCHA / SMS / 凭据导入 / Action 透传）

这是对现状 C2 特判端点的通用化，也是本 RFC 唯一新增的协议概念：

1. Extension 在 manifest `providers[].actions` 声明动作（id/method/**input_schema/output_schema/mode/sideEffects/ui**，见 §16.4）。
2. 账号进入 `needs_manual_action` 时，响应携带 `manual_action.actions[]` 引用这些动作。
3. Core 提供**通用反代**：`GET|POST /api/ext/:extensionId/providers/:providerId/actions/:action` → Extension `/v1/actions/:action`，透传请求与响应体（Core 校验 action 已声明 + admin 鉴权 + 尺寸上限，其余不理解）。
4. `ui: browser` 的动作（如 zcode 的 captcha 页面）：Core 返回 Extension 产出的 HTML/参数原样给浏览器；提交也走反代。**zcode 的 widget 参数、verifyParam、页面全部留在 Extension 内。**

各模式落到同一通道：

| 流程 | 承载 |
|------|------|
| ZCode captcha（人工完成） | `captcha-widget` (GET, ui=browser) + `captcha-submit` (POST) |
| SMS 验证码（`loginMode: sms`） | 登录 begin 返回 pending → `submit-code` action 提交验证码 |
| 凭据导入（disk-credential / import） | `submit-credential` action + `input_schema` 定义字段（现状 `submitCredential` 语义平移）；字段示例与约束见 §10.3，凭据永不经 Core 明文化（§10.3 红线） |
| 重新登录 | `relogin` action 返回新 authorization_url |
| Qoder WASM 缺失 | 无 action，`needs_manual_action(kind: local_resource)` 提示运营者挂载文件 |

合规边界在此固化：协议层面**不存在**"求解"动作位——Extension 声明的任何 action 都可被审计，zcode Extension 只实现官方组件嵌入 + 人工提交。

### 16.4 Action 硬约束（Non-RPC Discipline）

R2 明确：Action 通道是**窄口面的交互通道**，不是通用 RPC，更不得成为 Docker/host 控制通道。约束如下：

1. **仅限声明**：Core/Manager 只能调用 manifest `providers[].actions[]` 中已声明的 action；未声明的 action id 一律 404，且事件留痕（连续未声明调用可告警）。不存在任意路径透传、不存在通配 action。
2. **Schema 双向**：每个 action 必须声明 `input_schema` 与 `output_schema`（JSON Schema）；Core/Manager 安装时校验 schema 合法性，运行时请求/响应超限或类型不符即拒绝，不做内容解释。
3. **副作用分级（mode / sideEffects）**：

```yaml
actions:
  - id: captcha-widget            # 合法示例：ZCode 官方组件渲染 + 人工提交
    method: GET
    mode: read                    # read | write | flow-control
    sideEffects: none             # none | idempotent | one-shot
    output_schema: { type: "object", properties: { html: { type: "string" }, params: { type: "object" } } }
    ui: browser
  - id: captcha-submit
    method: POST
    mode: write
    sideEffects: one-shot         # 提交一次即消耗；重试需重新取 widget
    input_schema:  { type: "object", properties: { verify_param: { type: "string" } }, required: ["verify_param"] }
    output_schema: { type: "object", properties: { accepted: { type: "boolean" } }, required: ["accepted"] }
```

4. **禁止形态**（声明或实现即拒绝安装/调用）：任意命令执行、eval/动态代码加载、子进程派生、任意端口/主机连接代理、文件系统任意读写、**一切 Docker API / host 控制语义**（挂载 docker.sock、请求 hostPath、请求 privileged 均在 Manager 校验层直接拒绝，见 §19.5）。Action 的表达力边界 = "凭据/人工交互/状态查询的 HTTP 表达"。
5. **透传不放大**：Core 反代只做鉴权/白名单/尺寸/超时/Content-Type 五项检查（§19.4），不理解不缓存内容；载荷不进 events 明文（§10.3）。
6. **合规不变式**：CAPTCHA 只允许**官方 widget + 人工完成**，不提供 solver/bypass——协议层面无"求解"动作位，任何声称 solver 的 action 声明在安装时即被拒绝，与 v1.0 的合规设计完全一致。

---

## 17. Extension Manager 设计

独立容器 `gateway-extension-manager`，单一职责：**容器生命周期 + 注册协调**。不实现任何 provider 逻辑，不保存凭据，不直接服务聊天流量。

### 17.1 Manager API（对 Core / 对运维 UI）

```
GET  /api/extensions                    已安装列表（含版本、状态、健康聚合）
POST /api/extensions/install            { source: github-release | ghcr | local-tarball, ref }
POST /api/extensions/:id/update         { toVersion? }
POST /api/extensions/:id/remove         { purgeData?: false }
POST /api/extensions/:id/start|stop|restart
POST /api/extensions/:id/rollback       { toDigest? }        # 默认上一版本
GET  /api/extensions/:id/health         容器面健康（Manager 视角）
GET  /api/extensions/available          可用目录（GitHub Release 索引，§19）
```

鉴权：`GATEWAY_MANAGER_TOKEN`（与 Core、运维端共享）。

### 17.2 安装/更新流程（GitHub → manifest → GHCR → 容器 → 握手 → 注册）

```
1. resolve    从 GitHub Release 取 extension.yaml（release 资产）→ 校验 apiVersion、
              extension.id 与请求一致、security 段合规（无 hostPath/cap 无/docker.sock；
              actions 三要素完整，§16.4）；镜像 namespace 在 allowlist 内（§19.5）
2. pull       按 distribution.image@tag 拉 GHCR 镜像，记录解析出的 digest
3. create     创建容器：gateway-ext-net 网络、命名卷、env 白名单、cap_drop ALL、
              无公开端口、labels: { gateway.extension.id, version, digest, managed-by: manager }
4. handshake  轮询 GET http://<container>:port/health（默认 30s 超时）→ GET /manifest
              → 校验 manifest 与 extension.yaml 声明一致（providers id 集合、apiVersion）
5. register   调 Core: POST /internal/extensions/register（manifest + 容器内网地址 + token 指纹）
              → Core upsert providers 表、写入 models 种子、拉首/accounts 镜像
6. finalize   安装记录（digest、时间、manifest 快照）落 Manager 自有卷
失败处理: 第 4 步超时或第 5 步 Core 拒绝 → 删除新容器；update 场景旧容器仍在跑（§17.3）
```

### 17.3 更新与回滚

- **更新 = 蓝绿**：拉新镜像建新容器（同 id 不同 gen 后缀）→ 握手成功 → Core 原子切换注册表条目 → 旧容器 stop+rm。**握手失败/新版本协议不兼容时旧容器未被触碰，天然零回滚动作**。
- **回滚**：Manager 保留最近 N=3 个 digest 的镜像与 manifest 快照；`rollback` 重建上一代容器并重新握手注册。数据卷不随版本回退（凭据格式由 Extension 自己保证向后兼容，SDK 提供 migration 钩子）。
- Core 端注册表条目记录 `extensionVersion + imageDigest`，events 留痕，运维 UI 可见"谁在什么版本"。

---

## 18. 分发模型：官方与第三方

### 18.1 命名与命名空间

| 类别 | 镜像 | Manifest 来源 | 信任级别 |
|------|------|--------------|---------|
| 官方 | `ghcr.io/xiaonan-520/gateway-extension-{id}` | `Xiaonan-520/gateway-extension-{id}` Release | Core UI 默认展示、标 "official" |
| 第三方 | `ghcr.io/<publisher>/gateway-extension-<id>` | 任意 GitHub Release | 安装时显式确认：展示 publisher、permissions 声明、digest，要求输入确认 |

- `gateway-extension-` 前缀 + `extension.id` 是协议约定（Manager 依赖它做目录索引与默认镜像名推导）。
- Extension id 全局唯一性靠"注册时冲突检测"（后装者拒绝，Core providers 表主键兜底）。
- v1 不强制签名；`distribution.digest` 固定 + Release 关联已提供供应链可追溯性。cosign 签名列入 v2 增强（§22）。

### 18.2 目录（Registry Index）

Manager 的 `GET /api/extensions/available` 聚合一个静态索引文件（官方仓库维护 `extensions.json`：id、latest 版本、release URL、digest、permissions 摘要；第三方可提交 PR 收录）。v1 允许 `install` 直填 GitHub Release URL，绕过索引。

### 18.3 官方仓库布局（每 Extension 一个仓库，CI 模式与现有 docker.yml 相同）

```
gateway-extension-zcode/
├── extension.yaml
├── src/…                        # Extension SDK 依赖（§22）
├── Dockerfile                   # 多阶段，无宿主机依赖
└── .github/workflows/docker.yml # tag → 构建推送 GHCR + 创建 GitHub Release（附 extension.yaml）
```

---

## 19. 安全模型

### 19.1 Docker socket：Core 绝不持有

- `/var/run/docker.sock` **只挂给 Manager**（Manager 自身的边界约束见 §19.5）。Core 被攻破（暴露面最大：公网 8080）也**造不成容器逃逸面**——它连 Docker API 都够不着，最多已经注册的 Extension 流量。
- Manager 暴露面收敛：仅 `gateway-ext-net` 内可达，无公开端口；强 token。
- 备选方案（评估过）：docker-socket-proxy（收紧 API 子集）——增加组件且 Manager 本就需要 create/start/rm 全套；v1 直接挂 socket + 网络隔离即可，proxy 列为 v2 硬化项。

### 19.2 权限与容器加固（Manager 落盘为 docker 参数）

| 面 | 策略 |
|----|------|
| capabilities | `cap_drop: [ALL]`，不 `privileged` |
| 文件系统 | 仅命名卷（manifest `security.volumes` 白名单）；禁 hostPath、禁 docker.sock、禁 `/` bind |
| 出站网络 | v1 不限制（上游域名各异）；`security.permissions.network` 声明供审计；v2 可选 egress 代理强制 |
| 入站网络 | 无 `-p` 发布；仅 `gateway-ext-net` 内可达 |
| env | manifest 白名单 + Manager 注入的 `GATEWAY_EXTENSION_TOKEN`；其余拒绝 |
| 资源 | manifest `resources` → `--memory/--cpus`，防单 Extension 拖垮宿主 |
| rootfs | 鼓励 `read_only: true` + tmpfs（SDK 模板默认） |

### 19.3 Secrets

- **Provider 凭据**：存 Extension 自有卷，由 Extension 自行加密（SDK 提供 AES-GCM 模块，密钥来自安装时注入的 `GATEWAY_EXTENSION_SECRET`）。凭据**永不经 Core 中转、不落 Core DB**（消除 C5；迁移决策见 §25 D2）。
- **运营者 secrets**（如预签发的 portal token）：安装时经 Manager 输入，只注入 env，Manager 不落盘明文。
- **Core 的 `GATEWAY_SECRET`**：保留，用于 admin session/apikey 哈希等 Core 自有职责，不再用于 Provider 凭据。

### 19.4 协议面

- Core↔Extension 与 Core↔Manager 双向 token（§7）；Extension 之间网络可达但协议上互不调用，v2 可用 per-pair 网络策略收紧。
- Action 反代（§16）施加：admin 鉴权、action 白名单（manifest 声明 + §16.4 硬约束）、body 尺寸上限（1MB）、超时（30s）、响应 Content-Type 白名单（json/html）。

### 19.5 Extension Manager 自身边界（高权限组件的自我约束）

Manager 是全栈唯一的高权限组件（持有 docker.sock），因此它自己必须被当作**最敏感的安全边界**对待。Docker 边界的正式表述：

```text
Docker socket
    ↓
ONLY Extension Manager
```

| 约束 | 内容 |
|------|------|
| no public port | Manager 不发布任何宿主端口，不进 `gateway-front` 网络；仅 `gateway-ext-net` 内可达 |
| only Gateway network | 网络位置唯一：`gateway-ext-net`；不出内网、无需访问互联网（镜像拉取经 Docker daemon 执行） |
| strong authentication | 所有 API 强制 Bearer `GATEWAY_MANAGER_TOKEN`（长随机、可轮换）；token 校验失败无任何回显差异 |
| no arbitrary Docker API passthrough | Manager **不提供**任意 Docker API 代理/隧道；对外仅暴露 §17.1 的固定生命周期端点，每个端点内部映射为固定参数的 Docker SDK 调用，不接受调用方拼接的容器/镜像/挂载参数 |
| image allowlist / registry policy | 仅允许拉取 `ghcr.io/<approved-namespace>/gateway-extension-*` 形态的镜像（官方 namespace 白名单 + 第三方安装时显式确认）；禁止 `latest` 漂移（记录 digest）、禁止 docker.io 任意镜像 |
| no arbitrary hostPath | manifest 声明与 Manager 落盘参数双重校验：`hostPath` 一律拒绝（唯一例外：运营者在部署文件中手工声明的本地 WASM 卷，不走 Manager API） |
| no arbitrary privileged mode | 任何经 Manager 创建的容器：`privileged=false`、`cap_drop=ALL` 硬编码，manifest 声明与此冲突即拒绝安装 |
| no docker.sock in Extension containers | Manager 创建 Extension 容器时挂载参数白名单 = 命名卷 + tmpfs，`/var/run/docker.sock` 及任何 socket 设备挂载直接拒绝 |
| manifest 是声明，不是 Docker API | Manager 把 manifest 视为**安装意图**，逐一映射为白名单化的容器参数；两者之间的差异空间（manifest 未声明的能力）默认全拒绝（deny-by-default），不存在"manifest 没写但请求里有"的通道 |

**为什么 Gateway 被攻破 ≠ 获得 Docker daemon 控制能力**：① Core 对 Manager 的调用面仅限 §17.1 的高层生命周期 API（install/update/stop/rollback…），参数只有 extension id 与版本号——**不存在**能传递容器规格、挂载、env、entrypoint 的字段，攻击者无法借道 Core 构造恶意容器；② Manager 无公开端口，攻击者必须先穿透内网 + Manager token 两层；③ 即便 Manager 被完全控制，其代码路径也不提供任意 Docker API 透传，攻击者只能执行预定义的生命周期动作（拉白名单镜像/启停已装扩展），无法改变容器安全参数（deny-by-default 在 Manager 代码内硬编码，而非依赖调用方自律）；④ 审计面：Core→Manager 每次调用写 events，Manager→Docker 每次落盘安装日志，异常操作可回溯。

剩余风险如实陈述：Manager 自身实现漏洞（如解析恶意 extension.yaml 的内存安全问题）是本架构的**最高价值攻击面**，因此 Manager 应以最小依赖实现（不引入重型框架）、静态编译语言优先（v1 实现 TypeScript 但仅依赖 Docker 官方 SDK）、并以 read_only rootfs + 非 root 用户运行。

---

## 20. Docker 网络架构

```yaml
# 目标形态（示意，Phase 2 落地；本 RFC 阶段不落 compose）
networks:
  gateway-front:                 # Core 公开端口所在
    driver: bridge
  gateway-ext-net:               # Core ↔ Manager ↔ Extensions
    driver: bridge
    # 不设 internal:true —— 扩展需要对各家上游 API 的出站

services:
  gateway-core:
    networks: [gateway-front, gateway-ext-net]
    ports: ["8080:8080"]         # 唯一公开端口
    volumes: [core-data:/data]   # SQLite（镜像数据）
  gateway-extension-manager:
    networks: [gateway-ext-net]  # 不上 front
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock   # 全栈唯一
      - manager-data:/data
  ext-zcode:      { networks: [gateway-ext-net], volumes: [zcode-state:/data] }
  ext-workbuddy:  { networks: [gateway-ext-net], volumes: [buddy-state:/data] }
  ext-qoder:      { networks: [gateway-ext-net],
                    volumes: [qoder-state:/data, /opt/local/qoder-wasm:/opt/wasm:ro] }  # §24.7
```

要点：

1. Extension 无宿主端口；Core 是对外唯一入口（含 admin 反代到 Extension 的 action 页面）。
2. `gateway-ext-net` 不用 `internal: true`（会切断上游出站）；隔离靠"不发布端口 + token"；**v1 无出站域名强制**（§12.2/§20.3，强制隔离列入 v2）。
3. DNS 即服务发现：Core 以容器名 `ext-zcode:8080` 访问，地址由 Manager 注册时写进 Core 注册表（容器重建 IP 变化由 Docker DNS 吸收）。
4. 与现状 Compose 的差异：新增 manager 与 ext 网络；Core 现有卷 `core-data` 语义不变，平滑升级。

### 20.3 信任边界图（Trust Boundary Map）

R2 补充全栈信任边界总图，标注五类边界：**public**（匿名可达）、**authenticated-internal**（内网 + token）、**privileged**（Docker 控制面）、**credential**（明文凭据可达范围）、**Docker**（docker.sock 可达范围）：

```text
                        ┌─────────────────────────────────────────────────────┐
   Internet             │                【public boundary】                  │
 ───────────────────────▶  Gateway Core :8080（唯一公开端口）                 │
                        │  - 匿名可达面：/v1/chat/completions, /v1/models      │
                        │  - API key 鉴权面：聊天计费/限流                      │
                        │  - admin token 鉴权面：/api/*、登录、action 反代       │
                        │  持有：API key 哈希、账号/模型/配额投影               │
                        │  【不持有】：凭据明文、docker.sock、Manager token     │
                        └───────────────┬─────────────────────────────────────┘
                                        │ HTTP + Bearer token
                                        │ 【authenticated internal boundary】
                        gateway-ext-net │  （内网 bridge，无公开端口）
              ┌─────────────────────────┼──────────────────────────────────┐
              │                         ▼                                  │
              │  ┌────────────────────────────────┐  ┌───────────────────┐ │
              │  │ Extension Manager              │  │ Extension 容器 ×N  │ │
              │  │ 【privileged + Docker boundary】│  │【credential 边界内】│ │
              │  │ - 唯一挂 docker.sock           │  │ - 持凭据明文(自加密)│ │
              │  │ - 无公开端口，仅内网+强token    │  │ - 持OAuth会话      │ │
              │  │ - 固定生命周期API，无透传       │──▶ - 出站→各上游API    │ │
              │  └───────────────┬────────────────┘  └─────────┬─────────┘ │
              │                  │ docker.sock                 │ HTTPS     │
              └──────────────────┼─────────────────────────────┼───────────┘
                                 ▼                             ▼
                          Docker daemon                    Provider APIs
                          【Docker boundary 终点】          （各家公网 API）
```

边界逐条说明：

| 边界 | 位置 | 跨越条件 | 被攻破后的影响半径 |
|------|------|---------|------------------|
| public | Internet → Core | API key / admin token | 聊天额度盗用；admin 面泄露投影数据，**拿不到凭据明文**（§10.3 红线），**够不到 Docker**（§19.5） |
| authenticated-internal | Core → Manager / Extensions | 内网位置 + 各自 Bearer token | 可调用已装扩展的协议端点；不能创建/改容器 |
| privileged | Manager → Docker daemon | Manager 自身被完全控制 | 可管理扩展容器生命周期；仍受白名单/固定参数约束（deny-by-default 硬编码） |
| Docker | docker.sock 可达范围 = 仅 Manager | —— | Core/Extension 被攻破均不解锁此边界 |
| credential | Extension 容器内（卷 + 内存） | 需先突破：公网→Core→内网→Extension 四层 | 单个 Extension 泄露只影响该 provider 的账号 |

刻意的设计结果：**credential 边界与 Docker 边界零交集**——持凭据的组件（Extension）不持 socket，持 socket 的组件（Manager）不存凭据；Core 两者皆无。任何一层被攻破都不会同时解锁两条高价值边界。

---

## 21. Extension SDK（接口设计，不实现）

`@multi-provider-ai/gateway-extension-sdk`（TypeScript 优先，协议是 HTTP 所以任何语言可自行实现）：

```ts
export interface ExtensionContext {
  manifest: ExtensionManifest
  dataDir: string                        // 命名卷挂载点
  secret: Buffer                         // GATEWAY_EXTENSION_SECRET
  core: CoreClient                       // 事件上报（可选推送）
  log: Logger
}

export interface ProviderAdapter {        // 与今天 core/registry/provider.ts 同构——刻意保持迁移直觉
  readonly definition: ProviderDefinition   // id/capabilities/actions/fallbackModels
  listModels(ctx: ProviderContext): Promise<ModelInfo[]>
  chat(ctx: ProviderContext, req: ChatRequest): Promise<ChatResult>        // 非流式
  stream(ctx: ProviderContext, req: ChatRequest): AsyncIterable<ChatChunk> // 流式
  accounts(ctx: ProviderContext): Promise<AccountSnapshot[]>               // 含 manual_action
  beginLogin?(input: BeginLoginInput): Promise<BeginLoginResult>
  pollLogin?(ctx: ProviderContext, loginId: string): Promise<PollResult>
  submitAction?(ctx: ProviderContext, action: string, payload: unknown): Promise<ActionResult>
  refresh?(ctx: ProviderContext, accountId: string): Promise<RefreshResult>
  quota?(ctx: ProviderContext, accountId: string): Promise<QuotaReport>    // §13 多资源
  claim?(ctx: ProviderContext, accountId: string): Promise<ClaimResult>
}

export function serveExtension(opts: {
  manifest: ExtensionManifest
  providers: ProviderAdapter[]
  store: CredentialStore                 // SDK 提供 AES-GCM + SQLite 实现
  background?: (ctx: ExtensionContext) => NodeJS.Timer[]   // quota 巡回 / 签到 / token 刷新
}): void                                 // 起 HTTP 服务，实现 §7 全部端点
```

SDK 附带：`extension.yaml` 的 zod schema 与校验器、契约 JSON Schema（供 Core/Manager 共享）、conformance 测试套件（对实现 Extension 跑协议级黑盒测试——官方 CI 与第三方自测共用；**设计与准入时机已前置到 Phase 2/3，见 §22.1**）。

---

## 22. 协议版本兼容与 Conformance 策略（v1/v2）

- **manifest `apiVersion: "MAJOR.MINOR"`**：Core/Manager 支持当前与上一主版本（N-1）。
- **次版本演进规则**：只允许加法——新增可选字段、新增端点、新增错误码位、新增 AccountStatus/资源 kind 值（旧 Core 遇到未知值的行为定义为：AccountStatus 未知值按 `needs_manual_action` 保守处理并在 events 记录；资源 kind 未知按 `custom` 渲染）。
- **主版本升级**：Core 支持期内双跑（两个 Extension 容器并存、Core 按各自 apiVersion 路由）；过期主版本在 Manager update 时明确拒绝并提示。
- **Core 侧探测**：注册时 Core 记录 Extension 的 apiVersion；Core 自身升级后对低于 N-1 的 Extension 标记 `deprecated`（UI 提示，不阻断）。
- **错误码稳定性承诺**：11 个 kind 一经 v1 发布不再改语义；废弃只加新码。
- v2 候选清单（预先占位，避免隐性破坏）：出站网络强制（egress proxy / network policy，兑现 §12.2 的承诺空缺）、cosign 镜像签名、Extension→Core 事件推送成为必选、多机部署（Extension 分宿主）。

### 22.1 Conformance Protocol（R2 前置到 Phase 2/3）

**不再等到 Phase 5 才首次考虑一致性验证。** Conformance Suite 的规范设计现在就冻结，作为 Manager 准入与 PoC 验收的依据（实现代码随 SDK 交付，但设计先行）：

```text
Extension
   ↓
Conformance Suite（黑盒，仅走 §7 协议面）
   ↓
Pass
   ↓
Gateway-compatible（可安装、可注册、可服务流量）
```

**最小 suite（11 个域，全部黑盒执行——Suite 对 Extension 的全部认知仅来自 manifest 与 HTTP 响应）：**

| # | 域 | 验证内容（全部为协议级断言，非业务语义） |
|---|-----|--------------------------------------|
| 1 | manifest | `/manifest` 可解析、schema 合法、apiVersion 受支持、providers[].id 全局唯一、actions 三要素（id/method/schema）完整、security 段无禁止项（hostPath/privileged/docker.sock） |
| 2 | health | `/health` 返回三态之一且含 required 字段；进程杀死后能被判定 unhealthy；重启后恢复且 manifest 一致 |
| 3 | models | `/v1/models` 与 manifest 种子可合并、无裸 `provider::` 前缀泄漏、未知模型请求返回 `TERMINAL` |
| 4 | account lifecycle | begin→pending→(action/authorization)→active 全流程状态机合法；非法迁移（如 pending→active 未经 poll）被拒绝；disable/enable 双向生效；重复 begin 产生新 account_id |
| 5 | quota | `resources[]` 每项 kind 在封闭枚举内、unit 非空、status 合法；未实现配额时返回空数组而非报错 |
| 6 | chat（非流式） | 合法请求返回合法 ChatResult；`account_id` 不存在返回 `AUTH_INVALID`/`TERMINAL`（非 5xx）；凭据失效映射 `AUTH_INVALID` 而非裸 401 |
| 7 | streaming | SSE 帧序列合法（chunk…→done/error 终止帧恰好一个）；客户端断连后上游连接被关闭（Suite 以 mock 上游验证 cancel 传播）；首块超时返回 `TIMEOUT` |
| 8 | errors | 人为注入 11 种上游故障（Suite 内置 fault injector mock 上游），断言 Extension 输出的 kind 映射正确、message 无凭据/token 泄漏（正则扫描） |
| 9 | manual actions | 声明的 action 均可调通且符合 schema；未声明 action 返回 404；`needs_manual_action` 携带的 action_id 必须在 manifest 中存在 |
| 10 | timeout | 每个端点在 deadline 外必须返回或断连，不允许无限挂起（Suite 对全部端点施压超时用例） |
| 11 | cancellation | 流式客户端断开后，Extension 不得继续向 mock 上游发后续请求（取消传播验证） |

**纪律**：① Suite 是 Conformance Protocol 的**唯一**裁决者——"Gateway-compatible"由全绿定义，不做人工例外；② Suite 版本随协议主版本走（apiVersion 1.x ↔ suite 1.x），Manager 准入时校验 Extension 声明的 suite 版本；③ fault injector（mock 上游）是 Suite 的一部分，允许 Extension 测试时注入 `GATEWAY_SUITE_MODE=1` 环境变量把上游指向 mock——生产镜像构建**不得**默认开启（Suite 验证此项）；④ 凭据红线纳入 Suite：任何请求/响应字段扫描到 token/password 形态的明文即失败（域 8）。

---

## 24. 逐 Provider 迁移计划（14 个 provider 条目 → 9 个 Extension 容器）

现状 14 个 registry 条目（buddy×4、trae×2、qoder×2 是同容器多产品），目标 9 个 Extension 容器：

| # | Extension（容器） | 覆盖 provider 条目 | 特殊点 | 迁移难度 | 关键动作 |
|---|------------------|-------------------|--------|---------|---------|
| 1 | `gateway-extension-buddy` | workbuddy, workbuddy-cn, codebuddy, buddy-intl | 共享 `shared/buddy` 协议；4 组 product 配置；签到 gift+付费双资源 | 中 | 一容器四 provider 条目；quota 即 §13.3 前两例；credit_claim 移入 Extension 周期任务 |
| 2 | `gateway-extension-zcode` | zcode | captcha 人工流程；OAuth 会话态；billing+balance 双端点 | **高** | captcha → action 透传（§16）；captcha 会话状态入自有卷；`needs_manual_action` 结构化；**合规设计原样保留** |
| 3 | `gateway-extension-qoder` | qoder, qoder-cn | WASM 专有二进制 | 高 | 见 §24.7，WASM 永不进镜像 |
| 4 | `gateway-extension-trae` | trae, trae-intl | 设备指纹头、checkin(ug) 派生 id | 中 | 两 product 一容器；登录设备态入卷 |
| 5 | `gateway-extension-cline` | cline | quota 语义特殊（`unit:'raw'` 先例） | 低 | 直接落 §13 `kind: custom, unit: raw`——先例转正 |
| 6 | `gateway-extension-lobsterai` | lobsterai | 无 OAuth，余额单资源 | **低** | **PoC 首选**（§26 Phase 3） |
| 7 | `gateway-extension-codearts` | codearts | 华为云 SDK-HMAC-SHA256 请求签名 | 中 | 纯代码签名逻辑随容器走，无宿主依赖 |
| 8 | `gateway-extension-loomy` | loomy | 标准协议 | 低 | 直移 |
| 9 | `gateway-extension-raccoon` | raccoon | 标准协议 | 低 | 直移 |

（buddy 一容器覆盖 4 条目、trae/qoder 各一容器覆盖 2 条目，其余 6 个 provider 各一容器——**容器数 9，provider 条目数 14，条目数与今天完全一致**。）

### 24.4 通用迁移配方（每个 Extension 相同）

1. `Provider` 适配器代码平移进 Extension 仓库，`ProviderCtx.resolveCredential` 替换为 SDK `CredentialStore` 本地解密（C5 消解）。
2. `registerBusinessCodes` 映射移入 Extension 内部 normalizer（C4 消解）。
3. 会话/nonce/captcha 态从 Gateway RAM 移到 Extension 卷（C6 消解）。
4. 需要人工的路径统一输出 `needs_manual_action` + actions（C2/C3 消解）。
5. manifest 填 capabilities/fallbackModels/actions/security；通过 §22.1 Conformance Suite 后发 v1。
6. **存量账号迁移须符合凭据红线（R2）**：迁移窗口内 Core 仅做**内存中转**——从本地 cipher 解密后直接作为 `import` action 的 opaque 请求体转发给对应 Extension，即刻清内存；不落盘、不写 events 明文、不进日志；转发完成后 Core 的 credentials 表仅剩密文且不再有读取方，随 Phase 4 整表废弃（§25.3）。整个迁移过程中凭据明文的可达范围从"Core 进程"收缩为"Core 进程内单次请求生命周期"，最终归零。

### 24.5 迁移顺序与并行

**lobsterai（PoC）→ buddy 族（收益最大：一次覆盖 4）→ cline/loomy/raccoon（低风险铺量）→ trae → codearts → zcode（最复杂）→ qoder（依赖 WASM 方案确认）**。Core 在整个过程中**双轨兼容**：未迁移 Provider 继续走进程内适配器，已迁移的走 Protocol——`ProviderRegistry` 增加第二种注册来源（`registerRemote(manifest, endpoint)`），路由/pool/编排层无感知。这是整个迁移计划的风险核心控制点。

### 24.6 zcode 专项（合规红线）

- captcha 检测（403 header / in-body 3007）逻辑原样保留在 Extension；
- 求解能力**不存在**：只有官方组件渲染（`captcha-widget`）与人工提交（`captcha-submit`）；
- `captcha-client.ts` 的社区移植署名注释随代码迁移保留；
- Core 侧删除的两个特判端点（`POST /api/accounts/:provider/captcha`、`GET /captcha/zcode`）在 Phase 4 迁移完成后由通用反代端点替代，对外 admin URL 变化需在迁移公告中说明。

### 24.7 qoder 专项（WASM 本地化）

延续 v0.1.0 的外部化决策并升级为卷方案：镜像内**永不**含 WASM；运营者把二进制放到宿主目录并以只读 bind 挂进容器（`/opt/wasm`），Extension 启动时加载；缺失 → 所有账号 `needs_manual_action(kind: local_resource)`，进程本身 `healthy`。原 `QODER_WASM_PATH` 环境变量语义由卷挂载点取代（manifest `volumes` 声明）。合规效果与 v0.1.0 相同：公开资产零 WASM。

---

## 25. 数据存储边界（Core SQLite vs Extension）

### 25.1 边界判定原则

**谁产生事实，谁存储事实。** 账号状态、凭据、登录会话、配额原始数据都由 Extension 产生 → 归 Extension；路由、API key、聚合镜像、审计事件由 Core 消费/呈现 → 归 Core。

### 25.2 结论：Extension 不直接读写 Core SQLite

理由：① 跨容器共享 SQLite 文件需要共享卷 + 锁协调，把 Extension 的崩溃面传染给 Core 的数据完整性；② SQLite 的写并发模型不适合多写者；③ 耦合 Core schema 会摧毁 Extension 的独立版本化（schema 一变全体兼容性断裂）；④ 安全上 Extension 拿到 DB 文件=拿到 api_keys 哈希与 settings。**替代通道是协议本身**：Extension 自有存储（SDK 提供 SQLite-in-volume），对外只暴露 §7 端点；Core 镜像靠轮询+事件同步。

### 25.3 Core 表的最终职责（迁移完成后）

| 表 | 处置 |
|----|------|
| providers | 变为 Extension 声明的镜像（来源：register 事件） |
| accounts | 镜像行：**删 credentials 引用语义**，保留状态/开关/元数据；`credentialKey` 列废弃（与 §3.5 Ownership Matrix 一致：Core 侧仅投影） |
| credentials | **废弃**（凭据归 Extension 卷）；迁移期保留至 §26 Phase 4 结束 |
| models | 保留，增加 `source` 列（manifest/extension） |
| quotas | **扩为多资源**（决策点 D3）：`quota_resources(account_id, resource_id, kind, remaining, total, used, unit, reset_at, status, metadata_json, checked_at)`；过渡期先整包 JSON 入 `raw_json` |
| credit_claims | 移交 Extension 侧记录；Core 保留聚合事件 |
| jobs | 大幅缩水：token_refresh/quota_sync/credit_claim 移入 Extension；保留 health_check 与未来 Core 级任务 |
| events / settings / api_keys | 不变 |

### 25.4 决策点（详见 §27）

- **D1 账号所有权**：推荐"Extension 事实源 + Core 镜像"（本文方案，正式化见 §3.5 Ownership Matrix）；备选"Core 继续做账号主表、Extension 无状态"（被否：凭据与登录态无法无状态化，会重新引入 C5，且违反 §10.2 单一事实源纪律）。
- **D2 凭据迁移**：推荐迁移窗口内 Core 纯内存中转到 Extension `import` action，转完即废（§24.4；凭据红线唯一合规路径）；备选 Core 保留凭据库、Extension 每次按需取（被否：凭据过网 + Core 永久持有，边界倒退）。
- **D3 quotas 多资源化时机**：Phase 1 用 JSON 逃生舱，Phase 4 前完成表迁移（带数据回填）。

---

## 26. 实施阶段规划（Phase 0–6）

| 阶段 | 内容 | 交付物 | 验收 |
|------|------|--------|------|
| **Phase 0 — RFC** | 本文评审定稿 | `docs/EXTENSION_ARCHITECTURE_RFC.md` | 决策点 D1–D4 有结论 |
| **Phase 1 — Core 契约固化** | 不引入容器：把 §7/§10/§13/§14 契约落为 Core 内类型 + Provider 接口微调（quota 多资源类型、manual_action 结构、actions 概念在接口层出现）；quotas 走 JSON 逃生舱 | Core 代码 + 测试 | 现有 409 测试全绿，行为零变化 |
| **Phase 2 — Extension Manager** | Manager 容器 + install/update/rollback/health + 与 Core 的注册握手；compose 增 manager 与 ext 网络；**Conformance Suite 骨架（域 1/2/9/10：manifest/health/actions/timeout）随 Manager 落地，作为准入闸门** | Manager v0 + Suite v0 | 对假 Extension（echo server）完成全生命周期；echo 通过 Suite v0 |
| **Phase 3 — 单 Provider PoC** | `gateway-extension-lobsterai` + Core `registerRemote` 双轨注册；zcode 等未迁移者走原路径；**PoC 验收含 Suite 扩展至全 11 域（lobsterai 覆盖 1–8、10、11）** | 可用的双轨 Core + 首个 Extension + Suite v1（全 11 域） | PoC 账号经 Protocol 正常聊天/配额/故障转移；原路径回归全绿；Suite 全绿 |
| **Phase 4 — 全量迁移** | 按 §24.5 顺序迁移其余 Provider；zcode captcha/qoder WASM 专项；quotas 表多资源迁移；Core 删除 providers/ 内置适配器与 C1–C6 | 9 个官方 Extension 容器 | `src/providers/` 消失；全部测试改为 conformance + Core 单测 |
| **Phase 5 — SDK** | 从 PoC/迁移中沉淀 `@multi-provider-ai/gateway-extension-sdk` + 模板仓库 + **Conformance Suite 正式化发布**（套件独立版本化，第三方自测共用） | SDK v1 + Suite v1.0 | 新 Extension 从模板到发布 ≤ 半天（含 Suite 全绿） |
| **Phase 6 — 第三方生态** | extensions.json 目录、安装信任流程 UI、第三方文档与合规指引（CAPTCHA 红线等） | 官网/文档页 | 第三方 Extension 端到端安装成功 |

每阶段的回归底线：对外 API 语义零变化；生产 homeserver 升级停机窗口 = 拉镜像重启（数据卷兼容）。

---

## 27. 开放问题与决策清单

| # | 问题 | 选项 | 推荐 | 理由 / 代价 |
|---|------|------|------|------------|
| D1 | 账号事实源归属 | A. Extension 事实源 + Core 镜像；B. Core 主表 + Extension 无状态 | **A** | 凭据/登录态天然在 Extension 侧；B 会使凭据重新过网、C5 复活。代价：Core 镜像同步复杂度（轮询兜底可控） |
| D2 | 既有凭据迁移路径 | A. 迁移窗口内 Core 纯内存中转到 Extension `import` action，转完即废（§24.4）；B. Core 长期保留凭据代管 | **A** | A 是唯一符合凭据红线（§10.3）的路径：明文可达范围从 Core 进程收缩为单次请求生命周期、最终归零；代价：Phase 4 一次性人工操作（9 个账号级别，可控）。B 让 Core 永久持有明文解密能力，边界倒退，否决 |
| D3 | quotas 多资源化时机 | A. Phase 1 JSON 逃生舱 + Phase 4 建表；B. Phase 1 即建表 | **A** | 先保行为零变化；代价：中间态两套读法（封装在 store 层） |
| D4 | buddy 族一容器四条目 vs 四容器 | A. 一容器（product 配置区分）；B. 四个独立 Extension | **A** | 共享协议一份维护、一次构建；代价：任一产品发版带动全部（可接受，同代码） |
| D5 | Manager 是否同时管理 Core 自身 | A. Manager 管 Core（Compose 由 Manager 拉起）；B. Core 由 compose 直管、Manager 只管 Extension | **B** | 职责单一、避免自举死锁（Manager 更新不应影响被管理对象自身）；代价：Core 升级走传统 pull+restart |
| D6 | zcode admin URL 变化 | A. Core 做旧路径兼容重定向；B. 直接换新 URL | **A（一个版本期）** | 降低既有自动化脚本破坏；代价：Core 保留一条与 provider 无关的通用反代别名 |
| D7 | 出站网络 v1 是否强制 allowlist | A. 声明+审计（§12.2 已明确非强制）；B. egress proxy / network policy 强制 | **A** | v1 控制复杂度；声明面已可审计且 UI 必须明示"未强制"。B 进 v2（§22 候选清单已占位），届时 `permissions.network` 从审计升级为强制 |
| D8 | Conformance Suite 准入强度 | A. Manager 安装时强制跑 Suite（安装耗时↑）；B. 安装时只跑域 1–2，全量 Suite 留给 CI 与发布方 | **B** | 安装体验优先；发布方（官方 CI）全量跑 Suite 并在 Release 标注结果；第三方 Extension 安装时 UI 提示"未经 Gateway 官方 Suite 验证" |

---

## 附录 A：耦合点 → 方案映射速查

| 耦合点 | 位置 | 消解机制 |
|--------|------|---------|
| C1 register.ts 编译期 import + captcha 类型泄漏 | `src/providers/register.ts` | Phase 4 删除文件；`registerRemote` 替代；captcha 归 zcode Extension |
| C2 http/app.ts captcha 特判端点 | `src/http/app.ts` | §16 通用 action 反代；Core 零 provider 知识 |
| C3 ServiceContext.captcha | `src/service/context.ts` | ctx 去掉该字段；交互态归 Extension |
| C4 全局业务码表 | `src/core/errors/normalizer.ts` | 映射移入 Extension；Core 只消费 11 kind |
| C5 进程内明文凭据闭包 | `src/http/index.ts`、`src/service/context.ts` | 凭据归 Extension 卷（D2）；ProviderCtx 语义由 SDK CredentialStore 承接 |
| C6 进程 RAM 会话态 | 各适配器 | Extension 卷持久化（重启不丢登录会话，优于现状） |

## 附录 B：与现状接口的字段对照

| 现状 | Protocol v1 |
|------|-------------|
| `Provider.capabilities` | manifest `providers[].capabilities`（同字段集） |
| `LoginBeginResult` | `POST /v1/accounts` 响应（同字段） |
| `UpstreamError.kind ×11` | 协议错误 `error.kind`（同枚举） |
| `AccountStatus ×9` | 协议账号状态（同枚举；`cooldown` Core 专属） |
| `QuotaSnapshot{known,remaining,total,resetAt,rawJson}` | `resources[]` 多资源（§13，`known:false` → 空数组） |
| `ClaimOutcome` | `POST /v1/accounts/:id/claim` 响应 |
| `ModelEntry` | manifest 种子 + `GET /v1/models`（`id` 去前缀） |
| `ChatRequest/ChatChunk/ChatResult` | §11 载荷（`provider::` 前缀由 Core 剥离） |
