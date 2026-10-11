# UI Agent 阶段交付审计报告 — Core Web 管理控制台

> **审计对象**：`multi-provider-ai-gateway` 仓库 `main` 分支（HEAD `f85e341`，tag `v0.2.0-phase3` 未移动）的工作区未提交改动。
> **审计时间**：2026-10-11（当日两次执行：初次审计 + 交付前复核，全部命令与结果当场重新运行验证）。
> **审计方式**：只读审计。`git status` / `git diff` 逐文件核对归属；本地复跑 `tsc` / `vitest` / `eslint` / `vite build` / `npm run build`；此前一阶段曾用 playwright-cli 对真实运行网关做浏览器验证（该验证的截图与快照属当次会话产物，本报告仅保留其文字结论，原始快照文件位于 `.playwright-cli/`，已被 `.gitignore` 忽略）。
> **操作边界**：未修改任何业务/UI/Docker 文件，未提交 Git，未重启服务，未触碰生产 `ai-gateway`，未读取或输出任何真实 token / cookie / 凭据。

---

## 0. 一句话结论

Console UI 第一阶段**已交付且全部验证通过**：前端控制台（`console/`，shadcn base-nova + Base UI + Tailwind v4 + Motion 14）+ Core 侧 console 聚合 API + 手动 Scheduler 任务触发端点 + 网关静态托管 `/console`；后端 497 测试、前端 23 测试、双方 typecheck/lint/build 全绿。浏览器实测中发现并修复了 StartLogin 字段格式不匹配与 vite 8 `base` 配置位置两个真实 bug。**主要缺口在 Extension 架构对齐**：UI 以 Provider 为一等实体、Core 无 Manager 代理端点、无 Extension 生命周期管理入口 —— 详见第二节差距分析与第三节 A/B/C 任务清单。

---

## 1. Git 工作区状态与改动归属（已核实）

分支 `main`，HEAD `f85e341`（`chore(compose): pin phase3 stack to core image 1.1.6`）。Phase 3 提交 `0521d69`、`f85e341` 与 tag `v0.2.0-phase3` 均未受影响。

### 1.1 本阶段（UI Agent）改动 — 6 个已跟踪文件修改 + 3 个新增路径

| 文件 | 改动内容（diff 已逐行核对） |
|---|---|
| `src/http/app.ts` (+45) | import `serveStatic`/`existsSync`/`join`/`ConsoleService`；新增 4 个 console 聚合路由、2 个手动任务触发路由、`/console` 静态托管（`existsSync` 守卫 + `/console` → `/console/` 重定向） |
| `src/http/index.ts` | `Scheduler` 构建提前到 `ctx` 之前并注入 `ctx.scheduler`（`registerSchedulerExecutors` 调用随迁，逻辑未变） |
| `src/service/context.ts` | `ServiceContext` 增加 `scheduler: Scheduler` 字段（含注释：后台任务队列，手动触发必须经它入队） |
| `src/service/admin-service.ts` (+22) | `enqueueAccountJob(ctx, accountId, 'token_refresh' \| 'quota_sync')`：校验账号存在 + disabled 返回 409，经 `ctx.scheduler.enqueue` 入队，写 `job.enqueued` 审计事件 |
| `src/service/scheduler-executors.ts` (+9) | `credit_claim` 成功写 `claim.success` 事件；非 `not_available`/`already_claimed`/`needs_manual_action` 的失败写 `claim.failed` 事件（console 今日领取统计的数据源） |
| `package.json` (+5 脚本) | `console:dev` / `console:build` / `console:typecheck` / `console:test` / `console:lint`（全部 `--prefix console` 委托） |
| `src/service/console-service.ts`（新增，~235 行） | `ConsoleService`：`getOverview()`（totals + 每 Provider 的账号/模型/配额/领取汇总）、`listProviderModels()`（含 `exposedOnV1`）、`listProviderQuotas()`（`known`/`remaining`/`raw`，unknown ≠ 0）、`listProviderClaims()`；未知 provider 抛 404 |
| `tests/console-api.spec.ts`（新增，11 个测试） | 鉴权（401）、overview 聚合与凭据脱敏断言、models/quotas/claims 形状、手动触发入队 / 404 / 409 |
| `console/`（新增目录，~2261 行 TS/TSX） | Vite + React 19 + Tailwind v4 + shadcn(base-nova/Base UI) + Motion 14 前端，独立 `package.json` |
| `dist-console/`（新增，构建产物，708K） | `vite build` 输出，被 `src/http/app.ts` 的 `/console` 路由托管 |

