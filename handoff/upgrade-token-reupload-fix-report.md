# Extension 升级后 Core 未重注册 remote provider — 修复与验证报告

日期：2026-10-16 ｜ Commit `3902bd9`（已推送）｜ Phase 3 Core 镜像 `local/mpag-phase3:1.2.1`（已部署）

## 1. 根因

`ExtensionService.upgrade()` 让 Manager 重建扩展容器（Manager 轮换扩展令牌），但**没有重新执行 remote bootstrap**——Core 内存中的 provider 仍持旧令牌。此后每次聊天：Core→扩展 401 'extension auth token mismatch' → Core 误判为凭据问题 → 刷新也被 401 拒 → 账户 park 成 `token_expired` → 池空 → 503 "no available account for this model"。

关键代码缺陷：`registerRemoteExtensions()` 只在 `reload()` 调用，`upgrade()` 成功后没有；且 bootstrap 对单个扩展注册失败是 warn-and-skip，升级路径感知不到。

## 2. 代码改动（commit 3902bd9）

| 文件 | 改动 |
|---|---|
| `src/service/extension-service.ts` | ① `upgrade()` 成功后自动 `registerRemoteExtensions({strict:true})`；失败时抛 503，message 内含一键恢复指引（POST /:id/reload）② 新增 `lifecycleLocks`：同一扩展的 upgrade/reload 串行化，并发第二个请求得 409，锁在 finally 释放 ③ bootstrap 调用改传注入的 `fetchImpl`（可测试性） |
| `src/http/remote-bootstrap.ts` | `registerRemoteExtensions` 新增 `fetchImpl` 与 `{strict}` 选项：strict 模式把单扩展注册失败从 warn-and-skip 变为抛错（启动 boot 路径保持原 warn 行为）；内部收集 failures 汇总报错 |
| `tests/extension-lifecycle.spec.ts` | 5 个新回归用例 |

## 3. 测试结果

- 新增 5 用例全过：①升级后自动重注册（新令牌挂载、provider in-place 替换）②重注册失败→503+reload 提示 ③同扩展并发 upgrade 串行化（第二个 409，只执行一次）④Manager 拒绝升级→不触发 bootstrap、状态一致 ⑤reload 幂等（两次 bootstrap 不双挂）
- Core 全量：**636 passed | 2 skipped**（49 文件），typecheck 0 error

## 4. 部署

- 镜像：`local/mpag-phase3:1.2.1`（从 3902bd9 构建，镜像内已验证含 lifecycleLocks/strict 标记）
- compose override 两处 image 钉版 1.2.0→1.2.1；修复后的源文件同步至 `~/.mpag-p3/src/` 部署树（防两棵树漂移重演）
- 仅影响 phase3-gateway / phase3-extension-manager 重建；生产 `ai-gateway` 未触碰（Up 2 weeks 未变）；gw-ext-workbuddycn 1.0.4 容器未动（Up 22min 持续）

## 5. 部署后验证（实际请求，非仅健康检查）

1. **令牌注册一致性**：Core 启动日志 "1 remote provider(s) registered"；显式 reload → 200 `{"ok":true,"providers":["workbuddycn"]}`（幂等路径实测）
2. **账户恢复**：账户曾 park 在 `token_expired`（升级事故遗留）。经 `POST /api/accounts/:id/refresh`（scheduler token_refresh 任务）→ 扩展用新令牌刷新成功（ext 日志 `token.refresh status:ok`）→ 账户恢复 **active**
3. **普通聊天**：`workbuddycn::deepseek-v4-flash` → **200**，content "ok"
4. **流式**：SSE 200，`text/event-stream`，23 个 data 帧
5. **工具调用（Workspace 场景）**：带 tools 请求 200；**完整多轮工具循环**（assistant tool_calls → tool 结果回填 tool_call_id）→ **200**，"1 + 1 = **2**" —— 正是 1.0.4 修复 + 本次令牌修复叠加验证的路径
6. 验证用临时 API Key（verify-104-temp）已撤销，无残留

## 6. 遗留观察

- 账户 park 在 token_expired 后，chat 路径无法自愈（选不中→tryRefresh 不触发，属先有鸡还是先有蛋）。本次经 admin 手动 refresh 任务恢复。建议后续：chat 503 前若池空且有 refreshable 账户，自动尝试一次 refresh——**未实施**，待你授权排期。
- 临时验证 Key 的创建/撤销均通过 admin API 完成，全程未输出 Key 明文到日志。
