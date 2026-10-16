# Credit 查询补全 + WorkBuddy 国际版 Extension 迁移报告

日期：2026-10-16 ｜ Commits `3902bd9`（Core 修复，前批）、`684085f`（本批）已推送

## 任务 1：WorkBuddyCN Credit 查询 —— Core 可用完整链路

### 现状核查结论
架构上链路已存在（Extension `GET /v1/accounts/:id/quota` → Core `ops.getQuota` → scheduler `quota_sync` 任务 → `accounts.quota_json` → Console `/api/console/providers/:id/quotas`），**但有一个真实缺口**：

### 修复（commit 684085f）
- **remote `getQuota()` 丢弃 V1 快照**：之前返回 `rawJson: null`，导致 Console 配额视图显示 `known:false`，即使扩展已报告了权威快照。
- 修复后完整多资源快照（每条资源的 id/kind/remaining/total/unit/status/metadata）保留为 `rawJson` 供 Console 展示；legacy 最稀缺资源投影（known/remaining/total/resetAt）不变。

### 测试（3 个新用例，全过）
1. 快照含资源时 rawJson 保留（解析验证 credits/remaining 字段）
2. 空资源快照（无额度数据场景）→ `known:false` 且 rawJson 为 null（不发明数字）
3. 上游失败 → 异常传播（TRANSPORT），不伪造快照

### 真实运行链路验证（真实数据，非模拟）
- 在运行中的 1.2.1 Core 上执行 `quota-sync` 任务 → 任务 `done`，结果 `{"known":true,"remaining":2757.58}`（扩展从上游 billing meter 实读的真实余额）
- 扩展日志确认 `GET /v1/accounts/.../quota 200`（310ms）
- **注意**：Console 配额视图要显示修复后的 rawJson，需要部署含 684085f 的 Core 镜像（1.2.2，未构建未部署——见交付边界）

## 任务 2：WorkBuddy 国际版 Extension（1.0.0）

### 实现
- 新扩展 `extensions/workbuddy/`，从 workbuddycn 分叉并完整产品参数化：
  - `platform: 'workbuddy-ai'`、`endpoint: https://www.workbuddy.ai`、`productCode: 'workbuddy'`
  - attribution 头（X-IDE-Name/X-IDE-Type/X-IDE-Version）与 UA 家族对齐内置 `WORKBUDDY` 产品定义（`WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2`）
  - 协议路径与 CN 同家族（auth/state、auth/token、chat/completions、billing meter）——与内置 buddy provider 走的同一套 `createBuddyProvider(WORKBUDDY)` 一致
- 独立 extension id `workbuddy`、provider id `workbuddy`；凭据存储/数据卷与 workbuddycn 完全隔离
- 版本 1.0.0（独立版本线）

### 测试（75/75 全过）
- unit 39：含 manifest 校验（id/version/endpoint/domains 断言改为国际版值）
- conformance 26：Extension 协议一致性（account 生命周期、投影、错误契约）
- tool-compat 10：工具调用兼容（与 CN 1.0.4 相同的修复面）
- Core 侧 buddy 测试族（buddy-products/provider/credits/protocol）保障国际版产品常量与协议语义一致性
- Core 全量 **638 passed | 2 skipped**，typecheck 0 error，workbuddycn 无回归

### 镜像
- `local/gateway-extension-workbuddy:1.0.0` 已构建，镜像内验证 `extId=workbuddy, ver=1.0.0, endpoint=www.workbuddy.ai`

## 诚实边界（未验证项 / 阻塞项）

1. **国际版真实上游未验证**：本部署无 workbuddy.ai 账户凭据，无法做真实登录/聊天/额度握手验证。协议面由扩展测试套件 + 内置 buddy 测试族覆盖，但"真实协议握手"未 runtime-verified。**阻塞项：需要一个 workbuddy.ai 账号由你登录**（Console 操作，我不动凭据）。
2. **国际版签到/额度适用性**：billing meter 路径已实现，但国际版是否提供同样的签到活动未验证（无凭据无法确认）。若上游不支持，claim 会诚实返回 `not_available`。
3. **Core 1.2.2 未构建部署**：任务 1 的 rawJson 修复在代码与测试层完成，运行中的 1.2.1 Core 仍是旧行为（Console quota 显示 known:false）。部署需你确认（影响：phase3-gateway/manager 两容器重建，方法同 1.2.1）。
4. workbuddy 扩展**未安装**到 Manager——建议等真实账号可用后再装，避免装了无法登录的空扩展。

## 部署建议（待你决策）
1. 构建 1.2.2 Core 并部署（使 Credit 查询在 Console 完整可见）
2. 提供 workbuddy.ai 账号 → 登录 → 真实验证国际版后，再经 Manager 安装 1.0.0
