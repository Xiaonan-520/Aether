# Phase 3 Manual Credit Deployment Report

日期：2026-10-11 ｜ Commit：a8b1463

## 部署记录

| 项 | 值 |
|---|---|
| 镜像 | `local/mpag-phase3:1.2.0`（id e68d988c8bde，build 2026-10-11 18:0x，源 = commit a8b1463） |
| 回滚目标 | `local/mpag-phase3:1.1.9`（id f3e18fe18c88，改动前运行版） |
| 数据卷 | `gateway-extension-phase3_phase3-gateway-data` 未动 |
| Extension | `gw-ext-workbuddycn:1.0.3` 未动（手动接口调用链不需要扩展更新） |
| 部署方式 | 部署源树 compose 钉版 1.2.0 + compose-up.sh（`-p gateway-extension-phase3`） |

## 部署事故与处置（已恢复）

第一次 `compose-up.sh` 实际把容器拉到了 **1.1.6**：脚本的工作目录是 `~/.mpag-p3/src/multi-provider-ai-gateway`（非 src-m0），该树的 compose 钉版为 1.1.6 且本地 1.1.6 镜像是 console 路由之前的旧构建（/api/console 404）。处置：将脚本实际使用的 `src/` 树钉版改为 1.2.0 并重新 `up -d`，容器恢复 1.2.0。**教训：compose-up.sh 的生效源树是 `src/` 而非 `src-m0/`，两棵树都需钉版。**

## 运行时验证（真实账号，全部通过）

| 检查 | 结果 |
|---|---|
| 三容器 healthy、restarts=0 | ✅ |
| /healthz 200、/console/ 200、/api/console/overview 200（15 providers） | ✅ |
| **POST credit-claim**：入队返回 jobId | ✅ |
| **幂等**：手动触发任务最终 `done / skipped: already_attempted_today`，**未再调用上游领取**（todayOutcome 仍是早上 09:41 的 success +100） | ✅ |
| GET credit-claim 历史：含 todayOutcome（success/credit 100/streak 3d） | ✅ |
| /v1/models：29 个（28 前缀 + 1 裸 hy4-preview-f，清库前状态符合预期） | ✅ |
| 真实聊天回归：workbuddycn::deepseek-v4-flash → content OK | ✅ |
| 日志脱敏：gateway/extension 日志 0 处 token/secret/cookie | ✅ |

## 结论

手动 credit 触发接口已在 Phase 3 运行时验证；`already_claimed` 路径确认不会重复领取。生产 `ai-gateway` 全程未触碰。
