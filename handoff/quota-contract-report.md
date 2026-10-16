# 声明式 Credit/Quota 架构 — 设计与实现报告（§13.1 契约化）

日期：2026-10-16 ｜ Commit `8572f61` 已推送 ｜ **未部署，等你授权**

## 1. 根因（代码审查确认）

`quotaJson` 里存的是结构化 `QuotaSnapshotV1`（多资源 `resources[]`，扩展协议 §13），但 **Console 的 quota 解析器期望 legacy 扁平字段**（`known/remaining/total/resetAt`）——字段完全对不上 → `known` 恒为 `false` → 主卡片显示 "unknown"，只有展开 raw snapshot 才能看到真实数字。结构化数据没有在哪一层"丢失"，而是**从未被 Console 侧声明和解析**；同时 manifest 层也没有资源语义声明，Core 无法校验快照与 Provider 能力的一致性。

## 2. 设计（复用现有结构，未造新系统）

- **声明层（manifest）**：`ProviderManifestEntry.quotaResources?: QuotaResourceDeclaration[]`——扩展声明自己上报哪些资源（id/kind/unit/displayName）以及上游真实暴露哪些数值字段（remaining/total/used/resetAt 各自可选）。除 id/kind 外全部可选：Provider 能力不同，不要求相同字段；缺失数据保持缺失（绝不伪造 0）。
- **校验层**：`quota-contract.ts` — 快照 vs 声明的一致性检查：
  - 快照出现未声明资源 → `undeclared-resource`（仍渲染但标记，让扩展作者修 manifest）
  - 声明了但快照缺失 → `missing-declared-field`（上游可能合法省略，如实标记）
  - unit 不匹配 / 数值类型错误 → `type-mismatch`
  - **旧扩展无声明 → 兼容**：快照按原样信任 + 一条 `missing-declaration` 备注（明确兼容行为）
- **存储层**：不变（`accounts.quota_json` 存完整 V1 快照，`rawJson` 继续保留供诊断）。
- **展示层**：console-service 解析 V1 快照，经既有的 `quotaSnapshotV1ToLegacy`（最稀缺资源投影，与路由语义一致）得 known/remaining/total/resetAt；完整 resources[] 留在 `raw` 供详情视图。legacy 旧形状向后兼容。
- **不做的事**：不从 raw JSON 猜含义、不把缺失伪装成 0、不写 workbuddy/workbuddycn 硬编码特例——两者各自用 manifest 声明自己的真实字段映射（credits: remaining/total/resetAt）。

## 3. 改动清单

| 文件 | 内容 |
|---|---|
| `src/protocol/extension/accounts.ts` | `QuotaResourceDeclaration` 类型（§13.1） |
| `src/protocol/extension/manifest.ts` | `ProviderManifestEntry.quotaResources?` |
| `src/protocol/extension/validate-manifest.ts` | 声明 strict zod 校验（closed kind 枚举、未知字段拒绝） |
| `src/protocol/extension/quota-contract.ts` | 新：快照一致性校验（5 种 issue severity） |
| `src/protocol/extension/remote-provider.ts` | `getQuota` 逐快照校验（按 provider 自己的声明）；RemoteProvider 接收声明 |
| `src/service/console-service.ts` | **根因修复**：解析 V1 快照 → legacy 投影，legacy 形状回退兼容 |
| 扩展 types + 两个 manifest | 声明类型镜像 + workbuddy/workbuddycn 各自声明 credits 资源 |

## 4. 测试结果

| 套件 | 结果 |
|---|---|
| `tests/quota-contract.spec.ts`（新） | 10/10：完全符合/未声明资源/声明缺失/单位不匹配/类型错误/legacy 无声明/空快照 + manifest 校验 3 例 |
| `tests/console-api.spec.ts`（+4） | 22/22：**V1 真实数据解析修复**（84.15 场景复现）、空资源保持 unknown、多资源最稀缺投影 |
| Core 全量 | **644 passed \| 2 skipped**（50 文件），typecheck 0 error |
| workbuddycn / workbuddy 扩展 | 各 75/75，typecheck 0 error |
| Console | typecheck 0 error，28 tests |

