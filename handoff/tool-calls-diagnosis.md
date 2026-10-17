# Pi 工具调用故障诊断与修复报告（2026-10-17，commit 85d6f1a — 未部署）

## 现象
Pi Agent 输出 Bash 工具调用（pwd / ls -la / git --version / which flutter dart git curl / uname -a），但没有收到工具结果；再次调用仍无结果；原始记录出现 "DSML" 标记。

## 排查过程（实测证据）

### 1. 强制工具调用复现（经 Gateway 真实链路）
```
非流式: finish_reason='tool_calls'  但 message.tool_calls = null
流式:   19帧中6帧带delta.tool_calls，聚合得 {"command":"pwd"}，finish正确
```
**流式路径完全正常，非流式路径丢失 tool_calls。**

### 2. 故障层定位
- 模型输出：正常标准 tool call（流式证据）；"DSML" 标记是模型把工具调用标记渲染为普通文本的产物，同一缺失往返的另一表象——不是独立的格式故障
- OpenAI 兼容层：**根因所在**——`ChatResult` 类型没有 `toolCalls` 字段
- 聚合链路：上游只说 SSE；非流式时 adapter 把流折叠成 ChatResult，tool_calls 片段在此被丢弃，finish_reason 却保留 → 客户端收到"模型调了工具"但没有任何可执行的调用
- Pi 侧：收到 finish_reason='tool_calls' + 无 tool_calls 的消息 → 无法执行 → 无结果回传 → 下一轮上下文无工具结果 → 反复调用。与症状完全吻合
- Pi 工具注册/Bash 执行器：未涉及（请求根本没到达执行器）

### 3. 修复（全链路，无 Provider 特例）
| 层 | 改动 |
|---|---|
| `core/types.ts` | `ChatResult.toolCalls` 字段 |
| `protocol/openai/serialize.ts` | 非流式 message 输出标准 OpenAI tool_calls |
| `providers/shared/buddy/provider.ts` | aggregate 折叠索引式片段（带 id 开新调用，无 id 续接 arguments）|
| workbuddy/workbuddycn 扩展 | chatNonStreaming 已收集 toolMap 但从未返回——补上；协议类型镜像 |
| codebuddy 扩展 | 非流式路由同样折叠 |

流式路径验证已正确，未改动。

### 4. 版本与镜像（已构建，未部署）
| 产物 | 版本 |
|---|---|
| Core | `local/mpag-phase3:1.2.6` |
| workbuddy / workbuddycn | 1.0.3 / 1.0.6 |
| codebuddy / buddy-intl | 1.0.2（同镜像双 tag）|

### 5. 测试
- serialize 往返 +2；codebuddy E2E 非流式折叠 +2（36/36）；workbuddy 两扩展各 75/75
- Core 全量 **689 passed | 2 skipped**；typecheck 全绿

## 部署需求（等你确认）
顺序：Core 1.2.5→1.2.6 → 四扩展 Manager upgrade（自动重注册，凭据卷不动）→ Pi 端无需改动，下一轮请求即恢复工具执行与结果回传。

## 需要你确认的事项
- Pi 侧使用的请求格式（stream=true/false）——修复后两条路径均正常，但如果 Pi 有本地工具调用解析逻辑（如 DSML 文本解析），建议升级后观察一轮再清理

---

## 1.2.6 部署记录（2026-10-17，授权后执行）

### 部署版本（实测运行）
| 组件 | 版本 | 状态 |
|---|---|---|
| Core / Manager | 1.2.5 → **1.2.6** | healthy |
| workbuddy | 1.0.2 → **1.0.3** | healthy，upgrade 200 自动重注册 |
| workbuddycn | 1.0.5 → **1.0.6** | healthy，upgrade 200 |
| codebuddy | 1.0.1 → **1.0.2** | installed+running |
| buddy-intl | 1.0.1 → **1.0.2** | installed+running |
| 生产 ai-gateway | 未触碰 | Up 2 weeks |

全程 0 token mismatch / chat.fail；4 账号全部 active；凭据卷未动。

### 流式最小验证（真实上游，临时 key 已撤销）
1. **流式普通聊天**（workbuddy::glm-5.3）→ 200，8 帧 + [DONE]
2. **流式工具调用** → finish=tool_calls，**id=`call_1f09dd2c…`、name=bash、arguments=`{"command": "pwd"}` 完整**
3. **工具结果回传 → 最终回答** → 200："The result of running `pwd` is: /home/xiaonan/agent-workspace …"——完整闭环 ✅

### 回归
- Quota：4 provider 全部 known:true（84.02 / 2416.69 / 500 / 100）
- codebuddy 流式抽查 200 + [DONE]
- 非流式路径按授权不再扩大线上测试（E2E 36/36 已覆盖）
- 部署日志 0 error/fail

**状态：等待用户 Pi 端真实使用验证。不再进行其他操作。**
