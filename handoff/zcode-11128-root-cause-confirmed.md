# 11128 根因最终确认：ZCode gitSystemContext 的 MAIN_BRANCH_LABEL 指纹（2026-10-17）

> **⚠️ 本文件含触发串原文（仅为保留源码/变体证据）。** 按交接规则，**禁止**把本文中的该串
> 粘贴到 assistant 正文、摘要或诊断对话——它一旦进入 assistant 消息就会随历史重放并持续触发 11128。
> 引用时一律使用描述性代称「git 上下文标签串」。
> **后续增补（校验范围、渠道范围、会话历史污染与交接规则）见 `zcode-11128-history-contamination.md`。**

## 证据链（全部实测 + 源码定位）

### 1. 用户提供日志（zcode-logs zip，ZCode v3.15.3）
- 失败 session `sess_920fad15`：5 条 model-io 记录中 4 条 `workbuddycn::deepseek-v4.1-flash` **全部 11128**，1 条 `codebuddy::deepseek-v4.1-flash`（connectivity probe，system="You are ZCode connectivity probe."）200。
- 失败请求的 system 首句为**官方 ZCode 身份**（"You are ZCode, an interactive coding agent…"），**无任何 Claude/Anthropic 字样**（grep 计数 = 0）——推翻此前"客户端身份指纹"假设。
- 失败请求：5 条消息（1 system 11,271 字符 + 4 user）、42 个 tools。

### 2. 真实上游重放复现
用日志中提取的**完整真实 system（11,271 字符）**重放 → **11128 复现**。随后按段落（\n\n 分块，36 块）二分：
- blocks[0:14] ✅ / [14:25] ✅ / [25:30] ✅ / **[30:36] ❌** → 逐块测试 → **block33 = "Main branch (you will usually use this for PRs): main" 单独即触发**。

### 3. 指纹精确边界
| 变体 | 结果 |
|---|---|
| `Main branch (you will usually use this for PRs): main` | ❌ 11128 |
| `Main branch (you will usually use this for PRs)`（无值） | ❌ 11128 |
| `…(…) : develop`（改分支名） | ❌ 11128 |
| `Main branch: main`（去括号说明） | ✅ 200 |
| `Main branch` | ✅ 200 |

结论：上游指纹 = **字面串 `Main branch (you will usually use this for PRs)`**，与分支值无关。

### 4. 源码定位（官方 ZCode 仓库 aac47556）
`apps/zcode-cli/packages/core/src/context/sections/env-info.ts:24`：
```ts
const MAIN_BRANCH_LABEL = "Main branch (you will usually use this for PRs)";
```
由 `buildGitSystemContextSection`（同文件）在**检测到 git 仓库时**注入 dynamic system 段——任何在 git 仓库内使用 ZCode 的主对话都会携带该句。官方测试 `context-builder.test.ts:654/1281` 断言该句存在。

### 5. 影响面（真实上游交叉验证）
- `workbuddy::glm-5.3` + 该指纹 → **11128**（workbuddy 族全受影响）
- `codebuddy::glm-5.3-flash` + 该指纹 → 200（**此结论已被后续实测推翻**：codebuddy 同样返回 11128，见 `zcode-11128-history-contamination.md` §3）
- 触发条件总结：**buddy/workbuddycn/codebuddy 渠道 + 消息中包含该指纹（system 或 assistant 正文）**（典型来源：ZCode 在 git 仓库内的主对话）

### 5.1 勘误（2026-10-17 后续，实测）

1. **CodeBuddy 不受影响 → 错误**。codebuddy provider 携带同一指纹的请求返回 `11128`。不能再以渠道作为隔离依据。
2. **仅 system 触发 → 错误**。assistant 正文携带该指纹同样 11128；user / tool 结果 / tool_call arguments / reasoning_content 不触发。
3. **该指纹不是 Pi 或 ZCode 的固定身份声明**，它是一句 git 上下文标签。在 Pi 会话中它之所以出现，是因为 agent **自己把它作为诊断结论写进了 assistant 正文**——属于可避免的自污染，与客户端身份无关。

### 6. 与旧结论的关系
- "Claude Code 完整句触发 11128" 依然真实（实测复现过）——上游指纹库至少含两条规则；两者是**并列的独立指纹**，与本案例无关。
- 此前 13 种形态 A/B 未命中，因为测试 system 都是手工短句，恰好不含该 git 上下文句式。

## 最小修复方向（待授权，未实施）
ZCode 侧（无侵入）：官方无删除该句的配置；可考虑不在 git 仓库根目录启动、或等官方调整文案。
Gateway 扩展侧：在 workbuddy/workbuddycn 的 wire 组装时把该句改写为语义等价、不命中指纹的表述（如 `Main branch (for PRs): main`——已实测 "Main branch: main" 200，仍需实测改写变体）。影响面小、可加单测；但同样属于"替客户端规避渠道校验"，需你拍板。