### 1.2 其他 Agent 的文件 — 未触碰，保持原状

以下 untracked 文件非本阶段产出，审计期间**未做任何修改、覆盖或清理**：
`TASK8-PLAN-UI-FINAL-REPORT.md`、`TASK9-SOLPI-PLAN-TAB-FINAL-REPORT.md`、`api_additions.ts`、`api_send.ts`、`blog_edit_page.tsx`、`blog_editor.tsx`、`blog_module.py`、`blog_module_v2.py`、`blog_page.tsx`、`blog_types.ts`、`blog_types_v2.ts`、`host_watchdog.py`、`main_v2.py`、`marked.ts`、`screenshots/`、`scripts/wx-notify.mjs`（该项在交付复核时新出现，归属其他流程，同样未触碰）。

---

## 2. 验证结果（已执行，真实数字）

### 2.1 后端
- `npm run typecheck`（`tsc -p tsconfig.json --noEmit`）：**通过**。
- `npm run test`（vitest，node 环境）：**40 个测试文件，497 passed + 2 skipped（共 499）**，其中包含新增的 `tests/console-api.spec.ts` 11 个测试。执行时间 ~6s。
- `npm run build`（`tsc` + `copy-assets.mjs`）：**通过**。

### 2.2 前端（`console/`）
- `npm run typecheck`（`tsc -p tsconfig.app.json --noEmit`）：**通过**（0 错误）。
- `npm run lint`（eslint，含 react-hooks 严格规则）：**0 错误 0 警告**。
- `npm run test`（vitest + happy-dom，`console/vitest.config.ts`）：**3 个文件，23 passed**（`src/lib/router.spec.ts` 8 项、`src/lib/status.spec.ts` 10 项、`src/lib/api.spec.ts` 5 项）。
- `npm run build`（vite 8）：**通过**（~700ms；产物 `dist-console/assets/index-*.js` gzip ~174KB，有 >500KB chunk 警告，见 C 类优化项）。

### 2.3 浏览器验证（前一阶段执行，文字结论保留）
用 playwright-cli 对真实运行网关（dev 环境，独立 `DATA_DIR`，非生产）验证：
- TokenGate 输入 admin token → 解锁 → 首页正确渲染 registry 驱动的 14 个 Provider 卡（协议驱动确认，无硬编码）。
- Provider 详情页 4 个 tab（Accounts / Models / Credits-Quota / Auto claim）均正确渲染空态与真实数据态。
- StartLogin 对话框对真实 provider（workbuddy）返回并展示真实 `authorization_url`，进入轮询等待态。
- 「Enqueue token refresh」按钮在 Core `/api/jobs?type=token_refresh` 产生真实 pending job；「Remove」后 Core 侧账号数 3→2。
- 深色/浅色主题、桌面（1280px）与移动（390px）布局均正常。
- 交付复核阶段另验证了网关静态托管：`GET /console/` 200、HTML/CSS/JS 资产 200、`/api/*` 仍 401（鉴权未被静态托管削弱）。

---

## 3. Console API 认证边界与敏感信息检查（已验证）

