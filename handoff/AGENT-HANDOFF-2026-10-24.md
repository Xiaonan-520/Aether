# Agent 交接文档（2026-10-24）

> 本文件是给下一个 Agent 的唯一入口。**先读完本文再动手**。
> 上一轮交接见 `handoff/zcode-11128-fix-applied.md` 与 `handoff/minimax-extension-report.md`。

---

## 0. 一分钟速览

- 项目：**Aether**（曾用名 `multi-provider-ai-gateway`，OpenAI 兼容多上游网关）。
  改名的范围与兼容性处理见 `docs/RENAME-AETHER.md`；镜像/容器尚未迁移。
- HEAD：`2c0c0bf`，`main` 与 origin 同步，工作区干净（23 个历史未跟踪文件，勿动）
- Phase 3 测试环境：`192.168.10.53:18080`，Core **1.2.10**，6 个扩展全 healthy/registered
- **生产 `ai-gateway:8080` 全程禁止触碰**（旧镜像 2026-10-02，与本轮所有修复无关）
- 立即可用：`workbuddycn` / `workbuddy` / `codebuddy` / `buddy-intl` / `minimax`（真实账号）
- 部署完成待凭据：`accio`
- 未实现：`officeace` / `opencode`（上游阻断）/ `gemini` / `minimaxintl`

---

## 1. 环境实况（2026-10-24 核实）

### Phase 3 容器

| 容器 | 镜像 | 状态 |
|---|---|---|
| phase3-gateway | `local/mpag-phase3:1.2.10` | healthy |
| phase3-extension-manager | `local/mpag-phase3:1.2.8` | healthy（**未升级**，仍 1.2.8） |
| gw-ext-workbuddycn | `...-workbuddycn:1.0.9` | healthy |
| gw-ext-workbuddy | `...-workbuddy:1.0.6` | healthy |
| gw-ext-codebuddy | `...-codebuddy:1.0.8` | healthy |
| gw-ext-buddy-intl | `...-buddy-intl:1.0.8` | healthy |
| gw-ext-minimax | `...-minimax:1.0.14` | running（无 healthcheck 定义，非异常） |
| gw-ext-accio | `...-accio:1.0.1` | running（同上） |

### 账号（全部 active，各 1 个）

`workbuddycn …4776` / `workbuddy …b611` / `codebuddy …4c93` / `buddy-intl …0a0a` / `zcode …568d` / `minimax …c907`

MiniMax 余额：约 394 credits（每日签到 400，有效期至 2026-11-15）。

---

## 2. 本轮完成的工作（按主题）

### 2.1 ZCode 11128 修复 ✅

- **根因**：ZCode CLI 在 git 仓库内注入的 git 上下文标签串指纹。**system 消息和 assistant 正文都触发**；user/tool 结果/tool_call 参数/reasoning 不触发。
- **关键教训**：assistant 正文里的触发串会随历史每轮重放 → 会话永久中毒、越重试越坏。
- **修复**：`normalizeChannelText()` 只改这一句，四个 buddy 族表面各接一处。
- **严禁**：在 assistant 正文/文档/对话里原样复述该串；一律称「git 上下文标签串」。
- 详见 `handoff/zcode-11128-fix-applied.md`。

### 2.2 Extension Token 自动恢复机制 ✅（重要架构变更）

- **根因（两条）**：
  1. Manager 每次 install/upgrade 都 mint 新 token 注入新容器，但**从不通知 Core**；Core 只在启动和显式 reload 时取 token → 升级后永久 401 直到人工 reload。
  2. hop 认证失败与账号凭据失效**共用 `AUTH_INVALID`** → Core 把账号误标 `token_expired`。
- **修复**：新增 `EXTENSION_AUTH` 协议错误码（映射 TRANSPORT + `detail:'extension_auth'`，不进 `isAuthProblem`）+ `src/protocol/extension/auth-recovery.ts` 自动重拉注册包并重试一次（5s 冷却 + in-flight 去重）。
- **踩过的坑**：ChatService 在循环外缓存 `adapter`，`registry.replace()` 后重试仍用旧 client → 必须重新 `registry.get()`（commit `4d36a34`）。
- 详见 `handoff/zcode-11128-history-contamination.md` 附近文档。

### 2.3 iJetHub 调查与 MiniMax 接入 ✅

