# Manual Credit Trigger Report

日期：2026-10-11

## 代码测试（已完成，全部实跑）

- Core 全量：**570 passed | 2 skipped**（44 文件），typecheck 0 error，build OK。
- 手动接口覆盖（console-api.spec 19 passed）：
  - admin 认证缺失 401、GATEWAY_API_KEY 不能当 admin 用（权限隔离）
  - 账号 404、禁用 409、provider 无 supportsCredits 400
  - 入队返回 jobId/jobType、重复点击产生独立队列任务（幂等交给 executor 关日守卫）
  - GET 历史只读、无敏感字段
- 调用链幂等（buddy-credits.spec 既有 + 保留）：真实上游调用仅 1 次/日，手动重入队被 `already_attempted_today` 跳过。
- RemoteProvider claim 链路（extension-remote.spec 4 个）：成功透传、already_claimed/not_available/needs_auth 映射、协议错误→UpstreamError、quota 归一化。
- 上游 401/403→needs_auth/needs_manual_action（buddy-credits.spec）。

任务书 §1.4 的 14 项场景对照：1✅(buddy-credits success) 2✅ 3✅ 4✅(POST 400 门控即无效 provider；ID 格式由路径参数天然约束) 5✅(404) 6✅(400) 7✅(401×2) 8✅(needs_auth) 9✅(extension-remote AUTH_INVALID→UpstreamError) 10✅(调度退避+关日，见 docs/MANUAL-CREDIT-TRIGGER.md 不确定状态节) 11✅(重复入队测试) 12✅(调度器 maxConcurrent=4 队列化，重复执行被关日守卫挡住) 13✅(响应/事件无凭据断言) 14✅(buddy-credits "does not claim twice")。

## 运行时测试（未执行）

Phase 3 运行版本为 1.1.9（无此接口，实测 404）。接口运行时验证依赖阶段 2 部署。
