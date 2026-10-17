# 批次6部署报告：codebuddy + buddy-intl Extension（2026-10-17）

## 部署版本（实际运行）
| 组件 | 版本 | 状态 |
|---|---|---|
| phase3-gateway / phase3-extension-manager | local/mpag-phase3:1.2.3（重建版，sha256 9db90ee4…） | healthy |
| gw-ext-codebuddy | local/gateway-extension-codebuddy:1.0.0（CODEBUDDY_PRODUCT=codebuddy） | installed+running |
| gw-ext-buddy-intl | local/gateway-extension-buddy-intl:1.0.0（CODEBUDDY_PRODUCT=buddy-intl，同镜像另一tag） | installed+running |
| gw-ext-workbuddy 1.0.2 / gw-ext-workbuddycn 1.0.5 | 未动 | healthy，账号凭据完好（creds=2） |
| 生产 ai-gateway | 未触碰（Up 2 weeks） | healthy |

## 部署中发现并修复的两个问题
1. **Conformance manual-actions 门**：扩展安装时 conformance 要求 ≥1 个声明 action；codebuddy 扩展最初未声明。修复：声明真实的 read-only `checkin-status` action（无副作用、无凭据出口）+ 路由实现 + E2E（commit ea35ad7，34 E2E）。
2. **多实例 env 注入**：intl 实例需要 `CODEBUDDY_PRODUCT=buddy-intl`。Manager 的 operatorEnv 原为硬编码空。修复：`GW_OPERATOR_ENV`（JSON）→ manifest runtime.env 白名单键（commit 61c20b7，Core 679 tests）；compose + phase3.env 已配置。intl 镜像按 Manager 命名规则另打 `local/gateway-extension-buddy-intl:1.0.0` tag（同一镜像）。

## 当前注册状态
- 经 Core：buddy-intl, codebuddy, qoder, qoder-cn, workbuddy, workbuddycn, zcode
- 4 个扩展 installed；workbuddy 账号 2 个 active 未动
- codebuddy / buddy-intl 各有 2 个 `needs_manual_action` 账号（多次 login 探测产生，等待人工授权）

## 待人工授权（当前阻塞点）
- codebuddy（国内版）：`https://copilot.tencent.com/login?platform=ide&state=<state>` — 腾讯账号登录
- buddy-intl（国际版）：`https://www.codebuddy.ai/login?platform=ide-intl&state=<state>` — CodeBuddy 国际账号登录
- 登录 URL 有效期 5 分钟（LOGIN_TTL_MS），过期后经 Core 重新 POST /api/accounts/<provider>/login 获取新链接
- 人工授权完成后：Core 轮询 loginId → 扩展存储凭据 → 账号转 active → 再验证模型/聊天/流式

## 回滚信息
- 部署前 Core/Manager 镜像 id：4d6a5f9462b2（1.2.3 旧版）；扩展镜像 tag 均保留；数据卷零删除
