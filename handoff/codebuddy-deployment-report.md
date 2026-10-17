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

---

## developer role 修复（2026-10-17，commit 4dec778 — 未部署）

### 根因
Pi Agent（GPT-5 系客户端）发送 `role: "developer"` 指令消息。Gateway 的 OpenAI 解析层（`src/protocol/openai/parse.ts`）role 枚举只接受 `system|user|assistant|tool`，请求在 zod 校验即 400（`messages.0.role: Invalid enum value`）——**在路由前就失败**，与 WorkBuddy/CodeBuddy 扩展无关（证据：错误消息格式与 parse 层 zod 输出一致；扩展侧从不接收该请求）。

### 修复（解析层一处，所有 Provider 受益）
- schema 接受 `developer`；`toCanonicalMessage` 将其归一为 `system`——内容、顺序、name 保留
- **不做**去重、**不把**已有 system 改写；多指令消息本就合法（buddy 族 11128 守卫只在首条非 system 时插入默认）
- 扩展侧零改动：Core 归一后到达扩展的必为 canonical role；workbuddy/workbuddycn/codebuddy 共用该修复

### 验证
- 回归 3 个新用例：裸 developer、system+developer 共存（多轮+工具调用，顺序保持）、工具调用链完整 → protocol-openai 10/10
- 隔离实机验证：developer 请求通过解析层进入路由（无扩展实例报 model not found 而非 400 枚举）——原 400 消失
- Core 全量 **685 passed | 2 skipped**；typecheck 0 error

### 部署需求（等你确认）
- Core 镜像 `local/mpag-phase3:1.2.5`（仅解析层，扩展镜像无变化）
- 部署即生效，Pi Agent 的 developer role 请求直接恢复

### 待办确认
上一轮 Quota 修复（Core 1.2.4 + 扩展 1.0.1）**已部署并实机验证通过**（codebuddy 11 包 2900 credits / buddy-intl 1 包 100 credits，Console known:true）；若与本次 1.2.5 一起部署，直接 1.2.4→1.2.5 替换即可。

---

## 1.2.5 部署记录（2026-10-17，developer role 修复上线）

- Core/Manager 1.2.4 → **1.2.5**（扩展容器未动：codebuddy/buddy-intl 1.0.1、workbuddy 1.0.2、workbuddycn 1.0.5）
- 端到端实测（真实上游，临时 key 已撤销）：
  - 裸 developer（workbuddy）→ 200 "ok"
  - system+developer 混合（codebuddy）→ 200 "ok"
  - developer + 多轮 + 工具调用（workbuddy）→ 200 "2 + 3 = **5**"
  - developer + 流式 → 200，59 帧 SSE + [DONE]
- Quota 回归：4 provider 全部 known:true（workbuddy 84.1 / workbuddycn 2475.22 / codebuddy 500·11包 / buddy-intl 100）
- 生产 ai-gateway 未触碰

---

## developer-role 现状核对（2026-10-17，只读，未部署）

| 端点 | 容器 / 镜像 | 构建时间 | 含 developer-role 修复？ |
|---|---|---|---|
| `:8080` | `ai-gateway` / `ghcr.io/xiaonan-520/multi-provider-ai-gateway:latest` | 2026-10-02 | **否** |
| `:18080` | `phase3-gateway` / `local/mpag-phase3:1.2.8` | 2026-10-17 | **是**（1.2.5 起） |

证据：
- `docker inspect` → `ai-gateway` 容器创建于 2026-10-02T03:51，镜像 label `org.opencontainers.image.revision=e796d608…`（2026-10-02 提交）。
- `git merge-base --is-ancestor 4dec778 e796d608` → **不是祖先**，即旧镜像内**不含**该修复。
- 修复提交：`4dec778`（fix(openai): normalize the 'developer' role to 'system' at the parse layer），
  代码位置 `src/protocol/openai/parse.ts:61`（schema 接受 developer）与 `:123`（归一为 system）。
- 首次随镜像上线：`local/mpag-phase3:1.2.5`；后续 1.2.6 / 1.2.8 均继承。

客户端实际使用情况（来自 Pi 会话记录，只读）：

| 客户端 | 端点 | 是否受 developer-role 影响 |
|---|---|---|
| 当前 Pi 会话 | `multiple-provider-ai-gateway` → 18080 | 否（修复已上线，实测正常） |
| 旧 Pi 会话 | `multiple-ai-gateway` → 8080（2026-10-17 04:25:30 使用） | 是（当日仍在 8080 上产生该 400） |

是否仍影响真实请求：
- **是，仍可能影响**——只要还有客户端把 baseUrl 指向 `:8080`。旧 Pi 会话 2026-10-17T04:25:30Z
  的失败记录 `messages.0.role: Invalid enum value … received 'developer'` 就是真实请求证据。
- 但这是**独立问题**，与 11128 / 11148 **无因果关系**：前者是解析层 zod 校验，后者是上游渠道指纹/工具配对被拒。
  修复方式也不同（升级镜像 vs 无需网关改动）。

未确认项：
- 除 Pi 之外（RikkaHub 等）是否仍指向 8080：**未取得证据**，不下结论。
- 生产 8080 上 `ai-gateway` 的其它历史缺陷清单未做全量重核（仅确认 developer-role 缺失）。

结论：`8080` 仍跑 2026-10-02 旧镜像，**未含** developer-role 修复；`18080`（1.2.8）已含。
是否把生产升级到 1.2.8 属独立决策，本轮**未执行**。