- **iJetHub = `iJetLi/dsh-providers-hub`**（GitHub/MIT），Gitee 侧 `deepseek-harness-codearts`。dsh 插件，17 个 provider。
- Gateway 原本已有 11 个。本轮新增 **MiniMax**（中国 + 国际双站点，一镜像）。
- MiniMax 走 **Anthropic Messages 协议**，需双向转换；登录是 OAuth 设备码 + PKCE。
- **真实验证通过**：登录 → 签到领 400 → 推理 → 流式 → 多轮 → developer role → 工具调用+回传 → 额度查询（Console 可见）。
- 关键陷阱（已锁测试）：`system` 提升为顶层字段、`signature_delta` 必须丢弃、**默认不发 `thinking`**（M3.1 上 `disabled` 是硬 400）、`credit/details` 的 `remaining_amount` 是**字符串**且桶键是 `credit_type`（不是参考实现的 `type`）、check-in 端点**必须带 `timezone_id`**（容器内 Intl 解析为 UTC 会被拒）。
- 详见 `handoff/minimax-extension-report.md`。

### 2.4 Accio 接入（已实现，登录被上游阻断）⚠️

- 协议：Gemini 风格 snake_case，**token 在 body**，`system_instruction` 是**字符串**，工具 schema 必须**字符串化**（`parameters_json`），`properties` 子树不参与 snake 转换。
- 已实现 + 21 协议测试 + 11 E2E，**全部离线验证通过**；已部署 `1.0.1` 并注册。
- **阻塞**：网页登录成功后跳官方工作台 `/work`，**不回发 code 到 `return_url`**。参考实现依赖桌面客户端 localhost 回跳。已试 easytier overlay 地址、同浏览器已登录重走授权，均失败，URL 无 code。
- **最小解锁路径**：给扩展加「凭据导入」action（RFC §16.4 允许），用户用 Accio 桌面客户端登录后导入凭据。
- 详见 `handoff/accio-extension-report.md`。

### 2.5 OpenCode（调查后放弃）❌

- 参考实现 2026-10-15 记录匿名通道可用（7 个免费模型，`Bearer public` + 指纹头 + `read` 门禁工具）。
- 本轮按其规格逐字段复现（project id SHA1 派生、`ses_` session 算法、UA、affinity 头、门禁工具 schema）+ 变体矩阵实测 → **全部 403 FreeTierError**。
- 结论：上游两天内加了环境/出口校验，服务器环境不可用。需住宅出口或付费 key。

### 2.6 多账号能力审计（只读，未修）📋

- Core 多账号能力**通用且完备**：priority + LRU 选择、最多 3 次 failover、冷却/限流/额度状态机、惰性恢复、内联单飞刷新、无会话粘性。
- 全部 6 个 provider 代码都支持多账号，但**当前全是单账号**；多账号调度**只在单测验证过，无真实多账号流量**。
- **发现的问题（未修）**：
  - **P1**：6 个扩展都**没有账号删除路由**，Core 的 `DELETE /api/accounts/:id` 不清扩展卷内凭据 → 多账号会产生孤立凭据。
  - **P1**：accio 的 `pending` 登录会话是**模块级单例**（`src/extensions/accio/main.ts:230`），两个账号同时授权会 409 或串号，应改 `Map<accountId, PendingLogin>`。
  - **P1**：多账号 E2E 完全缺失（无「登录两个 stub 账号 → 断言轮换」用例）。
  - **P2**：无并发压测；无会话粘性（对有账号级上下文的 provider 需评估）。

---

## 3. 关键约束（务必遵守）

1. **生产 `ai-gateway:8080` 绝对禁止触碰**。它是 2026-10-02 旧镜像，与本轮修复无关，升级是独立决策。
2. **不得原样复述 git 上下文标签串**（会毒化当前会话）。
3. **不重启 phase3-extension-manager**（它跑 1.2.8，重启会丢它内存里的安装状态协调；只重启 gateway 是安全的）。
4. 走代理推 GitHub：`HTTPS_PROXY=http://192.168.10.210:7890 HTTP_PROXY=...`（该代理**经常不可达**，失败就等几分钟重试，不要改 git config）。
5. 部署扩展必须走 Manager API（`/api/extensions/{install,upgrade,remove}`），**manifest 必须与容器实际服务的 `/manifest` 逐字节一致**，否则 `manifest mismatch`。
6. 升级后 token 会轮换：新 Core（1.2.10+）会自动恢复；若遇到 `bad extension token` 且自动恢复未生效，用 `POST /api/console/extensions/{id}/reload`（**不要重启 gateway**）。
7. 扩展 conformance 门**要求 manifest 至少声明 1 个 action**，否则 install 被拒（`manual-actions: actions.declared-in-manifest`）。

