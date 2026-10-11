# Provider Extension 化迁移计划 + 手动接口交付计划

日期：2026-10-11 ｜ 状态：执行中

## 0. 基线（已核实）

- Git：main @ 8756991 = origin/main；工作区含持续开发阶段改动（31 文件 +479/-35，未提交）。
- Phase 3：`phase3-gateway`/`phase3-extension-manager` = `local/mpag-phase3:1.1.9`（同镜像 id f3e18fe1…），`gw-ext-workbuddycn` = 1.0.3（digest 9c6027a7…），三容器 healthy、restarts=0，均属 compose 项目 `gateway-extension-phase3`（phase3-gateway/manager 经 labels 确认；extension 经 `gw.managed-by` label + gw-ext-net 成员确认）。生产 `ai-gateway`（ghcr latest）在独立 compose 项目，**禁触**。
- 部署源树：`~/.mpag-p3/src-m0/`（非 git，内容 = HEAD 8756991，app.ts md5 一致）。部署命令：`~/.mpag-p3/compose-up.sh`（`-p gateway-extension-phase3 --env-file phase3.env -f docker-compose.yml -f docker-compose.phase3.yml up -d`）。
- 工作区新代码（未运行）：手动 credit 触发接口（app.ts:301/306 + admin-service.ts:157）、naming.ts 唯一命名源（12 文件引用）、6 Provider 前缀化、exposedOnV1 修复、Console Keys 页、CI 补全。
- 本地镜像链 1.1.0–1.1.9 与扩展 1.0.0–1.0.3 均在本地 docker images（回滚目标）。

## 1. 手动 credit 触发接口完成标准

- POST `/api/accounts/:id/credit-claim`：admin Bearer 认证；账号存在性 + enabled + provider supportsCredits 门控（400/404/409）。
- 入队即返回 jobId（异步），执行结果经 `GET /api/accounts/:id/credit-claim` 查询；幂等由 scheduler-executors"当日已尝试即 skipped"保证。
- 结果映射：success / already_claimed / not_available / needs_auth / needs_manual_action / failed（Core ClaimOutcome 全集，Extension 6 种 ⊆ Core 9 种）。
- 不确定状态原则：上游超时按 TRANSPORT 重试由既有调度退避处理，**不自动重发副作用请求之外的新 claim**（executor 关日机制天然防重复）。
- 测试：console-api.spec 17 个（400 门控/404/历史查询/脱敏）+ extension-remote.spec 4 个 claim 链路 + scheduler.spec 既有幂等用例。全部通过。

## 2. Provider 清单与迁移风险

| Provider | 代码量 | 测试 | 多实例 | 迁移风险 | 批次 |
|---|---|---|---|---|---|
| lobsterai | 972 行 | 2 spec | 否 | 低（无 captcha/HMAC，RFC 指定 PoC） | 1 |
| raccoon | 650 | 1 | 否 | 低 | 1 |
| loomy | 705 | 1 | 否 | 低 | 1 |
| cline | 837 | 2 | 否 | 低-中（双端点模型发现） | 2 |
| trae（trae/trae-intl） | 995 | 1 | 是 | 中（manifest 需两 provider 或两扩展） | 2 |
| codearts | 704 | 1 | 否 | 中（HMAC 签名） | 3 |
| qoder（qoder/qoder-cn） | 1521 | 1 | 是 | 高（WASM 本地卷方案未落地） | 3 |
| zcode | 1582 | 3 | 否 | 高（captcha HTTP 特判 C2，需 Action 通道） | 4/暂缓 |
| buddy 族×4（workbuddy/workbuddy-cn/codebuddy/buddy-intl） | 共享 1188 | 5 spec | 4 实例 | 中（与 workbuddycn Extension 语义重叠，需防产品合并错误） | 3 |

## 3. 统一迁移标准（契约）

复用 `docs/EXTENSION_ARCHITECTURE_RFC.md` + 现有 SDK/协议（PROTOCOL_VERSION、conformance 11 domains、Extension Manager policy `local/gateway-extension-<id>:<version>`）。要点：provider id 稳定不变；凭据只进 Extension 卷；`provider::model` 经 `modelIdOf()`；错误映射经 protocol errors；quota/credit 可选声明；conformance 必过；蓝绿升级保卷。

## 4. 批次流程与检查点

每批（RFC §24.5 顺序）：lobsterai+raccoon+loomy → cline+trae → codearts+buddy族+qoder → zcode（视 C2 进度）。
每批固定流程按任务书 §5.2 17 步执行；每批独立 commit + push；共享改动（若有）先行独立提交。

## 5. Phase 3 部署与回滚

- 构建：`docker build -f Dockerfile -t local/mpag-phase3:1.2.0 .`（Core）；扩展仅当调用链需要时走 Manager upgrade API（本次手动接口不需要，1.0.3 不动）。
- 部署：sed 部署源树 compose 钉版 → `compose-up.sh`；数据卷不动。
- 回滚：改回 `1.1.9` 钉版 + `up -d`（镜像链在本地）。
- 验证：健康、/v1/models、admin 认证、workbuddycn 聊天、手动接口（当日已领→预期 already_claimed/skipped 语义，不重复领取）。

## 6. 停止条件

生产/测试环境无法明确区分；部署需删数据卷；真实账号可能重复领取且无幂等证明；协议重大分歧；测试失败无法定位；远端冲突无法安全快进。
