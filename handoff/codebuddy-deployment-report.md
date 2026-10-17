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

---

## 真实账号验证结果（2026-10-17，人工授权后）

两个产品的人工授权均完成，逐项验证结果（真实上游，非模拟）：

### codebuddy（国内版，账号 codebuddy-bf774c93）
| 项 | 结果 |
|---|---|
| 登录持久化 | ✅ status=active；凭据 AES-GCM 加密存扩展卷（codebuddy-credentials.json.enc），Core 侧零凭据明文 |
| 模型发现 | ✅ **32 个真实模型**（deepseek-v4-flash/pro、glm-5.3、codewise 系列、auto 等） |
| 普通聊天 | ✅ glm-5.3 非流式 200，回复 "ok" |
| 流式响应 | ✅ SSE 20 帧 + [DONE] |
| 签到领取 | ✅ 真实结果 `already_claimed`（当日已签，上游权威状态，无重复请求） |
| 额度查询 | ✅ 诚实 unknown（buddy meter 无可读余额，声明即语义） |

### buddy-intl（国际版，账号 buddy-intl-1dc40a0a）
| 项 | 结果 |
|---|---|
| 登录持久化 | ✅ status=active；凭据独立卷（gw-ext-buddy-intl-state） |
| 模型发现 | ✅ **17 个真实模型**（deepseek-v4-flash、auto-chat、balanced-model 等，与国内版池不同——产品隔离符合预期） |
| 普通聊天 | ✅ glm-5.3 非流式 200 "ok" |
| 流式响应 | ✅ SSE 16 帧 + [DONE] |
| 签到领取 | ✅ 真实结果 `not_available`（国际版当前无进行中的签到活动，honest passthrough） |

### 环境收尾
- 临时验证 key 已撤销；过期的 needs_manual_action 探测账号已清理
- 最终账号：workbuddy ×2（active）+ codebuddy + buddy-intl，全部 active
- 生产 ai-gateway 全程未触碰

---

## Quota 修复（2026-10-17，commit 4c02f02 — 未部署）

### 根因（真实账号只读探测证实）
codebuddy 扩展的 `quotaFor` 按"buddy meter 无可读余额"的错误前提**硬编码返回空快照**。实际探测（真实凭据，脱敏）显示上游 `POST /v2/billing/meter/get-user-resource` 返回腾讯云计量数据：`code:0, data.Response.Data.{TotalCount, TotalDosage, Accounts[]}`，每个 Account 是一个 credit 包（`CapacitySize/Remain/Used`、`CapacityUnit:'credits'`、`CycleEndTime`、`Status`）。

**真实数据**（探测时点）：codebuddy 国内版 11 个包合计 **2900 credits**（1×500 体验包 + 10×100/2000 日签到包，Status=0）；buddy-intl 1 个包 **100 credits**。两产品结构一致、数据不同。

### 修复（共享层，无 Core/Console 特例）
| 层 | 改动 |
|---|---|
| `providers/shared/buddy/meter.ts`（新） | 解析 meter，每个 **Status=0** 的包映射为独立 QuotaResource（remaining/total/used/unit/resetAt 全部上游提供，resetAt=CycleEndTime 显式 +08:00）；过期/解析失败的包**省略不补零** |
| 扩展 manifest | `quotaResources` 从空改为**通配族声明 `pkg-*`**（4 个数值字段全声明） |
| `quota-contract.ts` | 契约校验支持通配族声明（尾缀 `*` 前缀匹配）；通配-only 声明下空快照 = "当前无包"，合法非违规 |
| 扩展 quotaFor | 从 meter 实时读取；带 error/summary 诊断字段；rawJson 经既有链路保留 |

### 测试
- quota-contract +3（通配匹配 / 空=合法 / 类型错误仍标记）→ 13/13
- codebuddy E2E quota 用例按 meter 真实结构重写（双包含 trial、过期包省略、summary）→ 34/34
- Core 全量 **682 passed | 2 skipped**；typecheck / console typecheck 0 error

### 部署需求（等你确认）
| 产物 | 版本 | 说明 |
|---|---|---|
| 扩展镜像 | `local/gateway-extension-codebuddy:1.0.1` + 同镜像 tag `local/gateway-extension-buddy-intl:1.0.1` | manifest 变更 + meter 映射 |
| Core 镜像 | `local/mpag-phase3:1.2.4` | 通配契约校验 |
- 部署顺序：Core 先（1.2.3→1.2.4），两扩展 Manager upgrade（1.0.0→1.0.1，自动重注册）
- 凭据卷不动；workbuddy 两扩展不受影响；升完后 Console 卡片即显示真实余额（ scarcest 包投影 + raw 11 包明细）

### 顺带发现（待修，未在本轮范围）
**扩展凭据加密密钥为默认值**：Manager 注入 `GATEWAY_EXTENSION_TOKEN` 但未注入 `GATEWAY_EXTENSION_SECRET`，扩展回落到 `'dev-only-insecure-secret'`——卷内凭据等于固定密钥加密。建议下轮：Manager 生成 per-extension 随机 secret 注入（凭据需重登录迁移）。已在 handoff 记录。
