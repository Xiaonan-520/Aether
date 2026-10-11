# Extension 生命周期与管理闭环（M0 设计定案）

> 状态：已实现部分见 §10 交付矩阵。本文是 Core/Manager/Console 三方共同契约，
> 取代零散的聊天记录决策。与 `EXTENSION_ARCHITECTURE_RFC.md` §17/§19.5/§24 兼容。

## 1. 领域模型：Extension 与 Provider 一对多

**Extension** = 可安装/升级/停止/卸载的部署单元（容器 + 镜像 + manifest + 命名卷）。
**Provider** = Gateway 路由与业务能力中的实体（registry 条目、账号外键、模型行）。

- 权威归属在 **manifest**：`manifest.providers[]` 声明该 Extension 提供的全部 Provider。
- **禁止假设 `extensionId === providerId`**（反例：一个 buddy-suite 扩展可同时提供
  `workbuddy`、`codebuddy`、`buddy-intl` 三个 provider）。
- Manager 落库归属：`extensions.provider_ids`（install 时从 manifest 写入，JSON 数组）。
  这是 Manager 的权威记录；Core 不新建归属表，归属关系经 API 透出。
- Core 侧 providers 表结构**不变**（id/display_name/capabilities_json/enabled），
  外键语义保留；extension 归属只在管理 API 视图层呈现。

## 2. 状态模型：三态分离

"容器在运行"、"Extension 已注册"、"Provider 可正常服务"是三个不同状态：

| 维度 | 来源 | 取值 |
|---|---|---|
| **installState** | Manager DB（`extensions.status`） | `pending / validating / pulling / starting / health_check / conformance / installed / stopped / failed / removing` |
| **runtimeState** | Core 实时探测 `endpointUrl/health`（容器网络内可达，1.5s 超时，30s 缓存） | `running / stopped / unreachable / unknown` |
| **healthState** | 探测响应体 `status` 字段 | `healthy / degraded / unknown` |
| **provider 服务态**（派生） | registry 是否挂载 + installState | `registered / not_registered` |

映射规则：
- Manager `install()` 全流程 → `installed`；`stop()` → **`stopped`**（v1.1.6 及之前
  错误地记为 `failed`，本轮修正；`failed` 只表示操作失败，不再复用为"人为停止"）。
- `runtimeState=stopped` 而 installState=installed：容器退出（崩溃/手动 docker stop），
  UI 应提示"重启"。
- installState=installed ∧ runtimeState=running ∧ provider 未注册：Core 重启后尚未
  bootstrap，UI 提示"重新加载注册"。
- Bootstrap（`registerRemoteExtensions`）只挂载 `installed` 的扩展——`stopped` 扩展
  重启 Core 后不会自动注册，符合预期。

## 3. 并发与防重

Manager 进程内每扩展互斥锁（`Map<extensionId, verb>`）：install/upgrade/stop/restart/
remove 进入时 acquire，冲突抛 `extension "x" is busy: <verb>` → Core 映射 409
`operation_in_progress`。finally 释放；进程重启锁自然清空（内存态）。
GET 永不加锁。重复幂等请求：remove 不存在的扩展 → 404（不假装成功）；install 已装
→ 409；upgrade 相同 version → 200 幂等 no-op（返回当前记录）。

## 4. Manager 扩展（本轮新增，最小改动）

1. `ExtensionStatus` 增加 `'stopped'`；`stop()` 落 `stopped`。
2. `extensions` 表增加 `provider_ids TEXT`（JSON 数组；schema v2，`ALTER TABLE ...
   ADD COLUMN` 兼容旧库，旧行读作 `[]`）。
3. `list()`/`get()` 返回体带 `providers: string[]`。
4. 新 verb `upgrade(extensionId, {manifest, image?})`，语义（蓝绿、保卷）：
   - 前置：记录存在；`extension.id` 与现装一致；锁可用。
   - `version` 相同 → 幂等 no-op（200）。
   - 流程：pull 新镜像（失败→旧容器继续运行，返回错误）→ 停止并删除旧容器
     （**命名卷绝不动**）→ 用新 manifest+镜像建容器（注入新 token）→ health →
     manifest handshake → conformance → `installed` + seal 新 token。
   - 失败恢复：步骤 2 之后任何失败 → **自动回滚**：用旧镜像+旧 manifest+新签 token
     重建旧版本容器；回滚成功 → `installed`（`error` 记录升级失败原因）；回滚也失败
     → `failed`（数据卷完好，operator 可 remove 后重装，凭据在卷内保留）。
   - 升级后 Core 需重新拉 registration（token 已换）：Manager 不推 Core；Core 管理
     API 的 reload 动作触发 `registerRemoteExtensions` 重跑（见 §5）。
