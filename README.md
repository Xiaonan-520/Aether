# Multi-Provider AI Gateway

自托管、多 Provider、OpenAI-compatible 的 AI 账号网关。对外暴露单一 `http://<server>:8080/v1` 端点，内部统一处理多 Provider、多账号池、token 续期、quota 感知路由、failover 与调度任务。

```
clients (RikkaHub / OpenCode / 任意 OpenAI client)
  ↓  Authorization: Bearer <GATEWAY_API_KEY>
OpenAI-compatible API (/v1)
  ↓
Gateway Core
  ├── Model Registry / Router（provider::model 显式路由 + 优先级回退）
  ├── Account Pool（状态机：active/cooldown/rate_limited/quota_exhausted/needs_manual_action…）
  ├── Provider Registry / Adapters（provider 隔离，Core 无 provider-specific if/else）
  ├── Token / Credential Manager（AES-256-GCM at-rest）
  ├── Failover（401→refresh 一次重试；429→写限流窗口换号；quota 耗尽→停号；captcha→needs_manual_action）
  ├── SQLite persistence（WAL，双后端：SQLite / MemoryStore）
  └── Scheduler（token_refresh / quota_sync / credit_claim / health_check）
```

## 当前状态：14 个 Provider 已接入，Docker/GHCR 已部署并运行

Gateway Core：
- HTTP + OpenAI-compatible API（`/v1/models`、`/v1/chat/completions`，含 SSE 流式）✅
- Account Pool 状态机 + failover ✅
- SQLite + MemoryStore 双后端 ✅
- Scheduler（token_refresh / quota_sync / credit_claim / health_check）✅
- 错误归一化 ✅
- Dockerfile / docker-compose（GHCR 拉取部署）✅
- GitHub Actions → GHCR 镜像流水线（`.github/workflows/docker.yml`）✅
- 测试：**353 passed / 29 files**；typecheck 与 build 均通过 ✅

Provider Adapter（14 个，全部注册到 `/api/providers`）：

```
workbuddy        workbuddy-cn     codebuddy      buddy-intl
zcode            lobsterai        cline          trae
trae-intl        codearts         loomy          qoder
qoder-cn         raccoon
```

- 共用 family adapter：`shared/buddy/`（4 产品）、`trae/`（2）、`qoder/`（2）；
  其余各自独立协议实现。Core 中无 provider-specific 分支。
- 已完成**真实账号**端到端验证：`workbuddy`、`workbuddy-cn`、`codebuddy`、`buddy-intl`。
- 登录链路已修复但需人工浏览器授权才能完成：`qoder`、`qoder-cn`、`lobsterai`、
  `trae`、`trae-intl`、`codearts`。
- 外部阻塞 / 需人工：`cline`（外部注册页问题）、`raccoon`（需微信扫码）、
  `loomy`（需手机号 SMS 登录）。
- 详细状态、已知问题与交接说明见 **`HANDOFF.md`**。

## 快速开始

```bash
cp .env.example .env          # 填入 GATEWAY_API_KEY / GATEWAY_SECRET / GATEWAY_ADMIN_TOKEN
npm install                   # 本机需 Node >= 18（better-sqlite3 为 optional；缺失时自动用内存存储）
npm run build && npm start    # 或 npm run dev
curl http://127.0.0.1:8080/healthz
```

### Docker（GHCR 镜像部署）

镜像由 GitHub Actions 构建并推送到 GHCR（push 到 `main` 后自动触发）：

```
ghcr.io/xiaonan-520/multi-provider-ai-gateway:latest
ghcr.io/xiaonan-520/multi-provider-ai-gateway:sha-<commit>
```

部署只需拉取镜像，不在服务器上构建：

```bash
cp .env.example .env          # compose 会读取同目录 .env
docker compose pull
docker compose up -d
docker compose logs -f
```

若 GHCR 包为私有，拉取前需登录（PAT 只需 `read:packages`）：

```bash
echo "<PAT>" | docker login ghcr.io -u <github-user> --password-stdin
```

生产部署建议把 `GATEWAY_IMAGE_TAG` 固定为某个 `sha-<commit>` 标签，回滚即改回上一个标签并 `docker compose up -d`。

数据（SQLite + 加密凭据）持久化在 named volume `gateway-data`（容器内 `/data`）。
升级不会丢数据（schema_version 顺序迁移）。**该 volume 与 `.env` 不在 GitHub 上**，
重装前请自行备份（详见 `HANDOFF.md` §6）。

## API

### OpenAI-compatible（Bearer GATEWAY_API_KEY）

```
GET  /v1/models                # 模型目录（含 available 标注，不含任何凭据信息）
POST /v1/chat/completions      # stream=true 时返回 SSE（data: {...} … data: [DONE]）
```

### 管理（Bearer GATEWAY_ADMIN_TOKEN）

```
GET    /api/providers
GET    /api/accounts?provider=
POST   /api/accounts                    # { provider, displayName?, credential?, providerMetadata? }
PATCH  /api/accounts/:id
DELETE /api/accounts/:id
POST   /api/accounts/:provider/login             # { displayName?, phone? } 启动登录
GET    /api/accounts/:provider/login/:loginId     # 轮询登录状态
POST   /api/accounts/:provider/login/:loginId/credential  # { credential: {...} } 提交 code/refresh_token/AK-SK 完成交换
POST   /api/accounts/:id/import-credential        # { credential, expiresAt? } 上传「已就绪」凭据
POST   /api/accounts/:provider/captcha            # 仅 zcode：人工提交验证码 token
GET    /api/jobs?type=
GET    /api/events?limit=
```

### 健康检查（无鉴权）

```
GET /healthz
```

## 配置（环境变量）

| 变量 | 说明 |
|---|---|
| `DATA_DIR` | SQLite/数据目录（Docker 中为 `/data`） |
| `GATEWAY_API_KEY` | 客户端访问 `/v1` 的 Bearer key |
| `GATEWAY_SECRET` | 派生 AES-256-GCM 密钥加密凭据；**创建账号后不可更改** |
| `GATEWAY_ADMIN_TOKEN` | 管理 API `/api/*` 的独立 token |
| `TZ` | 调度器每日签到的时区 |
| `LOG_LEVEL` | debug / info / warn / error |
| `HTTP_HOST` / `HTTP_PORT` | 监听地址（默认 0.0.0.0:8080） |

## 开发

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest（353 个测试 / 29 个文件）
npm run build       # tsc → dist/，随后 scripts/copy-assets.mjs 复制 Qoder WASM
npm run migrate     # 手动执行 SQLite 迁移（启动时也会自动迁移）
npm run dev         # tsx watch
```

## 安全与合规边界

- 所有 provider 凭据 AES-256-GCM 加密落库；凭据绝不进入 API 响应、日志或 `/v1/models`。
- **不实现、不复制、不扩展任何验证码（CAPTCHA）绕过机制。** 上游要求 captcha 时，账号标记为 `needs_manual_action` 并返回结构化错误（`manual_action_required`），由管理员人工处理。
- Credit claim 只使用平台正常提供的合法接口；当日已领取不重复调用。

## 文档

- **`HANDOFF.md`（项目根目录）** — 交接文档：架构、14 个 Provider、部署、已知问题、
  真实账号验证状态、Arch 重装后如何恢复。**新 Agent / 新会话请先读它。**
- `docs/AUDIT_REPORT.md` — 原 deepseek-harness-codearts 源码审计
- `docs/DESIGN_PHASE2.md` — 早期设计（数据模型 / schema / 调度 / 路由）

## License

MIT
