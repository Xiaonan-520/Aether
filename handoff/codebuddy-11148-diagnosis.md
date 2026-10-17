# CodeBuddy 11148 "tool calls and tool results do not match" 诊断报告
（2026-10-17，只读诊断，未修改代码，未部署）

## 1. Gitee 项目研究结果（deepseek-harness-codearts）

获取并研读了 `src/openai-compat.ts`（84KB）、`src/sse.ts`（67KB）、`src/message-shape.ts`、`src/buddy.ts`（该仓库 git 协议不可达，通过 raw 文件接口获取）。

### 关键发现（与我们的问题直接相关）

**a) `resolveToolPairing`（sse.ts:248）— 孤儿工具调用清理**
- 上游对 messages 里 tool_calls 与 tool 结果的配对做严格校验，不匹配即 400。
- 该项目的策略：**请求发出前**计算 keepCallIds/keepResultIds：
  - 一批 tool_calls 只有**全部**拿到结果才保留（部分保留会留下无结果的调用，后端照样拒绝）；
  - 名称不可用（空串）的 tool_call 无论配对与否都剔除；
  - 结果消息只有在对应 tool_call 保留时才保留。

**b) 空名 tool_call 的跨 provider 传染（sse.ts:222-235，2026-09-23 用户报障）**
- 上游 SSE 偶发吐出无 name 的 tool-call 分片 → 消费器落成 `name:''` 块 → 持久化进会话 → **之后每次请求原样重放 → 会话彻底报废**（"一发消息就报错，怎么重试都不行"）。
- 腾讯系端点实测：`function.name` 为 `"read"` → 200；`"unknown_tool"` → 200（只校验非空）；`""`/缺失 → **400**（配对缺口报 11148，参数非法报 11133，两者成因独立）。
- 该项目的结论："坏块已在会话里，harness 不会自愈。适配器是最后一道防线：发出请求前剔除。"

**c) `serializeMessages`（openai-compat.ts:162）— 上游 wire 形态的完整映射**
- assistant：`tool_calls`（OpenAI 形）+ 正文为空且有调用时 `content:null` + `reasoning_content` 单独字段；
- tool：`role:'tool'` + `tool_call_id` + 字符串 content，且**必须紧跟其 assistant tool_calls**（openai-compat.ts:256 原注："中间插消息会 400"）；
- 孤儿结果丢弃；`normalizeToolArguments` 把截断/非法 arguments 兜底为 `{}`。

**d) DSML 处理（dsml.ts / sse.ts:518+）**
- DSML 是特定通道（注入了 DSML system prompt 的）模型把工具调用渲染成 `<｜DSML｜…>` 文本的现象；该项目用 `DsmlContentExtractor` 做流式文本解析，**只在确认通道用 DSML 时开启**。与 11148 是两条独立问题线。

## 2. 当前 Gateway 诊断结果

### 已确认事实（全部实测）
1. **CodeBuddy 扩展不转换 messages**（main.ts:220-223）：Core canonical 形的
   - assistant 消息带 `toolCalls:[{id,name,arguments}]`（camelCase、无 type/function 包装）→ 上游不认识 → **静默忽略**；
   - tool 消息带 `toolCallId`（而非 `tool_call_id`）→ 字段丢失。
   对照组：buddy 内置 provider 的 `toUpstreamBody`（provider.ts:107-127）有完整的 tool_calls/tool_call_id 映射；Gitee 项目的 `serializeMessages` 同样完整。**只有 codebuddy 扩展缺失。**
2. **Core 流式向 Pi 发出 `name:""` 的 delta 帧**（实测，serialize.ts:76-81 `name: tc.name ?? ''`）：
   ```
   帧0: {index:0,id:"call_0348…",type:"function",function:{name:"bash",arguments:"{\""}}
   帧1: {index:0,type:"function",function:{name:"",arguments:"command"}}   ← name:""!
   …
   ```
   Gitee 实测证明这类空名块一旦被客户端持久化，会**每次请求重放**（"怎么重试都不行"——与用户"重新尝试后仍然相同错误"吻合）。同时多工具调用时 index 每帧重置为 0，多个调用会叠在同一 index。
3. **11148 无法在短会话直打下复现**（10+ 种形态 A/B：canonical 回传、OpenAI 形无结果、错误 tool_call_id、放弃调用后新会话……全部 200）。上游对短会话宽容；11148 触发需要**多轮长历史**（Gitee 注释证实上游校验 tool 消息必须紧跟 assistant tool_calls）。这与用户"Pi 多轮对话中报错、重试同样错误"完全一致。

### 最可能根因（按证据链，未宣称唯一）
**CodeBuddy 扩展缺失 messages 的 canonical→OpenAI 转换**，导致：
- 上游永远看不到历史中的 tool_calls/tool 结果配对（字段名错误被忽略）；
- 1.0.3 修复 tools 定义后上游开始真实发起调用并（按 Gitee 证据）在服务端按会话校验配对；
- Pi 的多轮历史到达上游时，assistant 无有效 tool_calls 却跟着 role:'tool' 消息 → 孤儿结果/配对缺口 → **11148**；
- 重试携带同样的坏历史 → 每次都错。requestId 不同但历史相同 → 错误相同。
- 叠加因素：Core 流式的 `name:""` 帧会让 Pi 落下空名块（Gitee 实测此类块对腾讯系端点 400），使历史进一步不可修复。

### 尚未确认的假设
- 用户那台 Pi 的会话历史具体形态（是否含空名块）——需要该机 session jsonl 才能确认占比。
- 11148 的确切触发阈值（几轮/几条孤儿 tool 消息）——上游黑盒，无法离线确认。

