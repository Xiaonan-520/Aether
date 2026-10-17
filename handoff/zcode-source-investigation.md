# ZCode 官方源码调查：11128 指纹的 system prompt 来源（2026-10-17，只读源码分析）

## 1. 仓库信息
- 位置：`/tmp/zcode-investigation/ZCode`（保留供后续分析）
- 地址：https://github.com/zai-org/ZCode，分支 `main`
- commit：`aac4755666d09fdcd70272fcf063c077a639015f`（2026-10-10，"feat: update to v3.15.1"）
- 规模：311MB，pnpm monorepo（apps/zcode-cli + packages/desktop + contracts 等）

## 2. 身份声明的实际定义位置（源码证据）

| 身份语句 | 文件:行 | 用于 |
|---|---|---|
| `"You are ZCode, an interactive coding agent"` | `apps/zcode-cli/packages/core/src/context/sections/cli-prefix.ts:8`（`CLI_PREFIX_PROMPT`） | **主对话 system 第一段（CLI prefix）** |
| `"You are an interactive ZCode agent that helps users with software engineering tasks."` | `sections/identity.ts:30`（`buildIdentityPrompt`） | 主对话稳定身份段 |
| `"You are ZCode Explore, a file search and codebase research specialist for ZCode CLI."` | `subagent/explore.ts:35` | Explore 子代理 |
| `"You are ZCode connectivity probe."` | `runtime/methods/workspace-generate-text.ts:27` | 连通性探测 |
| 标题生成 system（`SESSION_TITLE_SYSTEM_PROMPT`，无身份声明） | `runtime/methods/title-generation-sidecar.ts:26` | 会话标题 sidecar |

**关键否定证据：官方源码中不存在 "You are Claude Code" / "Anthropic's official CLI for Claude" 字样**（全仓 grep 仅命中工具描述里的 "Claude Code-compatible alias" 与 bash 提示剥离逻辑，均非 system 身份）。我们实测触发 11128 的指纹语句**不是官方 ZCode 注入的**。

## 3. 主 Agent 提示词构建→发送调用链（源码证据）
1. **分段构建**：`context/builder.ts:build()`（:83）按序 push sections——①CLI prefix（:107，仅非 workflowActor）②身份/自定义 prompt（:113-124）③动态 system（desktop/dynamic-behavior/session-guidance/memory/env/output-style/context-mgmt/git，:130-172）④skills ⑤user context（AGENTS.md 项目指令，:193-201）⑥日期。
2. **组装 system 消息**：`builder.ts:assembleSystemMessages`（:233）——CLI prefix 单独一条 system；stable 段一条（带 ephemeral cacheControl）；dynamic 段一条。
3. **协议合并**：`packages/adapters/src/model/system-message-compat.ts:normalizeOpenAiCompatibleSystemMessages`——OpenAI 兼容出口把**多条前导 system 合并为一条**（原序拼接）。
4. **发送**：adapters/src/model/（model-execution 等）→ provider。

即上游看到的 system = `"You are ZCode, an interactive coding agent" + identity/harness + memory + AGENTS.md + env/date…`（拼接体）。

## 4. 辅助请求/子代理差异（源码证据）
- **标题生成 sidecar**（title-generation-sidecar.ts:26）：独立小请求，system 为固定标题指令，**无主身份段**——这正对应线上"失败/成功交替"里的成功类小请求。
- **连通性探测**（workspace-generate-text.ts:27）：`"You are ZCode connectivity probe."`，亦无主身份段。
- **子代理**（workflowActor）：builder.ts:102 **跳过 CLI prefix**，身份由 `sections/workflow-actor.ts` 重建（"You are ZCode…"字样不出现在开头）。
- Explore 子代理首句 "You are ZCode Explore, …"（explore.ts:35）。

## 5. 官方配置/扩展能力（源码证据）
- **customSystemPrompt 整段替换**（builder.ts:88-96,113-124）：可替换身份段之后的内容，**但 CLI prefix（"You are ZCode…"）在非 workflowActor 时无条件保留**（:105-107）——用户无法通过该机制去掉首句。
- **outputStyle**（identity.ts:30, types.ts:92-96）：有则首句换成 "You respond to the user according to the active Output Style below while using ZCode's tools and instructions."，`keepCodingInstructions` 控制是否保留 Harness；插件可提供 `outputStyles`（contracts/plugins/index.ts:156）。
- **AGENTS.md 项目指令**（adapters/src/context/index.ts:24，`DEFAULT_PRIORITY_FILES=["AGENTS.md"]`）：进入 system 尾部（request-user-context 段），**是用户可控的 system 内容入口**。
- **workflowActor persona**：仅脚本化工作流子代理可用。
- 未发现删除/改写 CLI prefix 的官方设置项。

## 6. 对 11128 指纹来源的判定（证据约束下）
- 官方 ZCode 的 system 首句与全部身份段**均不含**触发指纹，且我们实测 "You are ZCode, an interactive coding agent" 形态 200 通过。
- 因此触发指纹只可能来自 system 拼接体中的**用户侧/环境侧内容**：①工作区或用户级 AGENTS.md 等项目指令（进入 system）②插件 outputStyle/自定义 prompt ③**或用户实际使用的客户端并非本官方栈**（如 Claude Code/其他 CLI 配了网关 provider，或某 fork 加了身份句）。
- 无法从源码确认用户机器上的实际 system 内容——需要该机 ZCode 的 model-io/trace 日志（debug 包 `analyzer.ts` 显示运行时会记录完整 system prompt）或其工作区 AGENTS.md。

## 7. Gateway extension 兼容性边界（供评估）
- 可行层：扩展已在 wire 层组装 messages，具备按 dsh/proxy 同款 `stripClientFingerprint`（只剥实测命中的身份语句）处理的落点——但这是"替客户端隐藏身份"，合规性需你决策。
- 必须保留的信息：安全 IMPORTANT 行、Harness 约束、AGENTS.md 指令、memory——只剥命中指纹句、其余不动（workbuddy-proxy 的做法即如此，避免改变模型行为）。
- 无法在 extension 层解决的情形：若指纹在 **会话中途的 user 消息** 或上游缓存了账号级指纹，则只能客户端侧处理。