---

## 4. 常用操作速查

```bash
# 环境状态
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}' | grep -E "phase3|gw-ext"

# 账号状态（ADMIN 从 phase3-gateway 容器 env 取 GATEWAY_ADMIN_TOKEN）
curl -sS http://192.168.10.53:18080/api/accounts -H "Authorization: Bearer $ADMIN"

# 扩展注册状态
curl -sS http://192.168.10.53:18080/api/console/extensions -H "Authorization: Bearer $ADMIN"

# 额度
curl -sS http://192.168.10.53:18080/api/console/providers/{provider}/quotas -H "Authorization: Bearer $ADMIN"

# 真实请求冒烟（不耗大额度）
curl -sS http://192.168.10.53:18080/v1/chat/completions \
  -H "Authorization: Bearer $GW_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"minimax::MiniMax-M3.1-Flash-Preview","messages":[{"role":"user","content":"hi"}],"max_completion_tokens":5}'

# 重建扩展镜像 + 升级（示例：minimax）
docker build -f src/extensions/minimax/Dockerfile -t local/gateway-extension-minimax:1.0.X .
# 然后：POST /api/extensions/minimax/upgrade （body: {manifest, image:{repo,tag}}）
# manifest 必须用当前代码生成的：node --import tsx -e "import {minimaxManifestFor} from './src/extensions/minimax/main.ts'; ..."

# 测试
npm run typecheck && npm test        # Core: 798 passed | 2 skipped
cd extensions/workbuddycn && npm test # 99
cd extensions/workbuddy   && npm test # 99
```

镜像构建注意：`src/extensions/{minimax,accio}` 用根 `Dockerfile` 同款（COPY src 全量）；`extensions/{workbuddy,workbuddycn}` 是独立包。

---

## 5. 建议的下一步（按优先级）

| 优先级 | 任务 | 说明 |
|---|---|---|
| **P0** | 决定生产 8080 是否升级到 1.2.10 | 需用户明确授权；生产目前无 11128/空帧/token 自动恢复等全部修复 |
| **P1** | 补扩展级账号删除 API + Core 联动 | 多账号前提；6 个扩展都要加 |
| **P1** | accio `pending` 改按账号隔离 | `Map<accountId, PendingLogin>` |
| **P1** | 补多账号 E2E（stub，不耗额度） | 各扩展：登录 2 个 stub 账号 → 断言轮换/切换 |
| **P2** | Accio 凭据导入 action | 解锁 Accio 的唯一现实路径 |
| **P2** | minimaxintl 部署 | 镜像已构建；需国际版账号 |
| **P2** | officeace 实现 | 需华为云 MaaS 账号 |
| **P3** | opencode | 需住宅出口或付费 key |
| **P3** | 并发压测 / 会话粘性策略 | 见审计报告 |

---

## 6. 相关文档索引

- `handoff/minimax-extension-report.md` — MiniMax 完整实施记录
- `handoff/accio-extension-report.md` — Accio 实施 + 登录阻塞分析
- `handoff/zcode-11128-fix-applied.md` — 11128 修复
- `handoff/zcode-11128-history-contamination.md` — 会话污染教训 + 交接规则
- `handoff/codebuddy-deployment-report.md` — developer-role 与 8080/18080 差异

---

## 7. 本轮提交记录（已全部推送）

```
2c0c0bf docs: accio login blocked — web login does not echo code to return_url
3ed0f7a fix(accio): declare the read-only account-status action
7de9366 feat(accio): Accio (Alibaba Accio Work) extension
4efca20 feat(minimax): QuotaSnapshotV1 quota surface so credits show in the Console
39a72f6 fix(minimax): parse the real credit/details response
0e95487 fix(minimax): canonical tool shape + timezone_id on cloud endpoints
040601a fix(minimax): route /v1/accounts/:id/claim (regex omitted it)
482b058 feat(minimax): daily check-in + credit balance (quota surface)
929a5d9 feat(minimax): declare a read-only account-status action
7281cf9 feat(minimax): MiniMax Code extension (China + International)
6da9e3b docs: MiniMax extension implementation report
15a2b79 chore(phase3): pin the compose stack to local/mpag-phase3:1.2.10
4d36a34 fix(extensions): re-read the adapter after token refresh
f414c01 fix(extensions): auto-recover from Core<->Extension token desync
fa66bf4 fix(workbuddy): suppress empty delta frames on the stream
a39c263 fix(workbuddycn): stop emitting empty delta frames on the stream
```
