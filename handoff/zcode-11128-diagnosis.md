# ZCode→Gateway 11128 "Illegal API invocation from an unapproved channel" 只读诊断
（2026-10-17，未修改任何代码/配置）

## 1. TraceID 对应的实际路由链路（已证实）
- TraceID `23a218c9-…` 与 TraceID 字样在 phase3 网关、workbuddycn 扩展、生产 ai-gateway、zcode-proxy 四处日志均不存在 → TraceID 是 **ZCode 客户端本地生成**的请求标识，不是我们链路的。
- 真实路由（events 表重建）：`ZCode → phase3-gateway:18080 /v1/chat/completions → workbuddycn 扩展 → copilot.tencent.com/v2/chat/completions → HTTP 400 {code:11128}`。
- events 表捕获 **3 次** 11128（03:01:06、03:02:01、03:03:51），provider=workbuddycn，account=workbuddycn-3eea4776，api key = `apikey-bf026bda`（名字 **"agent"**，2026-10-16T12:47 创建）。失败与 chat.success 交替出现（03:03:43✓ 47✓ 50✓ 51✗ 54✓ 58✓）——**同账号、相邻秒级窗口内部分请求成功部分失败**。

## 2. "provider=new-provider / provider_code=terminal" 来源（已证实）
- 都不在网关/扩展代码中。`new-provider` 是 **ZCode 客户端里用户添加的自定义 provider 名**；`provider_code=terminal` 是 ZCode 对我们错误体 kind=TERMINAL 的转发（扩展 `errors.terminal` → `UpstreamError(kind:TERMINAL)` → OpenAI error body）。
- 错误消息 `invalid chat request rejected by upstream: code=… msg=…` 确认来自 workbuddycn 扩展的 `sanitizeUpstreamRejection`（chat.ts:184），即**上游原文透传**，非网关生成。

## 3. 11128 的证据支持含义
- 我们与 Gitee（dsh harness）代码中的 11128 注释一致：**"first message is not system prompt"**（渠道/请求形态校验族）。
- 但本次上游文案是 "Illegal API invocation from an **unapproved channel**"——渠道身份校验语义，两者同码不同文案，上游黑盒无法进一步确认适用条件。Gitee 仓库无此文案记录。

## 4. 排除项（全部实测，13 种形态 A/B）
同账号 `workbuddycn::deepseek-v4.1-flash` 经 Core 以下形态**全部 200**：user-first、system 数组、assistant 数组+tool_calls、tool 在首位、user 在 system 前、多条 system、system 居中、assistant-first（→11151 empty content，**不同错误**）、超长 user 无 system、连续 user、name 字段、tools+tool_choice+parallel_tool_calls+stream_options+temperature+top_p 组合、thinking/reasoning_effort/max_tokens、5 路并发流式。
zcode-proxy 日志只有 glm-5.3-flash 200（它跟我们网关无关，ZCode→我们网关的请求不经过它）。

## 5. 最可能根因（推断，待证据确认）
黑盒边界：所有可枚举请求形态都无法复现 11128，且失败/成功在秒级交替。剩余假设按可能性排序：
1. **ZCode 请求携带某种我们未模拟的特征**触发上游渠道校验——最可能是 ZCode 特有的请求体字段（如它的 system prompt 结构、特殊 tools 形态、或非标准参数）。需要 ZCode 侧真实请求体。
2. 上游对同账号 **token+模型+时窗** 的动态风控（黑盒，无法离线复现）。
3. workbuddycn 与 codebuddy 共用 `X-Product-Code: codebuddy` 渠道头——理论冲突但两者目前都正常，证据不足。

## 6. 需要的证据（请提供任一）
- ZCode 的 new-provider 配置（baseUrl + 模型名，脱敏 key）——确认指向 18080 及协议模式；
- ZCode 失败请求的**脱敏请求体**（它的日志/debug 输出）——或同意我在 Core 对 `apikey-bf026bda` 加**一次性临时 debug 日志**（仅记录 messages 的 role/长度/是否含 tools，不含内容），复现一次即可定位。此项需你确认。

## 7. 最小修复方向（待根因确认，未实施）
- 若是请求形态问题：在 workbuddycn 扩展对触发形态做规整（同 1.0.5 的 wire 映射思路）。
- 若是并发/风控：在网关或扩展加同账号请求串行化/重试退避（需评估）。
- 顺带发现（独立小问题）：workbuddycn 扩展缺少 workbuddy 已有的 11128 首条 system guard；且 assistant 消息空 content 会得到 11151 而非本地兜底。可作为加固项。

## 8. 当前状态
只读诊断，零修改。4 账号 active，Core 1.2.8/扩展 healthy，生产 ai-gateway 未触碰。临时验证 key 已全部撤销。
