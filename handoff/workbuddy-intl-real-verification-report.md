# WorkBuddy 国际版真实验证报告（真实账号、真实上游）

日期：2026-10-16 ｜ Commit `200dabf`（扩展 1.0.1）已推送

## 1. 认证流程（已确认真实可用）

来源：dsh 插件（iJetLi/deepseek-harness-codearts）`buddy-oauth.ts` 真实实现 + 上游实测。

1. `POST {endpoint}/v2/plugin/auth/state?platform=workbuddy-ai`，必须带 4 个免认证头（X-No-Authorization / X-No-User-Id / X-No-Enterprise-Id / X-No-Department-Info）→ 返回 `state` + 官方 `authUrl`
2. 用户浏览器打开官方登录页 `https://www.workbuddy.ai/login?platform=workbuddy-ai&state=<state>` 完成登录
3. 扩展轮询 `GET /v2/plugin/auth/token?state=...`（code 11217=未就绪继续等）
4. `refresh_token` 静默续期，与 CN 同架构

**之前探测 404 的根因**：流程是 POST 不是 GET，且必须带 X-No-* 头。

## 2. 真实验证结果（全部真实上游，非模拟）

| 项 | 结果 |
|---|---|
| 账号激活 | ✅ status=active，displayName=xiaonan-520 |
| 模型列表 | ✅ 25+ 真实模型：gpt-5.6-sol、gpt-5.5、deepseek-v4.1-flash、hy4-preview、grok-4.7、gemini-3.8-flash、fast/balanced/primary 自动路由档等 |
| 普通聊天 | ✅ fast-model / balanced-model / deepseek-v4.1-flash / gpt-5.5 / hy3 均 200（内容正确） |
| 流式聊天 | ✅ SSE chunk 帧正常（含 reasoning/toolCalls 空 delta 帧） |
| 工具调用 | ✅ finishReason=tool_calls；多轮工具结果回填（Workspace 路径）→ 正确最终回复 "The result of 1 + 1 is **2**." |
| Credit 查询 | ✅ 权威快照：remaining=84.15 credits，total=84.15，reset 2026-10-31T15:59:59Z |
| 签到（claim） | ✅ 诚实返回 `not_available`（"check-in activity is not active"）——国际版无进行中签到活动 |

## 3. 真实发现并修复的问题

- **上游要求首条消息必须是 system**：否则 400 code=11128 "first message is not system prompt"（OpenAI 客户端常不发 system）。修复：`buildBody()` 自动注入中性默认 system（1.0.1）。
- **免费账号模型限制**（code=11158 "model [gpt-6.1-sol] is not allowed for user type [personal_free_user]"）：非 bug，上游诚实报错，直接透传。
- hy3 返回空内容但 finish 正常（可能该档位行为如此）——记录观察。

## 4. 安全说明

- 登录会话在隔离实例（端口 19090、临时数据目录 /tmp/wb-intl-data），**未装 Manager、不碰 CN 凭据**
- 会话结束后实例已停止，**临时凭据已随目录删除**——真实 access/refresh token 未落任何持久位置、未进日志/Git/报告
- 用户全程未通过微信发送任何密码/Cookie/Token

## 5. 构建产物（已构建，未部署——等你确认）

| 产物 | 版本 | 状态 |
|---|---|---|
| workbuddy 扩展镜像 | `local/gateway-extension-workbuddy:1.0.1` | ✅ 已构建（1.0.0→1.0.1：system 注入修复） |
| Core 镜像 | `local/mpag-phase3:1.2.2` | ✅ 已构建（含 quota rawJson 修复，镜像内验证 3 处 rawJson 引用） |
| 测试 | 扩展 unit 49 passed；Core 全量 638 passed \| 2 skipped | ✅ |

## 6. 部署方案（等你授权）

1. compose override 钉版 1.2.1→1.2.2 + 同步源码到部署树 → `up -d`（仅 phase3 两容器重建，约 30 秒，方法同 1.2.1）
2. Manager 安装 workbuddy 扩展 1.0.1（凭据需重新登录——临时目录凭据已按安全要求清除，安装后我会重新生成一个登录链接给你，一次即可）
3. 部署后验证：Console Credit 显示（1.2.2 rawJson 修复）、国际版模型出现在 /v1/models、端到端聊天
