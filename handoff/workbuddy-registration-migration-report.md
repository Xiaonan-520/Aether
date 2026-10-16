# workbuddy / workbuddy-cn 注册架构迁移完成报告

日期：2026-10-16 ｜ Commit `9dc8d7c` 已推送 ｜ Core 镜像 `local/mpag-phase3:1.2.2`（已重建，未部署）

## 1. 注册架构现状（标准机制，无自造）

两版 WorkBuddy 均走**同一套标准 Extension/Manager 注册流程**：

```
启动/reload/升级成功 → registerRemoteExtensions(ctx, endpoint)
  → GET manager /api/extensions/available（installed 过滤）
  → GET /api/extensions/:id/registration（manifest + endpointUrl + token）
  → buildRemoteProviders() → registry.replace(provider)（幂等，防双挂）
  → store.upsertProviders/upsertModels（模型发现种子）
```

- **隔离性**：两扩展各自独立镜像/数据卷/凭据存储/extension id（`workbuddy` vs `workbuddycn`）/provider id（`workbuddy` vs `workbuddy-cn`），模型、账户、Credit 互不可见（provider 行按 id 隔离，凭据在各扩展自己的加密卷）。
- **Manager 未就绪/注册失败**：启动 boot 路径 warn-and-skip（其余扩展不受影响）；升级路径 strict 抛错 → 503 + reload 恢复指引（1.2.1 起的行为，有回归测试）。

## 2. Core 内置清理

删除（commit `9dc8d7c`）：
- `register.ts` 中 `createWorkBuddyProvider` / `createWorkBuddyCnProvider` 注册项及其 import
- `login-api.spec` 中两个进程内 workbuddy 登录测试 → 替换为迁移后守卫（login API 不得为 extension 提供的 provider 伪造流程）

内置注册表：**7 → 5 实例**（buddy-intl、codebuddy、qoder、qoder-cn、zcode）。

保留（未误删）：
- `src/providers/shared/buddy/*`（协议/product/provider 工厂）——内置 codebuddy/buddy-intl 仍在用，且两个扩展的测试套件引用其产品常量
- `src/providers/workbuddy/`、`src/providers/workbuddy-cn/` 模块文件本体——作为共享协议模块保留（与 cline/codearts 等已迁移 provider 一致的做法），仅移除 Core 注册

## 3. 引用安全检查

全局检索确认：`src/` 内两 provider 工厂仅 register.ts 引用（已移除）；tests 中 buddy-provider/credits/audit-regressions 直接 import 工厂做单元测试——继续有效（模块仍在）。

## 4. 测试与构建

| 项 | 结果 |
|---|---|
| Core 全量 | **631 passed \| 2 skipped**（49 文件），typecheck 0 error |
| workbuddy 扩展 | 75/75（含真实上游验证后的 system 注入、工具兼容用例） |
| workbuddycn 扩展 | 75/75（含 1.0.4 工具兼容） |
| Core 镜像 | `local/mpag-phase3:1.2.2` 重建，镜像内确认无进程内 workbuddy 引用 |
| 扩展镜像 | workbuddy:1.0.1 / workbuddycn:1.0.4 均为已验证版本（未改动，无需重建） |

## 5. 部署需求（等你确认，暂未部署）

| 组件 | 需要动作 | 说明 |
|---|---|---|
| Core | 升级镜像 1.2.1 → **1.2.2** | 含：quota rawJson 修复（Credit Console 显示）+ 内置注册清理 + 之前的升级重注册修复。compose 钉版+`up -d`，约 30 秒 |
| Extension Manager | 与 Core 同镜像（1.2.2） | 随 compose 一起重建，无需单独操作 |
| workbuddycn 扩展 | **无需动作**（保持 1.0.4） | 已在运行，凭据/账户不受 Core 升级影响 |
| workbuddy 扩展 | **安装 1.0.1** | 未安装过；装完后需你完成一次官方登录（我会生成新链接），真实凭据才能建立 |

## 6. 部署后验证计划（待你授权执行）

1. Core 启动日志确认 remote provider 注册数 = 2（workbuddy 需装好后 reload）
2. Console：两 provider 各显示一份、无重复；Credit 视图显示真实数据（84.15 credits 等）
3. `/v1/models` 含 `workbuddy::` 与 `workbuddy-cn::` 两组命名空间
4. 国际版端到端聊天 + CN 版回归聊天
