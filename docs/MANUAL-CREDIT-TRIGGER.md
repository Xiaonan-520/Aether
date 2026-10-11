# Manual Credit Trigger API

> 适用于 Core ≥ 1.2.0（工作区代码；Phase 3 运行中的 1.1.9 尚无此接口）。

## 触发签到（手动）

```
POST /api/accounts/:id/credit-claim
Authorization: Bearer <GATEWAY_ADMIN_TOKEN>
```

- `:id` — 账号 ID（必须存在且 enabled；其 provider 必须声明 `supportsCredits: true`）。
- 请求体：无。
- 行为：**入队**一个 `credit_claim` 调度任务，立即返回 `202`-style JSON（与 `/refresh`、`/quota-sync` 同风格）：

```json
{ "jobId": "…", "accountId": "workbuddycn-…", "jobType": "credit_claim" }
```

实际签到由调度器异步执行；本接口不同步等待上游结果。

### 错误

| 状态 | 条件 |
|---|---|
| 401 | 缺失/错误的 admin token（GATEWAY_API_KEY 不被接受） |
| 404 | 账号不存在 |
| 409 | 账号已禁用 |
| 400 | provider 未声明 supportsCredits |

## 查询签到结果

```
GET /api/accounts/:id/credit-claim
Authorization: Bearer <GATEWAY_ADMIN_TOKEN>
```

返回最近 20 条 `credit_claim` 任务（新→旧）：

```json
{ "claims": [ { "jobId": "…", "status": "done|pending|failed|cancelled|running",
  "scheduledAt": 0, "finishedAt": 0, "error": null,
  "result": { "kind": "success|already_claimed|not_available|needs_auth|needs_manual_action|failed", … },
  "todayOutcome": { "kind": "…" } } ] }
```

- `todayOutcome` 仅出现在最新一条上：当日该账号的最终记录结果（无记录则省略）。
- `result.kind` 语义：`success`（领取成功，含 credit 数）；`already_claimed`（今日已领取，正常态）；`not_available`（活动未开始/无资格，**不算错误也不关日**）；`needs_auth`/`needs_manual_action`（上游认证问题）；`failed`（业务失败）。

## 幂等与不确定状态

- **重复触发安全**：每个 job 经统一调度队列（并发上限 + 退避）；executor 在每日首次真实尝试后关闭当日窗口（`already_attempted_today`），重复入队不会重复调用上游。状态查询 `not_available` 不关日（活动可能稍后开启）。
- **结果不确定**（超时/网络错误）：job 进入既有重试退避；`credit_claim` executor 的关日逻辑保证同日不会因重试而二次领取——重试只发生在**未产生真实尝试**时。
- 上游协议不能区分"领取成功但响应丢失"的场景：此时 executor 视为已尝试并关日，不会重发；次日签到不受影响。这是协议固有限制，不做伪造确定性。

## 审计与脱敏

- `job.enqueued` 事件与 `credit_claims` 表记录结果类型与数量，**不含任何凭据**。
- 错误响应与日志不回显请求头、token 或上游认证信息。
