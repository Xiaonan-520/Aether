# CodeBuddy 工具调用丢失根因报告（2026-10-17，只读诊断，未修改）

## 现象
- workbuddy 模型（Pi/RikkaHub）工具调用正常
- codebuddy::glm-5.3-flash 工具调用异常：模型回答"没有 shell 权限"，DSML 标记
- 那台 Pi 配置已确认正常（18080、workbuddycn/codebuddy 命名空间、reasoning:true）

## 根因（A/B 实测实锤）
**codebuddy 扩展把 Core 传来的 canonical 形 tools 原样透传给上游，上游不认识该格式，静默忽略 → 模型根本没收到工具定义。**

- Core → 扩展协议传 canonical 形：`[{name:"bash", description, parameters:{...}}]`
- 上游要求 OpenAI 形：`[{type:"function", function:{name, description, parameters}}]`
- 对照组：buddy 内置 provider 在 provider.ts:130-136 把 canonical map 成 OpenAI 形 → workbuddy 正常
- codebuddy 扩展 main.ts:227 `payload.tools = body.tools` 原样透传 → 上游收到 `[{name,...}]` 不含 type/function 字段 → 静默丢弃（HTTP 200，无报错）

### A/B 实测（扩展容器内，真实凭据，直打 copilot.tencent.com/v2/chat/completions，glm-5.3-flash + "ls -la"）
| 组 | tools 形态 | 上游结果 |
|---|---|---|
| A（OpenAI 形） | `[{type:"function",function:{...}}]` | **5 帧 tool_calls，finish=tool_calls，args={"command":"ls -la"}** ✅ |
| B（canonical 形） | `[{name:"bash",...}]` | 0 帧 tool_calls，finish=stop，content="I don't have a live shell…" ❌ |

上游对不识别的 tools 格式**不报错、静默忽略**——这就是没有错误日志的原因。

## DSML 判定
上游从未输出 DSML（A/B 两组实测均 0 DSML）。DSML 标记 = 模型在**无工具 schema** 时把内部工具调用标记当普通文本吐出的表现。是"上游没收到工具定义"的结果，不是独立协议问题。

## 四层链路确认
- A 客户端→Core：tools 完整（Pi 配置正常）
- B Core→扩展：canonical 形完整传递 ✓（协议本身如此）
- C 扩展→上游：**格式错误（canonical 形未转换）← 故障就在这一步**
- D Core→Pi：模型无工具可用 → 文本回复（Pi 端自然无工具执行）

## 最小修复方案（待授权后实施）
codebuddy 扩展 main.ts 的 upstreamChat 中，将透传改为映射（与 buddy 内置 provider 相同的 4 行 map）：
```ts
if (Array.isArray(body.tools) && body.tools.length > 0) {
  payload.tools = body.tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters ?? {} },
  }))
}
```
同时 workbuddy/workbuddycn 扩展的 chatNonStreaming 路径需要核查是否存在同样问题（它们的 toolMap 收集逻辑在流式路径已验证正常，但扩展→上游的 tools 形态需逐一核对）。

## 验证标准
1. codebuddy E2E 补"canonical→OpenAI 形映射"断言
2. Core 链路 codebuddy::glm-5.3-flash + tools → finish=tool_calls 且 tool_calls 完整
3. Pi 端真实执行 ls -la → 工具结果回传闭环
