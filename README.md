# Aether

[English](README.en.md) | 中文

> 项目正式名称 **Aether**（曾用名 Multi-Provider AI Gateway）。仓库与镜像的迁移说明见
> [docs/RENAME-AETHER.md](docs/RENAME-AETHER.md)。

自托管的多 Provider AI 网关。对外暴露一个 OpenAI 兼容的 `/v1` 端点，对内管理一池 Provider 账号：路由、token 自动刷新、额度感知、故障切换、后台维护任务。凭据静态加密存储，永远不会出现在 API 响应或日志里。

这个项目最初解决的问题很实际：手里有一批各家 AI 产品的账号（WorkBuddy、CodeBuddy、ZCode、Qoder……），每家的接口协议、登录方式、额度规则都不一样，客户端工具却只认 OpenAI 格式。与其在每个工具里各配一遍，不如做一个网关把它们统一收口。

```text
客户端（任意 OpenAI 兼容工具）
  │  Authorization: Bearer <GATEWAY_API_KEY>
  ▼
OpenAI 兼容 API   /v1/chat/completions · /v1/models（支持 SSE 流式）
  ▼
模型路由          provider::model 显式路由 + 优先级回退
  ▼
Provider 适配     内置适配器或独立 Extension 容器
  ▼
账号池            状态机 + 故障切换 + 冷却/限流窗口
  ▼
上游 Provider API
```

配套能力：调度器按账号跑 `token_refresh` / `quota_sync` / `credit_claim` / `health_check` 后台任务；SQLite 持久化（WAL、顺序迁移，原生驱动不可用时回退内存存储）；管理 API（`/api/*`）负责账号、登录、密钥和运维；Web Console 提供账号/额度/密钥/扩展的可视化管理。

## 当前实现状态

以下功能均已实现并被测试覆盖（644 个测试通过）：

- OpenAI 兼容 API —— `/v1/chat/completions`（流式 SSE 与非流式）、`/v1/models`
- 多账号池与状态机（`active` / `cooldown` / `rate_limited` / `quota_exhausted` / `needs_manual_action` 等）
- 账号间自动故障切换：鉴权错误先原位刷新 token 重试一次；限流/额度耗尽/传输错误换账号；终态错误快速失败
- 各 Provider 的 OAuth 与 token 刷新流程；轮换后的 refresh token 优先落盘
- 凭据静态加密（AES-256-GCM，密钥由 `GATEWAY_SECRET` 派生）
- 额度同步与每日积分签到（Provider 支持的前提下）；**声明式 Quota 契约**——Extension 在 manifest 里声明自己上报哪些额度资源及字段语义，Core 统一校验并投影到 Console，缺失数据保持缺失、不伪造 0
- 网关 API Key（只存哈希、前缀索引查找）
- Web Console：总览、按 Provider 的模型/额度/签到记录、密钥管理、扩展管理
- Extension 架构：Provider 可以从 Core 剥离为独立容器，经 Extension Manager 安装/升级/回滚，见下文

## Provider 支持情况

Provider 分两类：**内置适配器**（编译进 Core）和 **Extension**（独立容器，经 Extension Protocol v1 接入）。架构演进的方向是逐步把内置适配器迁移为 Extension——目前 WorkBuddy 两个版本已经完成迁移，其余几个还在内置侧。下表"登录"指运维者手动完成一次的交互流程，之后网关接管维护。

| Provider | 形态 | 登录方式 | 状态 |
| --- | --- | --- | --- |
| workbuddy / workbuddycn | Extension（独立容器） | 浏览器授权 | 真实账号 E2E 验证，生产运行中 |
| codebuddy | 内置 | 浏览器授权 | 真实账号 E2E 验证 |
| buddy-intl | 内置 | 浏览器授权 | 真实账号 E2E 验证 |
| zcode | 内置 | OAuth（CLI 流程） | 真实账号 E2E 验证；人工 CAPTCHA 交接，见下文 |
| qoder / qoder-cn | 内置 | device code | 登录/模型/额度可用；聊天依赖客户端 WASM，见下文 |
| lobsterai / cline / trae / trae-intl / codearts / loomy / raccoon | Extension（`src/extensions/`） | 各异（WorkOS 设备码、短信、微信扫码、PKCE+DPoP 等） | 已迁移为 Extension 容器，各有 E2E 测试 |

状态按账号标注在 `/v1/models`（`available` 字段）和管理 API 里。表格反映的是当前开发状态，不是兼容性承诺——没有用真实账号长期跑过的 Provider 不会标"已验证"。

### ZCode 的 CAPTCHA 策略

ZCode 上游偶尔要求阿里云验证码。网关的做法是：检测到挑战后，在 `GET /captcha/zcode` 提供官方验证码组件给人工完成，人工提交的 token 走管理 API 回传。**没有自动打码、没有绕过、没有浏览器指纹伪造**——这是刻意的设计取舍。拿不到新的有效 token 时，账号会被挂到 `needs_manual_action`，账号池自动跳过它。

### Qoder 加密推理