- `/api/*` 统一 admin bearer 中间件（`src/http/app.ts:78`，constant-time 比较）。**新增的 6 个端点（4 个 console 聚合 + 2 个手动触发）全部注册在该中间件之后**，测试覆盖：无 token 401、用 `GATEWAY_API_KEY` 冒用 admin 401。
- 手动触发走 Scheduler 队列（retry/concurrency/idempotency 归 Scheduler 所有），console **绝不直接调用 adapter**；disabled 账号返回 409 且不入队（有测试）。
- 出口数据脱敏：`tests/console-api.spec.ts` 断言 overview 响应不含 `credentialKey` / `CRED_` 字符串；Manager token / Extension token 从未出现在任何 console 响应或前端代码中（grep 核实 `console/src` 无 `extension-manager` / `/api/extensions` 引用）。
- **浏览器从不直接访问 Manager 或 Extension 容器接口** —— `console/src/lib/api.ts` 仅请求 Core `/api/*`。✅ 架构边界正确。
- 风险（已知并接受）：`/console` 静态 HTML 无鉴权（HTML 本身无秘密，数据安全完全依赖 `/api/*` bearer + sessionStorage token）；生产部署建议反代层加访问控制或网络隔离。

---

## 4. 构建与忽略规则发现（已验证的事实）

1. **`dist-console/` 未被 `.gitignore` 覆盖**：根 `.gitignore` 只有 `dist/`，而 `dist-console/` 当前是 untracked 构建产物 —— 有被误提交的风险。
2. **Dockerfile 未集成 console 构建**：`Dockerfile` 只 `COPY src` + `npm run build`（第 11–17 行），产物仅 `dist/`；生产镜像内没有 `dist-console`，`/console` 路由因 `existsSync` 守卫会静默跳过（不报错但功能缺失）。`docker-compose*.yml` 亦无 console 相关配置。
3. **vite 8 的 `base` 必须放顶层**（`console/vite.config.ts`）：放 `build.base` 会被静默忽略导致资产路径 404 —— 已修复为顶层 `base: "/console/"`，这是踩坑记录，后续改动配置时勿回退。
4. 小问题：`console/public/vite.svg` 存在但 `console/index.html` 未引用 favicon → 浏览器控制台一个无害 404。
5. 根 `package.json` 已有 5 个 `console:*` 脚本；`console/node_modules` 被根 `node_modules/` 忽略规则覆盖（安全）。

---

## 5. 架构差距分析（对照最终目标：Core 通用化 + Extension 化 Provider + UI 统一管理入口）

### 5.1 Provider 首页 ↔ Extension 实体的关系（已核实）
首页 Provider 卡 = **运行时已注册的 Provider**（in-process 14 个 + 已注册的 remote provider），**不是 Extension 列表**。remote provider 由 Core 启动时经 `registerRemoteExtensions`（`src/http/remote-bootstrap.ts`）从 Manager 拉 `/api/extensions/available` + `/registration` 挂载，之后与普通 Provider 无异 —— **Extension 身份在注册后对 console 不可见**。推论：一个 Extension 暴露 N 个 Provider 会显示 N 张卡；未安装/启动失败的 Extension 的 Provider 完全不出现。**这是最大的概念性差距。**

### 5.2 Extension 管理 API 现状（已核实 Manager 侧）
`src/manager/api.ts` 已有：`GET /api/extensions`、`GET /api/extensions/available`、`POST /api/extensions/install`、`GET /api/extensions/:id`、`POST /api/extensions/:id/stop|restart|remove`、`GET /api/extensions/:id/registration`（含 extension token，manager-internal only）。
**缺失**：upgrade（升级）、rollback（回滚；`InstallRecord.imageDigest` 字段已存在可支撑）、运行时健康查询（仅容器 liveness `/healthz` root）、生命周期状态的运行时刷新。
`InstallRecord`（`src/manager/store.ts:20`）含 `extensionId/version/imageRepo/imageTag/imageDigest/containerId/endpointUrl/status/error/manifestHash/tokenFingerprint/installedAt/updatedAt`；`ExtensionStatus` 为 10 态生命周期（`pending→validating→pulling→starting→health_check→conformance→registering→installed`，加 `failed/removing`），失败记录**故意保留**（`src/manager/extension-manager.ts:345` 附近注释）—— 数据层已具备失败展示与回滚追溯条件。

