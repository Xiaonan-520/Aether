# 11128 根因最终确认：ZCode gitSystemContext 的 MAIN_BRANCH_LABEL 指纹（2026-10-17）

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
- `codebuddy::glm-5.3-flash` + 该指纹 → 200（codebuddy 渠道不受影响）
- 触发条件总结：**buddy/workbuddycn 渠道 + system 中含字面串 `Main branch (you will usually use this for PRs)`**（典型来源：ZCode 在 git 仓库内的主对话）。

### 6. 与旧结论的关系
- "Claude Code 完整句触发 11128" 依然真实（实测复现过）——上游指纹库至少含两条规则；两者是**并列的独立指纹**，与本案例无关。
- 此前 13 种形态 A/B 未命中，因为测试 system 都是手工短句，恰好不含该 git 上下文句式。

## 最小修复方向（待授权，未实施）
ZCode 侧（无侵入）：官方无删除该句的配置；可考虑不在 git 仓库根目录启动、或等官方调整文案。
Gateway 扩展侧：在 workbuddy/workbuddycn 的 wire 组装时把该句改写为语义等价、不命中指纹的表述（如 `Main branch (for PRs): main`——已实测 "Main branch: main" 200，仍需实测改写变体）。影响面小、可加单测；但同样属于"替客户端规避渠道校验"，需你拍板。
