# WorkBuddyCN Extension 1.0.4 — RikkaHub Workspace 兼容性修复报告

日期：2026-10-16 ｜ Commit `148547f`（已推送）｜ 镜像 `local/gateway-extension-workbuddycn:1.0.4`（已构建，**未部署**）

## 1. 根因（已确认，代码级证据）

**字段命名不匹配（camelCase vs snake_case）**：

- Core → Extension 协议发送 canonical 形状：`toolCalls` / `toolCallId`（camelCase，见 `src/core/types.ts` ChatMessage 与 `src/extension/sdk/server.ts`）。
- Extension 的 `serializeMessages()` 只读 `tool_calls` / `tool_call_id`（snake_case），读到 `undefined`。
- RikkaHub Workspace 场景（JS Engine + AskUser 工具多轮调用）：assistant 发起 tool_calls 后，客户端回填 `role:'tool'` 消息 → 该消息发往上游时 `tool_call_id` 缺失 → 严格的上游校验返回 **HTTP 400** → Extension 映射为固定文案 "invalid chat request rejected by upstream"。
- **普通聊天没有工具消息，所以一直正常** —— 与"只有 Workspace 失败、偶尔一次成功（无工具轮次时）"完全吻合。

## 2. 修改内容

### 修复 1：诊断增强（`upstreamError` 400 分支）
上游 400 时提取其 `code`/`msg`（或非 JSON body 的截断摘要），经脱敏（token/key/secret/sk- 前缀字符串 → `<redacted>`，总长 ≤240）后写入错误 message 和 `detail.upstreamSummary`。下次再出现 Workspace 失败可直接看到上游拒绝原因。

### 修复 2：工具消息兼容（`serializeMessages`）
- 同时接受 canonical camelCase（`toolCalls`/`toolCallId`）和 legacy snake_case。
- canonical `{id,name,arguments}` 形状正确转换为上游 OpenAI 形状 `{id,type:'function',function:{name,arguments}}`，object 参数 JSON 字符串化。
- **孤儿 tool 结果**（id 缺失或与前面的 assistant tool_calls 不匹配）降级为 user 备注 `[tool result for <id>] ...`（截断 4000 字符）而非原样透传，避免 400。
- matched 的 tool 结果正常透传 `tool_call_id`。

### 版本：manifest + package.json → 1.0.4（镜像内实测 EXTENSION_VERSION=1.0.4）

## 3. 测试结果

| 项 | 结果 |
|---|---|
| 新增 `test/unit/tool-compat.spec.ts` | 10/10 通过（400 诊断×4 + 工具线格式×6） |
| Extension 全量 | **75/75 通过**（6 文件） |
| TypeScript | 0 error |
| RikkaHub 场景覆盖 | JS Engine/AskUser 的工具定义（tools 数组线格式）、多轮 tool_calls 助手消息、工具结果回填（matched 透传 + 孤儿降级）、恢复流程（AskUser 结果作为 tool 消息回到下一轮）均有用例 |
| 生产容器 | 未触碰；运行中的 1.0.3 容器未重启未部署 |

## 4. 构建产物

- 镜像：`local/gateway-extension-workbuddycn:1.0.4`（sha256 6a37ff897bb2，仅本地）
- Commit：`148547f`（main，已推送 GitHub）

## 5. 关于 RikkaHub 官方文档

文档仓库（rikkahub/rikkahub docs/chat-generation-pipeline.md）在服务器上无法访问（外网受限），本次修复基于协议两端代码的静态比对 + 日志证据链闭环，工具兼容面已由测试覆盖。若部署后 Workspace 仍有失败，1.0.4 的诊断日志会直接给出上游拒绝原因。

## 6. 未解决问题 / 待办

1. **部署**：需你授权后执行（Manager 升级 gw-ext-workbuddycn 1.0.3 → 1.0.4，凭据存储向后兼容，不需数据迁移）。部署后建议用 Workspace 复测一轮含 JS Engine + AskUser 的完整工具循环。
2. 若上游 400 由其它形状触发（如非文本 content 块、tool_choice），诊断日志会在下一次失败时给出确切原因，届时可做增量修复。
3. Core 侧 `tool_choice` 字段目前被 schema 静默剥离——若 RikkaHub 依赖它，需要单独评估（本次未改 Core）。