### 需要进一步收集
- 失败时那台 Pi 的 session jsonl（脱敏）中最后一条请求的 messages 形态；
- 或在 Core 加一次性 debug 日志（记录扩展收到的 messages 形态，无敏感内容）——**需你确认后才会加**。

## 3. 修复建议（待授权，未实施）

### 最小改动（两个文件，与 Gitee/buddy 内置 provider 同型）
1. **codebuddy 扩展 main.ts `upstreamChat`**：messages 映射——assistant 的 `toolCalls` → OpenAI `tool_calls`（type:function 包装），tool 的 `toolCallId` → `tool_call_id`，空名调用剔除（`resolveToolPairing` 同型：一批调用全部有结果才保留），孤儿 tool 结果丢弃，空 content+有调用时 `content:null`。
2. **Core serialize.ts 流式帧**：`name: tc.name ?? ''` → 仅在 `tc.name` 非空时才输出 name 字段；tool_calls 的 index 应跨帧保持（扩展 chunk 的片段本就同序）。这是对**所有** provider 生效的协议修复。

### 回归测试清单
- E2E：多轮 canonical 历史（1 调用 / 多调用并行 / 缺结果 / 空名块）→ 断言上游 wire 形态正确、孤儿剔除；
- Core 流式帧断言：无 `name:""` 输出、index 连续；
- 回归：现有 38/38 codebuddy E2E + Core 691；
- Pi 端闭环：ls -la 工具调用 → 结果回传 → 连续第二轮工具对话不报 11148。

### 兼容性风险
- Core serialize 改动影响所有 provider 的流式输出：省略 name 字段对 OpenAI 语义是**更正确**的（后续帧本不该重发 name）；需跑全量 Core 测试。
- 扩展剔除空名调用会丢一轮工具上下文（Gitee 同款取舍："宁可丢失一轮工具上下文，也好过整条会话死亡"）。

## 4. 当前运行状态

- Core/Manager：**1.2.6**（healthy）；codebuddy/buddy-intl 扩展：**1.0.3**；workbuddy 1.0.3、workbuddycn 1.0.6；4 账号 active。
- 生产 ai-gateway：未触碰（Up 2 weeks+）。
- 本轮执行过的修改：**无**（仅只读诊断与最小化上游探测，临时 key 均已撤销）。

---

## 修复实施记录（2026-10-17，授权后执行）

### 改动文件
| 层 | 文件 | 改动 |
|---|---|---|
| Extension | `src/extensions/codebuddy/main.ts` | 新增 `toUpstreamMessages`：canonical→OpenAI wire 映射（tool_calls 包装、tool_call_id、content:null 规范、arguments 空串兜底 `{}`）+ `resolveToolPairing` 同型防御（一批调用全部有结果才保留；空名不可用；孤儿结果剔除）。版本 1.0.3→**1.0.5** |
| Core | `src/protocol/openai/serialize.ts` | 流式 delta：`name` 仅在非空时输出（不再发 `name:""` 毒化客户端历史）；index 优先取片段自带的上游 index |
| Core | `src/protocol/openai/sse.ts` | decode 保留上游 `tool_calls[].index`（并行调用交错分片必需） |
| Core | `src/core/types.ts` | `ChatChunk.toolCalls[]` 增加可选 `index` |

Core 1.2.6 → **1.2.8**（1.2.7 为第一轮部署，1.2.8 含 index 透传）。

### 测试
- 新增 E2E「maps canonical tool history to the upstream wire form (11148 pairing fix)」：完整多轮映射 / 缺结果整批剔除 / 空名剔除+孤儿结果清除 / 无调用孤儿结果丢弃 / 空 arguments 兜底 `{}` —— 双产品实例 5 组断言
- 新增 Core 流式协议测试：name 仅非空输出（帧上永无 `"name"` 空串）、并行调用 index [0,1] 稳定、交错分片 index 透传
- codebuddy E2E **40/40**；Core 全量 **694 passed | 2 skipped**（51 文件）；typecheck 全绿

### 部署
Core/Manager 1.2.8 healthy；codebuddy/buddy-intl 1.0.5 upgrade 200 自动重注册（workbuddy 1.0.3 / workbuddycn 1.0.6 未动）；4 账号 active；凭据卷未动；生产 ai-gateway 未触碰。

### 真实上游多轮验证（流式，临时 key 已撤销）
| 步骤 | 结果 |
|---|---|
| 轮1 单工具 | finish=tool_calls，`{"command":"ls -la"}`，**0 个 name:"" 帧** ✅ |
| 轮2 结果回传+并行双工具 | **2 个调用正确分离**：bash `{pwd}`、calc `{2+3}`，各自独立 id ✅（修复前叠成一个畸形调用）|
| 轮3 双结果回传→最终回答 | 200："Results: pwd: /home/x… 2+3: **5**" ✅ |
| 非流式聊天 | 200 "ok" ✅ |
| Quota 回归 | 4 provider 全 known:true（83.93/2318.97/1418/100）|

### 已证实 vs 未验证
- ✅ 已证实：wire 映射正确（E2E 断言捕获的上游 payload）；空名帧消除；并行 index 稳定；多轮配对完整；11148 的两条成因路径（孤儿 tool 消息+空名历史）在上游 wire 上已不可能产生
- ⚠️ 未验证：用户真实 Pi 长会话中 11148 是否复现（需该机实际使用确认——历史里已持久化的空名块在新会话中不再产生，但旧会话残留需 Pi 侧新开会话规避）；上游 11148 的确切触发阈值（黑盒）
- 回滚方案：Core 镜像回退 1.2.6（remove+reinstall ext 1.0.3）；ext 回退镜像 tag 1.0.3