### 5.3 Manager vs Core 职责边界（已核实）
服务端边界清晰：Manager loopback-only / 永不暴露公网 / 1:1 动词映射 / 无 Docker passthrough（`src/manager/api.ts` 头注释与实现一致）。**但 Core 没有任何 Manager 代理端点** —— 浏览器与 Manager 之间无桥。按最终目标（UI 是统一管理入口），需要 **Core 侧持 manager token 的服务端代理**（建议 `GET/POST /api/extensions/*` 白名单转发），浏览器只持 admin token。下一阶段必须保持「manager token 不下发浏览器」。

### 5.4 安装/升级失败展示（已核实：数据层就绪，UI/桥接层缺失）
`GET /api/extensions/:id` 可取回 `status='failed'` + `error` 原文。缺口全在前端：无 Extensions 页面、无状态轮询、无失败恢复（remove/reinstall）交互。

### 5.5 概念混淆风险（审计确认存在，需在下一阶段 UI 设计中规避）
- **Provider 数 ≠ Extension 数**：首页「Providers: 14」会被误读为 14 个扩展；实际可能 0 个 Extension。
- **安装状态 ≠ 健康状态**：`status='installed'` 是安装时刻的状态，之后容器崩溃不会反映在列表中（Core registry 仍持有失联的 remote provider，直到请求失败才暴露）。UI 必须区分三态：**已安装（Manager 记录）/ 已注册到 Core（registry 挂载）/ 运行时可达（健康探针）**。

---

## 6. 建议任务清单（均为**建议**，除 A 类两项已在本阶段顺手完成外，其余尚未落实）

> 标注说明：【已完成】= 本阶段已实现并测试；【建议】= 仅审计建议，未实现。

### A. 必须先完成（安全 / 构建 / 数据正确性）
| # | 事项 | 文件 | 验收标准 | 状态 |
|---|---|---|---|---|
| A1 | `.gitignore` 增加 `dist-console/` | `.gitignore` | `git status` 不再出现 dist-console | 【建议】 |
| A2 | Dockerfile 集成 console 构建（COPY console/ + `npm run console:build`，产物入运行镜像） | `Dockerfile` | 镜像内 `GET /console/` 200 | 【建议】 |
| A3 | `/console` 静态托管补安全响应头（`X-Content-Type-Options`、CSP `connect-src 'self'`） | `src/http/app.ts` | curl -I 可见；不破坏功能 | 【建议】 |
| A4 | favicon 修复（引用或删除 `console/public/vite.svg`） | `console/index.html` | 控制台 0 资源错误 | 【建议】 |
| A5 | TokenGate 401 后清空 sessionStorage 残留 + token 格式提示 | `console/src/console-app.tsx` | 输错 token 不留死会话 | 【建议】 |

### B. Extension 管理 UI 下一阶段
| # | 事项 | 依赖 | 验收标准 | 状态 |
|---|---|---|---|---|
| B1 | **Core 扩展代理服务**：`/api/extensions(/*)` 服务端持 `GATEWAY_EXTENSION_MANAGER_URL/TOKEN` 白名单转发（list/get/install/stop/restart/remove），manager token 永不下发浏览器 | Manager API 已就绪 | 浏览器仅凭 admin token 完成 Extension 全生命周期操作；任何响应不含 manager token | 【建议】 |
| B2 | **数据模型解耦**：overview 增加 `extensions` 维度（extensionId/version/status/error/providers[] 归属）；首页改 Extension 分组视图，Provider 卡归组；内置 Provider 标注 core-built-in | B1 + `src/protocol/extension/remote-provider.ts` 回传 extensionId | 一个 Extension 多 Provider 时分组正确 | 【建议】 |
| B3 | **Extensions 管理页**（`#/extensions`）：列表（含 failed+error 原文）、详情（version/digest/endpoint）、安装（manifest/image）、stop/restart/remove（二次确认 + 审计事件） | B1 | 对真实 Extension 完成 remove→install UI 全流程；失败安装显示 `InstallRecord.error` | 【建议】 |
| B4 | **升级/回滚**：Manager 增加 `upgrade`（同 extensionId 新 image）与 `rollback`（按 imageDigest）；UI 入口 | B3 | 升级失败保留旧记录可回滚；UI 展示两态 | 【建议】 |
| B5 | **运行时健康探针**：Core 周期探测已注册 remote provider（scheduler job），overview 标注 reachable/unreachable | B2 | 容器被杀后 ≤60s UI 变红；探针低频 + 缓存 | 【建议】 |

