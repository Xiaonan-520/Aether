# ZCode 11128 最终诊断（2026-10-17，只读，指纹复现成功）

> **⚠️ 结论已被推翻（2026-10-17 后续）**：本文断言 11128 是“ZCode 内置 system prompt 带客户端身份声明”所致——**错误**。官方 ZCode 源码不含该身份句（见 `zcode-source-investigation.md`）；真实触发物是 git 上下文标签（见 `zcode-11128-root-cause-confirmed.md`）。本文 A/B 实测结果仍有效，但“归因于客户端身份指纹”的结论作废。

## 决定性新证据（真实上游 A/B，1 次成功复现）

| system prompt | 结果 |
|---|---|
| "You are a helpful assistant."（对照） | 200 ✅ |
| **"You are Claude Code, Anthropic's official CLI for Claude."** | **400 code=11128 msg=Illegal API invocation from an unapproved channel** ❌ 与用户错误一字不差 |
| "You are ZCode, a coding agent CLI." | 200 ✅ |
| "You are a coding agent running in ZCode CLI." | 200 ✅ |

## 根因（已证实）
**上游按 system prompt 中的客户端身份指纹识别调用渠道。** ZCode 作为 Anthropic 系编码 CLI，其 system prompt 携带客户端身份声明（具体语句在其内置提示词中），上游的指纹库命中后拒绝整个请求 → 11128。这解释了：
- 失败/成功秒级交替：ZCode 会话中**部分请求的 system 含指纹**（如主对话）而部分不含（如辅助小请求/标题生成）；
- 我们此前 13 种形态 A/B 全部 200——用的都是无指纹的通用 system；
- 同账号 Pi/RikkaHub 正常——它们的 system 无被收录的指纹。

## 三方证据链
1. **workbuddy-openai-proxy**（GitHub，权威）：故障表明确写"`400 Illegal API invocation from an unapproved channel` = 上游识别出了客户端的 system 提示词指纹，v1.2.0 起自动剥离"；其 `src/upstream.mjs` 的 `CLIENT_FINGERPRINTS` 正则库收录了 Claude Code 的身份语句，`stripClientFingerprint` 只剥离命中句、其余保留。
2. **magpie#122**：Claude Code 经 magpie→workbuddy 同样得到 "unapproved channel"（渠道限制），与 11133 明确区分为两类。
3. **dsh harness（Gitee）**：正面处理过同类渠道指纹问题（DSML/指纹归一化独立于 11133）。

## 三种假设的最终判定
- ✅ **system prompt 指纹（成立，已复现）**
- ❌ 客户端附加字段/tool schema：13 种形态 A/B 全 200
- ❌ X-Product-Code 头冲突：headers 相同的请求因 system 内容不同而 200/400 分化，头不是变量

## 下一步选项（待你决策，未实施）
- **A（推荐，合规）**：ZCode 侧关闭/改写其自带的客户端身份声明（若 ZCode 支持自定义 system prompt），或改用上游允许的客户端接入该账号。
- **B（需你明确授权，涉及策略判断）**：在网关/扩展实现同款 `stripClientFingerprint`——只剥离实测命中的指纹语句、其余内容原样保留。⚠️ 这实质是替客户端隐藏身份以通过上游渠道校验，与 magpie#122 提交者"不请求绕过渠道限制"的立场同理，**需要你从合规角度拍板**，我们不会默认实施。
- 顺带加固（独立、无争议）：workbuddycn 扩展补 11128 首条 system guard 与空 content 11151 兜底。

## 当前状态
只读诊断；本轮复现仅消耗 ~15 token；4 账号 active；零代码/配置修改；生产未触碰；临时 key 已撤销。