5. Manager HTTP API 增加 `POST /api/extensions/:id/upgrade`，body
   `{manifest, image?}`（与 install body 同构）。

## 5. Core→Manager 通道（白名单，无通用代理）

**`src/service/manager-client.ts`**（Core 内部，非 HTTP 路由层）：

| 方法 | Manager 路由 | 超时 | 重试 |
|---|---|---|---|
| list | GET /api/extensions | 5s | GET 且网络错/5xx 重试 1 次 |
| get | GET /api/extensions/:id | 5s | 同上 |
| available | GET /api/extensions/available | 5s | 同上 |
| install | POST /api/extensions/install | 180s | **永不** |
| stop / restart / remove | POST /api/extensions/:id/(stop\|restart\|remove) | 60s | **永不** |
| upgrade | POST /api/extensions/:id/upgrade | 180s | **永不** |
| registration | GET /api/extensions/:id/registration | 10s | 网络错重试 1 次 |

- Bearer token 由 client 每次调用注入（`GATEWAY_EXTENSION_MANAGER_TOKEN`），
  **任何响应、日志、错误消息都不得包含 token**。
- 错误映射：`ECONNREFUSED/ETIMEDOUT` → 503 `manager_unavailable`；404 → 404
  `extension_not_found`；401 → 502 `manager_auth_misconfigured`；Manager 4xx → 400
  `manager_error`（message 透传 Manager 的已清理错误）；其余 → 502。
- 每个方法硬编码 URL 模板；**不存在接受任意 URL/路径的通用转发接口**。

Core 管理 HTTP 路由（全部继承现有 `/api/*` admin-token 中间件）：

```
GET  /api/console/extensions                → 列表（install/runtime/health 三态 + providers + 派生服务态）
GET  /api/console/extensions/:id           → 详情（含 lastError 清理版）
GET  /api/console/extensions/available     → 可安装候选（Manager available）
POST /api/console/extensions/install        → {manifest, image?}，受 §6 来源策略约束
POST /api/console/extensions/:id/(stop|restart|remove)  → 生命周期（remove 保卷）
POST /api/console/extensions/:id/upgrade    → {manifest, image?}
POST /api/console/extensions/:id/reload     → Core 重跑 bootstrap 注册该扩展（不触碰容器）
GET  /api/console/extensions/:id/actions/:providerId → 该 provider 的 manifest actions 声明（供 UI 动态表单）
POST /api/console/extensions/:id/providers/:providerId/actions/:actionId → opaque 代理到扩展 /v1/actions/:actionId（§7）
```

- 响应统一错误体 `{error: {code, message}}`，code ∈
  `manager_unavailable | extension_not_found | invalid_request | forbidden_image_source |
  operation_in_progress | manager_error | action_undeclared`。
- `remove` **不删数据卷**；"删除持久化数据"本轮不支持（UI 也不得出现该按钮），
  文档明示需手动操作。

## 6. 安装来源策略（受信任目录）

Core 对 install/upgrade 请求体执行：

- manifest 必须通过 Manager 侧校验（Manager 是第一道闸），Core 侧再做：
  - `image.repo === "local/gateway-extension-" + manifest.extension.id`
    （镜像由 operator 在宿主机构建的命名约定——本轮唯一受信任来源）；
  - `image.tag === manifest.extension.version`（版本即 tag，杜绝漂移）；
  - manifest `security.permissions.network.domains` 非空校验交给 Manager。
- 违反 → 400 `forbidden_image_source`。将来引入 registry/签名的受信来源时只需扩展
  本节策略函数，UI/API 形状不变。
- `available` 列表 = Manager 已知可注册项 ∪ 命名约定推导（`local/gateway-extension-*`），
  本轮不引入独立 catalog 文件。

## 7. Actions 交互通道（协议 v1 足够，不升版本）

现有协议已覆盖（评估结论，见 RFC v2 §16 与
`src/protocol/extension/actions.ts`）：

- manifest `providers[].actions[]`：`id/httpMethod/mode/sideEffects/ui/inputSchema/outputSchema`；
- 扩展端 `POST /v1/actions/:actionId`（manifest 白名单 + schema 校验，
  `extensions/workbuddycn/src/server/router.ts:260` 已实现）；
- 凭据边界：payload 对 Core 不透明，明文凭据只存在于请求生命周期内。