### C. 后续优化
- 【建议】组件测试：`@testing-library/react` 已安装于 `console/`（未使用），补 TokenGate / ProviderCard / AccountsSection 渲染测试。
- 【建议】可访问性：部分表格操作按钮仅有图标（如「Q」quota-sync 按钮）缺 `aria-label`；toast 错误可加 `aria-live`。
- 【建议】性能：主 chunk 548KB（gzip 174KB）超 vite 500KB 警告；对 `provider-page.tsx` 做路由级 `React.lazy` 分割即可。
- 【建议】动画：现有入场 fade-stagger；可加 tab 切换 Motion `layoutId` 过渡（保持 `MotionConfig reducedMotion="user"`）。
- 【建议】首页过期检测（`STALE_AFTER_MS=90_000`）只看本地时钟，可加与 `generatedAt` 的服务端时钟偏差检测。

### 本阶段已顺手完成但曾列为建议的事项（供对账）
- StartLogin wire-format 修复（Core 返回 snake_case `login_id`/`authorization_url`/`status: pending|success|error`，前端原按 camelCase 解析导致授权链接不显示）—— 已修复于 `console/src/lib/api.ts`（`BeginLoginResult`/`PollLoginResult` 类型）与 `console/src/pages/provider-page.tsx`（`StartLogin` 组件），并经浏览器实测。
- vite `base` 修复 —— `console/vite.config.ts` 顶层 `base: "/console/"`。

---

## 7. 未完成事项、风险与审计结论

### 7.1 尚未完成（下一阶段范围）
1. Extension 管理功能整体（B1–B5）—— 本阶段按约定只做 Core UI + 必要 Core API，未触碰 Manager / Extension 逻辑。
2. A 类全部 5 项（除上述两个顺手修复外）。
3. C 类全部。
4. 前端组件级测试（当前仅覆盖逻辑层：router / status / api client）。

### 7.2 风险登记
| 风险 | 等级 | 缓解建议 |
|---|---|---|
| `/console` HTML 无鉴权，任何能访问网关端口者可打开页面 | 中 | 生产反代加访问控制/网络隔离；数据安全依赖 `/api/*` bearer |
| `dist-console/` 未忽略，可能误提交 | 低 | A1 |
| 生产镜像无 console（Dockerfile 未集成） | 低（当前 /console 静默 404，不报错） | A2 |
| Manager token 若经未来代理实现泄漏到浏览器 = 全权 Docker 控制 | 高（若发生） | B1 必须白名单转发 + 响应过滤 + 测试断言 |
| Core registry 持有失联 remote provider，请求才暴露失败 | 中 | B5 健康探针 |
| `GATEWAY_ADMIN_TOKEN` 若为弱值且端口暴露 = 全权管理 | 高（若发生） | 强制长随机 token（`.env.example` 已提示） |

### 7.3 审计结论
本阶段交付**真实、可验证、边界干净**：所有声明均有测试或浏览器实测支撑；未覆盖其他 Agent 工作；未触碰生产基础设施。协议驱动（零 Provider 硬编码）与诚实状态语义（unknown ≠ 0、logged-in ≠ available、claim enabled ≠ succeeded）经代码 grep 与测试双重确认。**建议 Core Agent 直接复用** `console/` 前端骨架、`src/service/console-service.ts` 聚合模式、`enqueueAccountJob` 的 Scheduler 归属模式，作为 Extension 管理 UI（B1–B3）的实现基座，避免重新实现。

---

*报告人：UI Agent（ZCode / pi harness）· 审计执行于共享工作区 `/home/xiaonan/multi-provider-ai-gateway` · 本报告本身为唯一新增文件，未做其他任何修改。*