## 5. 构建产物（已构建，**未部署**）

| 产物 | 版本 | 说明 |
|---|---|---|
| Core | `local/mpag-phase3:1.2.3` | 契约校验 + Console 解析修复（镜像内验证） |
| workbuddycn 扩展 | `local/gateway-extension-workbuddycn:1.0.4`（重建） | manifest 加声明 |
| workbuddy 扩展 | `local/gateway-extension-workbuddy:1.0.1`（重建） | manifest 加声明 |

## 6. 部署需求（等你授权）

1. Core 1.2.2 → **1.2.3**（compose 钉版 + up -d，约 30 秒；含升级自动重注册，无手工步骤）
2. 两扩展镜像 rebuild 后 tag 未变但 digest 已更新——Manager upgrade 需要版本号变化，建议 **workbuddy 1.0.1 → 1.0.2、workbuddycn 1.0.4 → 1.0.5**（仅 manifest 声明变更，我可以 bump+重建后一并部署）。或者：也可以选择只升 Core——两扩展的旧 manifest 无声明，走 legacy 兼容路径，Console 照样显示真实数据（兼容行为已测试）。**推荐后者先行**：只升 Core 即可解决"unknown"问题，扩展升级可后续择机。

## 7. 兼容性矩阵

| 扩展版本 | Core 1.2.3 行为 |
|---|---|
| 旧（无声明） | 快照照常显示（legacy 兼容路径），带 missing-declaration 备注 |
| 新（有声明） | 逐快照契约校验，issues 记录，UI 正常渲染 |
| 快照为空/上游失败 | known:false / 保留上次缓存，绝不伪造 0 |

---

## 方案 B 部署记录（2026-10-16，授权后执行）

### 部署顺序（含一次纠错）
1. 扩展 bump：workbuddycn 1.0.4→**1.0.5**、workbuddy 1.0.1→**1.0.2**（manifest 声明），镜像重建并验证（decl: credits）
2. ⚠️ **首次扩展升级被拒**（预期行为）：Manager 1.2.2 的 manifest 校验不认识 `quotaResources` → "Unrecognized key(s)"，且回滚失败（digest mismatch，本地重建镜像无 registry digest）。**教训：契约变更必须先升 Core。**
3. Core+Manager 先升 **1.2.3** → 两扩展再各一次 upgrade 成功（200），自动重注册生效，无 token mismatch
4. 全程无数据/凭据删除；CN 账户凭据保留、账户 active

### 部署后验证（真实数据）
| 项 | 结果 |
|---|---|
| 版本 | Core/Manager **1.2.3**、workbuddycn **1.0.5**、workbuddy **1.0.2**，全部 healthy |
| Console Credit（无需展开 raw） | workbuddy: known=true **84.14** credits（reset 2026-10-31）；workbuddycn: known=true **2543.17** credits —— 主卡片直接可见 |
| rawJson 保留 | 两账户 raw.resources 各 1 行（完整结构供详情视图） |
| 声明式契约 | 两扩展 manifest 携带 quotaResources；镜像内验证 decl=credits |
| 国际版端到端 | glm-5.3 聊天 200 "ok"；流式 26 帧 |
| CN 回归 | deepseek-v4.1-flash 聊天 200 "ok"；升级期间无 chat.fail/token mismatch |
| 临时验证 Key | intl-verify-temp2 / deploy-b-verify 均已撤销 |
| 生产 ai-gateway | Up 2 weeks（未触碰）；扩展日志 0 error |

### 已知现象（非缺陷）
- intl 余额 84.15→84.14：本轮验证聊天消耗，实时数据正常。
- 升级期间 CN 短暂不可用（升级自动重注册窗口约 10 秒），无可观察 chat.fail。
