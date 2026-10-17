# 11128 触发特征矩阵与项目对照（2026-10-17，只读调查）

## 1. 当前项目中与 11128 相关的代码位置和调用路径（已证实）

| 环节 | 位置 | 说明 |
|---|---|---|
| 首条 system guard | `extensions/workbuddy/src/provider/workbuddy/chat.ts:141`、`src/providers/shared/buddy/provider.ts:96`（`withLeadingSystem`）、`src/extensions/codebuddy/main.ts:277` | 注入中性 system，防 "first message is not system prompt" 语义的 11128。**workbuddycn 扩展没有等价 guard**（grep 全量确认） |
| 上游 400 的记录与映射 | `extensions/workbuddycn/src/provider/workbuddycn/chat.ts:180-188`（`mapUpstreamError` → `errors.terminal`）、`:197`（`sanitizeUpstreamRejection`，只保留 code/msg、脱敏、≤240 字符） | 11128 原文透传给客户端 |
| 事件落库 | `src/service/chat-service.ts:138/144`（`record` → `store.addEvent`） | 只存 ts/provider/accountId/kind/message（错误摘要），**不存 messages/prompt**（events 表列已核实：id,ts,level,provider,account_id,job_id,kind,message,payload_json，且 payload 为 null） |
| 客户端可见化 | 扩展 `TERMINAL` → `remote-provider.ts` `extensionErrorToUpstreamError` → OpenAI error body | ZCode 显示为 provider_code=terminal |

## 2. 已有指纹处理逻辑及测试覆盖（已证实）

- **仓库内不存在任何 system prompt 指纹匹配/清洗代码**。grep `fingerprint|strip client|sanitize system` 全量命中均为：trae 的设备指纹、manager 的 token SHA-256 指纹（`manager/extension-manager.ts:134/380`）——与 system prompt 无关。
- 消息级规范化已有：workbuddycn `chat.ts` `serializeMessages`（孤儿 tool 结果降级 user note、camelCase 兼容、空 content→null）；测试 `extensions/workbuddycn/test/unit/tool-compat.spec.ts`（15 用例）与 `tests/normalizer.spec.ts`（错误归一）。**均不涉及 system 内容改写**。
- 结论：若选择做指纹剥离，是从零新增能力，无现成规则可复用（不应照搬第三方清单）。

## 3. 候选触发特征证据对照表（真实上游 A/B，全部经 phase3 网关→workbuddycn 扩展→copilot.tencent.com，max_completion_tokens=5）

| 候选特征 | 结果 | 判定 |
|---|---|---|
| `You are Claude Code, Anthropic's official CLI for Claude.`（完整句） | **11128** | ✅ 触发（与用户错误一字不差） |
| 同句小写、无句号 | **11128** | ✅ 触发（大小写不敏感、句尾句号可选） |
| 同句嵌入更长文本（前缀+后缀） | 200 | 不触发 |
| 同句拆成两句（"You are Claude Code. Anthropic's …"） | 200 | 不触发 |
| 同句去空格/空格变体 | 200 | 不触发 |
| `You are Claude Code`（仅短句） | 200 | 不触发 |
| `Anthropic's official CLI for Claude`（仅后半） | 200 | 不触发 |
| `You are Codex CLI` / `OpenAI Codex` / `Gemini CLI` / `Qwen Code` / `Cursor` | 200 | 不触发 |
| `You are ZCode, an interactive coding agent`（官方 ZCode 首句） | 200 | 不触发 |
| 指纹句作为第二条 system（首条正常） | **11128** | ✅ 触发——校验作用于**任一 system 消息**，非仅第一条 |
| 指纹句放在 user 消息里 | 200 | 不触发——**仅校验 system 消息** |

匹配粒度判定：上游对每条 system 消息做**规范化后的完整连续子串匹配**（大小写不敏感；句首句尾可有轻微差异，但句中不能增删字符/拆句）。第三方 proxy 项目的单条正则 `You are Claude Code,\s*Anthropic's official CLI for Claude\.?/i` 与实测行为一致；其公开资料提到的 "Codex CLI 等字符串" **未获实证**（实测 200）。

## 4. 日志能确认的事实与未知项

已确认：3 次 11128（03:01/03:02/03:03，key="agent"，provider=workbuddycn），与相邻成功秒级交替；events 表无 messages 内容（隐私设计），**无法回溯当时 system 是否含指纹**。
未知：该机 ZCode 实际发出的 system 内容（官方 ZCode 源码 aac47556 无此指纹句；指纹更可能来自工作区/用户级 AGENTS.md、插件 outputStyle，或该机实际使用的非官方客户端）。

## 5. 后续最小验证方案及风险边界（均需你批准）

1. **零成本优先**：在失败那台机导出 ZCode 的 model-io/trace（其 debug 包 `analyzer.ts` 支持解析完整 system prompt），或查看其工作区 AGENTS.md——直接确认指纹来源，无需任何上游请求。
2. **一次性可审计日志（需批准）**：在 Core 对该 api key 加临时 debug 事件（仅记录各 message 的 role+字符长度+system 是否命中已知指纹正则，不含内容），复现一次后移除。影响：极小；不含对话内容。
3. **不建议**：批量收集上游指纹黑名单（等于持续探测渠道限制）、自动重试换句、伪造身份——违反渠道限制且不可审计。

## 6. 当前状态
只读；本轮探测总消耗 <100 tokens，临时 key 全部撤销；零代码/配置修改；生产未触碰。
