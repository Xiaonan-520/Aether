# MiniMax Code Extension 实施报告（2026-10-17）

来源调查：`iJetLi/dsh-providers-hub`（Gitee: `iJetLi/deepseek-harness-codearts`，MIT）。
即用户所称 "iJetHub"。17 个 provider 路由中，本 Gateway 已有 11 个，本次新增 MiniMax。

## 为何选 MiniMax 优先

| 候选 | 协议 | 认证 | 可独立接入 | 结论 |
|---|---|---|---|---|
| **minimax/minimaxintl** | **Anthropic Messages** | OAuth 设备码 + PKCE（RFC 8628），Bearer | **是**（无 captcha/WASM/Redis/SMS） | ✅ 已实现 |
| officeace | OpenAI 兼容 | 华为云 OAuth + DPoP + 签名，refresh_token 一次性 | 理论可，凭据复杂 | ⏸ 需华为云账号 |
| accio | 自定义（token 在 body） | 浏览器回调，区域需手工选择 | 理论可 | ⏸ 需真实账号验证 |
| opencode | OpenAI 兼容 | key + IP + 随机会话（匿名通道免费模型） | 理论可 | ⏸ 免费模型价值有限 |
| gemini | Gemini 协议 | 浏览器回调 | 未深入 | ⏸ 协议差异大 |

其余 11 个（codearts/buddy/workbuddy/lobsterai/qoder×2/trae/cline/loomy/raccoon/zcode）Gateway 已有。

## 实现

- `src/providers/minimax/protocol.ts` — 纯函数协议层
- `src/extensions/minimax/main.ts` — Extension 主体（一个镜像双站点）
- `src/extensions/minimax/Dockerfile`
- `tests/minimax-protocol.spec.ts`（20 例）+ `tests/extension-minimax-e2e.spec.ts`（28 例，双站点各跑）

关键协议转换：
- `system`/`developer` → 顶层 `system` 字段（端点拒绝 role:'system' 消息）
- assistant `tool_calls` → `tool_use` 块；`tool` 消息 → user 内 `tool_result` 块
- 孤儿 tool_use / tool_result 直接丢弃（上游 400 两种孤儿）
- 参数 JSON 解析失败 → `{}`，绝不编造
- SSE：`thinking_delta`→reasoning，`signature_delta` **必须丢弃**（是签名不是正文），
  `input_json_delta`→参数分片，`ping` 忽略
- **默认不发 `thinking` 字段**：`disabled` 在 M3.1 上是硬 400，省略则全部接受
- 空帧纪律：只有非空增量才下发；无 payload 的帧不产生 chunk

登录：标准 RFC 8628 设备码 + PKCE S256，无验证码、无短信、无浏览器驱动。

## 部署与验证状态

| 项 | 结果 |
|---|---|
| 镜像 | `local/gateway-extension-minimax:1.0.0`（+ minimaxintl 同镜像 tag） |
| Manager 记录 | `installed` / `running` / `healthy` / `providersRegistered: true` |
| Core 挂载 | reload 后 4 个模型：M2.7 / M2.7-highspeed / M3 / M3.1-Flash-Preview |
| 设备码登录 | **真实上游验证通过**：`POST account.minimax.cn/oauth2/device/code` 返回 201 + 真实授权 URL |
| 推理请求 | **未验证** —— 环境内无 MiniMax 账号，无账号时诚实返回 503 |

## 阻塞与下一步

要完成"真实请求验证"，需要一个 MiniMax 账号：
- 中国版：浏览器打开授权 URL，用国内账号扫码/登录
- 国际版：同流程，`MINIMAX_PRODUCT=minimaxintl` 的容器

登录完成后即可跑通全链路（推理/流式/工具调用），无需改代码。

## 教训登记

1. **conformance 门要求 ≥1 个 action**：首装被 `manual-actions: actions.declared-in-manifest` 拒绝。
   补了只读的 `account-status` action（无副作用）。
2. **install 失败会留下游离容器 + failed 记录**：需 `remove` + 手工删容器再重试；
   `remove` 会保留卷（设计如此）。
3. **install 的 manifest 必须与容器实际服务的 `/manifest` 逐字节一致**：
   旧 manifest（无 actions）会导致 `manifest mismatch`。修改 manifest 代码后必须重新生成。