**结论：无需协议 v2。** 交互登录（external-link/device-code/sms/captcha）统一走：

1. Core 登录 API（现有，snake_case wire 格式不变）发起 `beginLogin`；
2. manifest 声明的 action 承载用户提交（sms 验证码、captcha token、凭据导入）；
3. `ui: none|basic|page` 决定 Console 渲染方式（动态表单用 inputSchema → 通用
   JSON 表单；`page` 类型 action 以链接/iframe 呈现扩展自有页面）。
4. ZCode captcha 的 Core 内共享状态机是**待迁移的 provider 专属逻辑**（Phase 3B
   双轨遗留），本轮只保证 action 通道可用，不迁移 zcode 本体（后续 M5）。

## 8. 数据保护

- 命名卷 `gw-ext-<id>-state`：install/upgrade/stop/restart/remove 全程不触碰；
  只有显式手动 `docker volume rm` 才删除（本轮任何 API 都不提供）。
- remove 只删容器 + Manager 记录 + sealed token；重新 install 同 id 扩展会复用
  同名卷（凭据保留）——已在 v1.0.2 升级中实测。
- 升级失败回滚不删卷；`failed` 记录保留供诊断，仅 remove 清除。

## 9. SDK 评估（阶段 E 结论）

薄 SDK `src/extension/sdk/`（仓库内部共享，不发包）：manifest 类型 + 校验、
token 认证中间件、健康端点、路由骨架（health/manifest/actions/accounts/models/
chat SSE）、统一错误结构、日志脱敏。**不包含**任何 provider 协议/签名/登录逻辑。
workbuddycn 改造为第一个消费者以验证抽象；其余 provider 后续迁移时接入。
（若时间盒内无法完成 workbuddycn 改造，SDK 以 workbuddycn 为对照实现并保持
其测试全绿，改造顺延——见 §10。）

## 10. 交付矩阵（随进度更新）

| 项 | 状态 |
|---|---|
| §1-§3 领域模型/三态/并发锁 | 已实现并测试（Manager + Core） |
| §4 Manager stopped/provider_ids/upgrade | 已实现并测试（蓝绿保卷+manifest_blobs 回滚+幂等；Phase 3 E2E 复验） |
| §5 ManagerClient + Core 路由 | 已实现并测试（投影错误映射：503/502/404 稳定 code） |
| §6 来源策略 | 已实现并测试（manager 宕机时仍拦截） |
| §7 Actions 代理 | 已实现（fake 扩展测试） |
| §8 数据保护 | 设计即实现（remove 保卷，Phase 3 E2E 复验） |
| §9 SDK | 已实现 `src/extension/sdk/`（14 测试；自包含，不 import src/core/protocol） |
| Console Extensions 页 | 已实现并测试（console 24/24 + lint/typecheck/build） |
| 安全回归 | `tests/security-regression.spec.ts`（认证矩阵/token 泄漏/manager 误配/来源策略，9 测试） |
| Phase 3 隔离 E2E | 完成（Core 1.1.9 + workbuddycn 1.0.2→1.0.3 蓝绿升级、reload 重挂载、真实上游聊天回环） |

## 11. M0 实施记录（2026-10）

- **装配顺序 bug**：`src/http/index.ts` 曾在 `createGatewayApp` 之后才设置
  `ctx.extensionManager`，而 console 扩展路由在 app 构建时按该字段挂载——
  生产环境下路由永不注册（全部 404）。修复：manager env 装配移到
  `createGatewayApp` 之前。
- **reload 重挂载语义**：升级轮换扩展 token 后，bootstrap 对已注册 provider
  调 `registry.register()` 会抛 "already registered" 并被 per-provider
  try/catch 吞掉——reload 假成功、旧 token 残留到下次网关重启。
  `ProviderRegistry` 新增 `replace()`（返回是否为替换既有注册），bootstrap
  统一走 replace；回归测试见 tests/extension-core-e2e.spec.ts "re-mount"。
- **投影错误映射**：`ExtensionService.list/detail/available` 必须经 `map()`
  稳定 code（503 manager_unavailable / 502 manager_auth_misconfigured /
  404 extension_not_found）；裸 `ManagerClientError` 漏出属 bug 而非契约。
- **账户自愈路径**：升级窗口内 chat 失败会把账户打成 auth_failed（不可选）。
  reload 修复后经 `POST /api/accounts/:id/refresh`（走新 token 的 provider）
  即恢复 active，无需人工登录。
- **测试基线**：Core 539 passed / 2 skipped（43 文件）；console 24/24。