Qoder 的聊天端点要求请求体由官方客户端的 WASM 模块生成。这个二进制是专有文件，**本仓库不分发**。如果你合法持有它，放到 `src/providers/qoder/` 旁边（或设置 `QODER_WASM_PATH`），适配器会在运行时加载；没有它，登录、模型列表、额度照常工作，聊天请求会收到明确的错误。项目不提供任何提取或重分发指引。

## 快速开始

```bash
git clone https://github.com/Xiaonan-520/Aether.git
cd Aether
cp .env.example .env          # 填三个密钥，见下文配置
docker compose up -d
curl http://127.0.0.1:8080/healthz
```

不用 Docker 也行：

```bash
cp .env.example .env
npm install
npm run build && npm start    # 开发模式：npm run dev
```

然后通过管理 API 注册账号（所有管理端点都要求 `Authorization: Bearer <GATEWAY_ADMIN_TOKEN>`）：

```bash
# 发起某 Provider 的登录流程
curl -X POST -H "Authorization: Bearer $ADMIN" \
     -H "Content-Type: application/json" \
     -d '{"displayName": "main"}' \
     http://127.0.0.1:8080/api/accounts/workbuddy/login
# 轮询返回的 loginId 直到成功，然后聊天：
curl -X POST -H "Authorization: Bearer $KEY" \
     -H "Content-Type: application/json" \
     -d '{"model": "workbuddy::glm-5.3", "messages": [{"role": "user", "content": "hi"}]}' \
     http://127.0.0.1:8080/v1/chat/completions
```

模型可以用 `model`（路由按优先级/可用性自动挑）或显式的 `provider::model` 形式指定。

## 配置

全部通过环境变量（compose 读 `.env`）：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `GATEWAY_API_KEY` | 是 | 客户端访问 `/v1/*` 的 Bearer key |
| `GATEWAY_SECRET` | 是 | 派生 AES-256-GCM 密钥用于加密存储的凭据。**建号之后不要改**，否则已存 token 无法解密 |
| `GATEWAY_ADMIN_TOKEN` | 是 | 管理 API `/api/*` 的 Bearer token，与网关 key 分离 |
| `DATA_DIR` | 否 | SQLite + 密钥的数据目录（默认 `./data`，Docker 内 `/data`） |
| `TZ` | 否 | 每日签到调度的时区（默认 `Asia/Shanghai`） |
| `LOG_LEVEL` | 否 | `debug` / `info` / `warn` / `error`（默认 `info`） |
| `HTTP_HOST` / `HTTP_PORT` | 否 | 监听地址（默认 `0.0.0.0:8080`） |
| `QODER_WASM_PATH` | 否 | 自备的 `qoder-auth-wasm.wasm` 绝对路径 |

## API

### OpenAI 兼容 — `Authorization: Bearer <GATEWAY_API_KEY>`

```text
GET  /v1/models               模型目录，带可用性标注
POST /v1/chat/completions     聊天；stream=true 时返回 SSE（data: {...} … data: [DONE]）
```

### 管理 — `Authorization: Bearer <GATEWAY_ADMIN_TOKEN>`

```text
GET    /api/providers                              已注册的 Provider
GET    /api/accounts?provider=                     账号及状态
POST   /api/accounts                               创建（导入凭据）
PATCH  /api/accounts/:id                           改状态/显示名/元数据
DELETE /api/accounts/:id
POST   /api/accounts/:provider/login               发起交互式登录
GET    /api/accounts/:provider/login/:loginId      轮询登录状态
POST   /api/accounts/:provider/login/:loginId/credential   完成验证码/token 交换
POST   /api/accounts/:id/import-credential         导入现成凭据
POST   /api/accounts/:provider/captcha             仅 zcode：提交人工完成的 CAPTCHA token
GET    /api/jobs?type=                             后台任务历史
GET    /api/events?limit=                          审计事件
POST   /api/keys                                   签发网关 API key
GET    /api/keys
DELETE /api/keys/:id
```

```text
GET /captcha/zcode     zcode CAPTCHA 人工交接页（浏览器打开；admin token 只提交给本网关）
GET /healthz           存活探针，无需鉴权
```

管理 API 虽然是公开接口的一部分，但它是给运维者用的——**不要暴露给不可信网络**。

## 架构

```text
src/
├─ http/            Hono app：/v1、/api、/healthz；SSE 管道
├─ protocol/openai/ 请求解析、响应序列化、SSE 帧
├─ protocol/extension/  Extension Protocol v1：manifest、账号/额度契约、远程 Provider
├─ service/         聊天编排（故障切换）、模型、登录、admin、API key、Console 聚合
├─ core/
│  ├─ router/       模型 → Provider 路由（显式 + 回退）
│  ├─ pool/         账号状态机 + 选择 + 失败上报
│  ├─ registry/     Provider 适配器接口 + 注册表
│  ├─ worker/       任务调度（token_refresh / quota_sync / credit_claim / health_check）
│  └─ errors/       上游错误类型；Provider 无关的故障切换语义
├─ providers/       内置适配器（每 Provider 一个目录）+ 共享协议辅助模块
├─ extensions/      已容器化的 Provider Extension（每扩展一个 Dockerfile）
└─ store/           StoreGateway 接口；SQLite（WAL + 迁移）与内存后端
```

