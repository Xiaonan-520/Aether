# Provider Extension 化 + 手动 Credit 触发接口 — 最终交付报告

日期：2026-10-11 ｜ 最终 GitHub HEAD：`2b41393`（origin/main 同步）

## 1. 手动触发接口最终状态

- **已实现、已测试、已部署、已运行时验证**。
- `POST/GET /api/accounts/:id/credit-claim`（admin Bearer 认证，supportsCredits 门控，幂等经调度器关日守卫）。
- 文档：`docs/MANUAL-CREDIT-TRIGGER.md`。
- 运行时验证（Phase 3，1.2.0）：入队成功；当日已领状态触发返回 `skipped/already_attempted_today`，**未重复调用上游**；todayOutcome 正确回显早上自动签到的 success/credit 100。
- 测试：14 项场景全覆盖（Core 570→631 passed 全程无回归）。

## 2. Phase 3 实际运行版本

- `phase3-gateway`/`phase3-extension-manager`：`local/mpag-phase3:1.2.0`（commit a8b1463 构建），healthy，restarts=0。
- `gw-ext-workbuddycn`：1.0.3 未动（手动接口调用链不需要扩展更新）。
- 回滚目标：1.1.9（本地镜像保留）。
- 部署事故已处置：compose-up.sh 实际源树是 `src/` 而非 src-m0，首启曾拉到旧 1.1.6，两棵树钉版已对齐 1.2.0。

## 3. 已迁移 Provider 完整名单（批次 1-5）

| Provider | Commit | E2E 测试 | 镜像 |
|---|---|---|---|
| lobsterai（收编既有形态） | 408869a | 13（既有） | — |
| raccoon | 408869a | 13 | raccoon:1.0.0 |
| loomy | f698ebe | 13 | loomy:1.0.0 |
| cline | a110e18 | 14 | cline:1.0.0 |
| trae + trae-intl（单镜像双产品） | 683ffa1 | 9 | trae:1.0.0 |
| codearts | 6d9c441 | 12 | codearts:1.0.0 |

内置注册表：14 实例 → **7 实例**（buddy 族×4、qoder×2、zcode）。

## 4. 未迁移 Provider 及原因

- **buddy 族×4**：需把 workbuddycn Extension 改造成多产品形态（providers[] 多条目 + 凭据存储按 provider 分区），涉及运行中 1.0.3 扩展的结构性升级与存储迁移，需专门授权窗口。
- **qoder×2**：WASM 二进制合规红线（不入镜像），需先落地 RFC §24.7 卷挂载方案。
- **zcode**：captcha 人工交互是 Core HTTP 层特判（服务端渲染 HTML），需先扩展 §16 交互式 Action 协议。属协议演进，非单纯迁移。已确认为唯一保留的 Core Provider 特判。

## 5. 全部 Commit（时间序）

```
a8b1463 feat: complete manual credit trigger, model namespace hardening, console keys page, CI for console/ext
d6aee37 docs: phase3 manual credit deployment report
408869a feat(ext): migrate raccoon provider to an extension (batch 1)
f698ebe feat(ext): migrate loomy provider to an extension (batch 2)
a110e18 feat(ext): migrate cline provider to an extension (batch 3)
683ffa1 feat(ext): migrate trae (both product instances) to an extension (batch 4)
6d9c441 feat(ext): migrate codearts provider to an extension (batch 5)
2b41393 docs: provider migration batch status
```

每批独立可回滚；无 tag 操作；无 force push。

## 6. 测试汇总（最终状态，全部实跑）

- Core：**631 passed | 2 skipped**（49 文件），typecheck 0 error，build OK
- Console：28 passed，typecheck/lint/build 绿
- Extension（workbuddycn）：65 passed + conformance 26 passed
- 新增 Extension E2E：raccoon 13 + loomy 13 + cline 14 + trae 9 + codearts 12 = **61 个**
- CI：verify + console-verify + extension-verify 三 job 全过后才发布镜像（YAML 已验证；Actions 运行状态待 GitHub 页面确认——本地无法查看）

## 7. 架构现状

- Core 保留：路由、账户池、调度、API Key、Manager 生命周期、zcode captcha 特判（唯一，等协议演进）。
- Extension 化 6 个 provider 共享模式：加密凭据库（AES-GCM 卷内）、account-detail 轮询驱动登录状态机、action 通道凭据导入（RFC §10.3）、`provider::model` 命名空间经 `modelIdOf()`、上游只收裸名。
- 原有 in-process provider 代码保留为共享协议模块（extensions 复用纯函数），符合"不删仍在用的公共组件"。

## 8. 已知问题与技术债

1. `exposedOnV1` 修复后 Console 与 /v1/models 一致；但 Phase 3 库内 29 行裸残留仍在（清理方案在 db-cleanup-plan.md，未执行）。
2. Phase 3 数据卷迁移（buddy 族多产品化）需用户授权窗口。
3. GitHub Actions 实际运行结果需在网页确认（本地无法查询 API）。
4. workbuddycn Extension 1.0.3 仍是单产品形态。

## 9. 需要后续决策

1. buddy 族多产品化（批次6）的授权与窗口。
2. qoder WASM 卷方案是否排期。
3. zcode captcha Action 协议演进的排期。
4. Phase 3 裸模型行清理执行窗口（方案已备）。

---

## 批次6：codebuddy + buddy-intl（2026-10-16，commit 7a31c6a）

- **实现**：`src/extensions/codebuddy/`（main.ts + credential-store.ts + Dockerfile）——单镜像双产品（`CODEBUDDY_PRODUCT=codebuddy|buddy-intl`），沿用 TRAE 扩展的成熟模式。协议原语逐字复用 `src/providers/shared/buddy/*`（workbuddy 两个扩展同样依赖），零新增上游行为、零 Core 特例。
- **覆盖面**：external-link 轮询登录（auth/state → auth/token → login/account）、轮换式静默刷新、/v3/config 模型发现、OpenAI 聊天（上游仅 SSE，非流式客户端聚合；11128 前导 system 守卫）、诚实空额度快照（buddy meter 无可读余额，声明 `quotaResources: []` 不伪造）、单次签到领取（先读权威状态）、enable/disable、§10.3 凭据红线（AES-GCM 卷内存储，协议载荷无凭据）。
- **注册表**：内置 5 → **3**（qoder×2 + zcode，带文档化阻塞项）。login-api.spec 更新为迁移后守卫（buddy 族登录 API 不再伪装流程）。
- **测试**：新增 32 E2E（双产品 × 全协议面，含 Core RemoteProvider seam + marker credential）；Core 全量 **677 passed | 2 skipped**；typecheck 0 error；镜像构建并实机验证（built-ins 输出与 intl manifest 产品 id 正确）。
- **未部署**：Core/扩展镜像均为本地构建，本轮按约束未做任何部署/重启。

### 剩余迁移清单（更新后）
| Provider | 阻塞项 | 性质 |
|---|---|---|
| qoder / qoder-cn | 专有 WASM 二进制不入镜像（合规红线） | RFC §24.7 卷挂载方案落地后可迁 |
| zcode | captcha 人工交互是 Core HTTP 层特判（服务端渲染 HTML） | 需 §16 交互式 Action 协议演进 |

两者均为协议演进项，非单纯迁移；共享 buddy 基础设施（`src/providers/shared/buddy/`）保留——三个 buddy 族扩展与内置 qoder/zcode 目录仍被引用。
