# 项目改名：Multi-Provider AI Gateway → Aether

> 状态：代码与文档已改名，**镜像与容器尚未迁移**（刻意的，见 §3）。
> 本文记录新旧名称映射、兼容性处理与后续迁移步骤。

## 1. 命名方案

| 对象 | 旧 | 新 | 说明 |
| --- | --- | --- | --- |
| 项目展示名称 | Multi-Provider AI Gateway | **Aether** | README 标题、文档、Console 品牌 |
| GitHub 仓库 | `Xiaonan-520/multi-provider-ai-gateway` | `Xiaonan-520/Aether` | GitHub 会自动把旧 URL 重定向到新名称 |
| GHCR 镜像 | `ghcr.io/xiaonan-520/multi-provider-ai-gateway` | `ghcr.io/xiaonan-520/aether` | 改名后 CI 自动发布到新路径 |
| npm 包名 | `ai-account-gateway` | `aether` | 私有包，未发布到 npm registry |
| Console 包名 | `gateway-console` | 保持不变 | 内部工作区包，非用户可见 |
| 容器名 | `ai-gateway` 等 | 保持不变 | 改名会打断现有部署，收益不足以抵消风险 |
| Compose 服务名 | `gateway` 等 | 保持不变 | 同上 |
| 环境变量 | `GATEWAY_*` | 保持不变 | 改动会破坏所有现有 `.env` |
| API 路径 / 数据库 / Extension 协议 | — | 保持不变 | 改名不涉及任何行为变更 |

命名原则：**只改用户可见的项目身份和发布目标**，不动任何运行时契约。

## 2. 已修改的文件

**用户可见名称**

- `README.md` / `README.en.md` — 标题、clone 地址、镜像地址（新旧并列）
- `Dockerfile` — `org.opencontainers.image.{source,title,description}` 标签
- `console/index.html` — `<title>Aether Console</title>`
- `console/src/console-app.tsx` — 顶栏品牌文字
- `.env.example` — 文件头注释

**发布与构建**

- `package.json` / `package-lock.json` — `name: aether`、description
- `docker-compose.yml` / `docker-compose.extensions.yml` — 镜像默认值改为新路径，并引入
  `GATEWAY_IMAGE_REPO` 覆盖变量

## 3. 兼容性与部署安全性

### 3.1 已有部署不受影响

Docker Compose 只在 `docker compose pull` / `up` 时才解析镜像引用。**正在运行的容器
不会被改名影响**——它们的镜像 ID 已经固定，容器名、数据卷、环境变量都没有变。

Phase 3 栈（`phase3-gateway` / `phase3-extension-manager` / 6 个 `gw-ext-*`）继续使用
`local/mpag-phase3:*` 和 `local/gateway-extension-*` 本地镜像，与 GHCR 改名无关。

### 3.2 旧镜像不会被删除

GitHub 仓库改名**不会删除** GHCR 里以旧路径发布的包。旧 tag 全部保留，可以继续
`docker pull ghcr.io/xiaonan-520/multi-provider-ai-gateway:<tag>`。

### 3.3 镜像引用可回退

两个 compose 文件现在写成：

```yaml
image: ${GATEWAY_IMAGE_REPO:-ghcr.io/xiaonan-520/multi-provider-ai-gateway}:${GATEWAY_IMAGE_TAG:-latest}
```

**默认值仍是旧路径**，因为它是目前唯一真实存在的包：截至改名时，所有已发布的
镜像都在 `ghcr.io/xiaonan-520/multi-provider-ai-gateway` 下。默认指向一个还不
存在的包会让 `docker compose pull` 直接失败。

要提前切到新路径（等 CI 发布后），在 `.env` 里加一行即可，无需改文件：

```bash
GATEWAY_IMAGE_REPO=ghcr.io/xiaonan-520/aether
```

### 3.4 CI 的镜像路径行为（已实测）

`.github/workflows/docker.yml` 用 `${GITHUB_REPOSITORY,,}` 推导镜像名，因此：

- **改名时已经创建**的 run 仍推送到旧路径（`GITHUB_REPOSITORY` 在 run 创建时固化）；
- **改名后新建**的 run 会推送到 `ghcr.io/xiaonan-520/aether`。

已观察到的事实：改名提交 `d12e3fa` 的 CI run（`40090696482`）在改名瞬间创建，
`build-and-push` 成功但推到了**旧路径**。新包 `aether` 目前尚不存在。

因此本轮的顺序是：默认值保持旧路径 → 等下一次 push 触发的新 run 发布 aether 包
→ 验证新包可拉取 → 再翻转默认值。翻转是独立的一行改动，不随本次改名一起做。

### 3.5 生产环境

生产 `ai-gateway:8080` **本轮没有做任何改动**，也没有部署新镜像。是否切换到新镜像
路径、何时升级，是独立决策，见 `handoff/AGENT-HANDOFF-2026-10-24.md` 的 P0 项。

## 4. 保留旧名称的地方及原因

| 位置 | 原因 |
| --- | --- |
| `handoff/**`、`docs/audits/**` | 历史报告，记录的是当时的事实。改写会让审计记录失真 |
| `extensions/*/docs/PROTOCOL_CONTRACT.md` | 指向服务器上真实存在的旧路径 `~/.mpag-p3/src/multi-provider-ai-gateway` |
| GitHub Actions `${GITHUB_REPOSITORY,,}` | 动态推导，改仓库名后自动跟随，**不需要也不应该硬编码** |
| `LICENSE` 的 `Copyright Xiaonan-520` | 版权署名是人的标识，不是项目名 |
| `system_fingerprint: "gateway"` | 协议字段值，客户端可能已依赖，改名属于行为变更 |
| 容器名 `ai-gateway`、服务名 `gateway`、`GATEWAY_*` 环境变量 | 运行时契约，改动会破坏现有部署 |
| 本地镜像 `local/mpag-phase3:*` | 现有 Phase 3 栈正在使用，改名需要重建镜像，本轮不做 |

## 5. 后续迁移步骤（未执行）

1. 在 GitHub 上把仓库改名为 `Aether`（Owner 权限，`admin:true` 已具备）。
2. 确认 GitHub Actions 在新仓库名下正常运行，镜像推到 `ghcr.io/xiaonan-520/aether`。
3. 观察一段时间的双路径发布，确认新包可用。
4. 需要时把生产 compose 的 `GATEWAY_IMAGE_REPO` 切到新路径并拉取新镜像。
5. 容器名/服务名/环境变量如需统一，应作为独立变更单独评估——不随改名一起做。

## 6. 不做的事

- 不改 API 路径、认证方式、数据库 schema、Extension 协议
- 不改 Core 业务逻辑
- 不重启、不升级任何容器
- 不删除旧镜像、旧 tag、Git 历史或未跟踪文件