设计上有几条刻意的边界：

- **Core 不认识任何具体 Provider。** 适配器把上游协议翻译成规范的聊天接口，把上游失败映射到共享错误类型（`AUTH_INVALID`、`RATE_LIMIT`、`QUOTA_EXHAUSTED`、`NEEDS_CAPTCHA`……）；故障切换决策完全在账号池/聊天服务里。
- **Extension 是账号与凭据的权威。** 凭据明文只存在 Extension 自己的加密卷里，协议层不存在携带 token 的账号创建接口——Core 只拿到非敏感的结果标记。
- **额度数据走声明式契约。** Extension 在 manifest 里声明资源语义，Core 逐快照校验一致性；不对齐的地方如实标记，不猜测、不补零。
- 迁移的设计与红线详见 [Extension 架构 RFC](docs/EXTENSION_ARCHITECTURE_RFC.md)。

## 扩展（Extension）

Provider Extension 是独立容器，实现 Extension Protocol v1（HTTP + JSON + SSE），通过 Extension Manager 安装、升级、回滚——Core 不用重新构建。仓库内 `extensions/` 与 `src/extensions/` 下是官方扩展，`docker-compose.extensions.yml` / `docker-compose.phase3.yml` 是对应的部署编排。

写一个新扩展的最小集合：`manifest.ts`（Provider 声明 + 额度声明）、Provider 实现（login / refresh / models / chat / stream / quota）、`Dockerfile`。协议细节见 RFC 与 `src/protocol/extension/`。

## 开发

```bash
npm install
npm test            # vitest，644 个测试
npm run typecheck   # tsc --noEmit
npm run build       # tsc + 资源复制到 dist/
npm run dev         # tsx watch 模式
npm run migrate     # 手动执行 SQLite 迁移
```

Console 是独立的 Vite 应用（`console/`），`npm run build` 产出静态文件。

### 开发模式：Vibe Coding / AI 辅助开发

这个项目是 AI 辅助开发的产物：绝大部分代码、测试和文档由 AI 编码代理在人的持续指导下完成。具体分工是——人定义需求、架构方向、Provider 路线图，review 变更，跑验证，运维生产部署，做每个发布决定；AI 产出实现、重构、测试和大部分调试。

AI 生成的代码不默认正确：这里的所有东西都过了测试套件和类型检查，关键路径都用真实 Provider 账号验证过。生产行为以实际测试和部署过的为准，不以 AI 产出了什么为准。

AI 工具不是本项目的作者或版权持有人；版权与许可由人类维护者持有，见 `LICENSE`。

### 参与贡献

Issue 和 PR 都欢迎。写 Provider 适配器请保持 Core 的 Provider 无关性（新 Provider 在 `src/providers/register.ts` 注册），并带上测试。不接受 CAPTCHA 打码、绕过或客户端指纹伪造相关的代码。

## Docker

镜像由 GitHub Actions 构建，推送到 GHCR（`main` 分支每次 push 及所有 `v*` tag）：

```bash
# 规范地址（仓库改名为 Aether 后的 CI 发布目标）
docker pull ghcr.io/xiaonan-520/aether:latest

# 改名前的镜像仍保留在 GHCR，已有 tag 不受影响
docker pull ghcr.io/xiaonan-520/multi-provider-ai-gateway:latest
```

`docker-compose.yml` 把 `gateway-data` 卷挂到 `/data`，容器内健康检查打 `/healthz`，`restart: unless-stopped`。密钥来自 compose 文件旁边的 `.env`——永远不要烤进镜像。要可复现部署就把 `GATEWAY_IMAGE_TAG` 钉到 `sha-<commit>` tag。

## 许可证

[MIT](LICENSE)——第三方引用与署名见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

## 引用与第三方许可

本项目参考、改编或对接了以下开源项目。它们的名称、商标、代码与许可归各自作者所有。

| 项目 | 仓库 | 许可证 | 用途 |
| --- | --- | --- | --- |
| deepseek-harness-codearts ("jet-hub") | [gitee.com/iJetLi/deepseek-harness-codearts](https://gitee.com/iJetLi/deepseek-harness-codearts) | MIT | 改编代码（Provider 协议/签名材料、Qoder WASM 对接）+ 架构参考 |
| deepseek-harness | [github.com/deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | MIT | 架构参考；未包含其源码 |
| zcode-api | [github.com/TriDefender/zcode-api](https://github.com/TriDefender/zcode-api) | 无（仅参考） | 上游 CAPTCHA 挑战行为的研究参考；未包含源码，无授权暗示 |
| Qoder 客户端 `qoder-auth-wasm.wasm` | — | 专有 | 不分发。仅当运维者自备副本时在运行时加载 |

完整署名（含 jet-hub 的 MIT 声明文本）见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
