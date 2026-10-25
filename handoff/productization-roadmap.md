# Aether 产品化改造 — 路线图与进度

> 本文件是长任务的断点续作依据。上下文中断后先读这里，再看 `git status` 和 Docker 状态。

## 环境基线（开工时记录）

| 项目 | 值 |
| --- | --- |
| 本机工作区 | `/home/xiaonan/multi-provider-ai-gateway`（GitHub 仓库已改名 Aether，本地目录名未变） |
| 分支 / HEAD | `main` / `f726c21 feat(auth): add admin registration and session authentication` |
| 未跟踪文件 | 23 个历史杂物（blog_*、TASK8/9 报告、screenshots 等），保持不动 |
| 本机 Docker | 29.9.2；只有 `aether-auth-local-gateway`（本机测试栈）与一个已退出的残留容器 |
| 生产服务器 | 不在本机，本轮**不触碰** |

## 阶段与状态

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P0 | 环境与架构盘点 | ✅ 完成 |
| P1 | 已知问题修复（KI-002 健康检查、MiniMax 版本） | ✅ 完成 |
| P2 | 密码修改、Admin Token 归属（DB v4） | ✅ 完成 |
| P3 | Console 界面（Token 创建者列、密码对话框、扩展安装） | ✅ 完成 |
| P4 | KI-001 安装流程简化（inspect-image） | ✅ 完成 |
| P5 | 测试补齐与全量回归 | ✅ 完成 |
| P6 | 文档更新（README、TROUBLESHOOTING、known-issues） | ✅ 完成 |
| P7 | Git 审查与本地提交（不推送） | ✅ 完成 |

## 既有能力（P0 盘点结论）

已在 `f726c21` 落地并验证：

- 首次管理员注册（邮箱 + scrypt）、永久关闭公开注册、并发安全（原子 `createFirstAdminUser`）
- 邮箱密码登录、失败限流（5 次 / 15 分钟，按 email）
- 会话 Token（`adm-` 前缀，库内只存 SHA-256，12h TTL，可撤销）
- `GATEWAY_ADMIN_TOKEN` 兼容保留为内部凭据
- Console `AuthGate` 三态（注册 / 登录 / 已登录）

## 本轮要新增

- **Admin Token 体系**：用户自建、命名、可撤销、只在创建时显示一次、可过期（区别于会话 Token 与内部 `GATEWAY_ADMIN_TOKEN`）
- **KI-002**：Manager healthcheck 端口 8080 → 9100
- **MiniMax**：manifest 版本与镜像 tag 一致性（本地仓库当前仍是 `1.0.0`，服务器上改过但未回传）
- **KI-001**：降低扩展安装的操作门槛

## 进度日志

### 2026-10-25 — 本轮完成

**修复**
- KI-002：`docker-compose.extensions.yml` 的 manager 服务补上 healthcheck，指向真实的 `9100/healthz`
  （原文件根本没有 healthcheck；部署环境里那份探测 8080 是错的）。没有关闭健康检查。
- MiniMax：`src/extensions/minimax/main.ts` 的 manifest 版本 `1.0.0` → `1.0.14`，与镜像 tag 对齐。
  此前正是这个不一致导致 Core 的 `assertTrustedSource` 拒绝安装。

**新增**
- 密码修改：`POST /api/auth/password`（需当前密码，撤销该管理员的所有其他会话，返回新会话）。
  Store 层新增 `updateAdminPassword` / `revokeAdminSessionsForUser`（SQLite + Memory 双实现）。
- Admin Token 归属：迁移 v4 给 `api_keys` 加 `created_by` 列（可空，旧数据不迁移、不丢），
  `ApiKeyView` 增加 `createdBy`，控制台新增 "Created by" 列。
- KI-001：`ExtensionManager.inspectImage()` + `POST /api/extensions/inspect-image`（Manager），
  `POST /api/console/extensions/install-from-image`（Core），控制台 Install 对话框。
  安装只需镜像名 + tag，不再手工提取 manifest。
- 避免创建已过期的 Token（`expiresAt` 必须在未来）。

**测试**
- `tests/productization.spec.ts`（18 个）：密码修改全流程、会话撤销语义、Token 归属、
  三种凭据边界、过期校验、撤销后失效。
- `tests/extension-inspect-image.spec.ts`（7 个）：探针返回真实 manifest、不落库、失败也清理、
  拒绝 latest、路由鉴权。
- 全量：Core **865 passed / 2 skipped**（60 文件）；Console **39 passed**；typecheck/lint/build 全绿。

**Docker E2E（本机 `aether-auth-local` 栈）**
- schema v4 迁移确认；密码为 scrypt 摘要且无明文；`api_keys.created_by` 列存在。
- 实测：注册 → 创建 Token（记录创建者）→ Token 可用于 /v1、不可用于 /api → 会话不可用于 /v1 →
  改密码 → 旧会话与旧密码失效、新会话可用、**Token 不受密码变更影响**。
- 容器 healthy，日志无错误，Console 200。

**未验证**
- KI-002 的 `healthy` 状态需要在实际部署环境重启管理器后观察，本机只做了配置与静态校验。
- 真实 Docker 环境下的 `inspect-image` 端到端（本机用 LocalProcessRuntime 覆盖同一代码路径）。
