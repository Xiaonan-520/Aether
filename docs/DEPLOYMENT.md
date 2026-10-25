# Aether Core 部署与回滚（显式 commit tag）

本文件描述如何把 `ai-gateway` 更新到一个**确定的 commit 镜像**，以及如何回滚。
全程不修改 `.env`、不修改 compose 文件、不执行 `docker compose down`、不删除卷、
不重启无关容器。

## 为什么需要这套流程

`docker-compose.yml` 使用：

```yaml
image: ${GATEWAY_IMAGE_REPO:-ghcr.io/xiaonan-520/aether}:${GATEWAY_IMAGE_TAG:-latest}
```

如果 `.env` 没有钉住 `GATEWAY_IMAGE_TAG`，直接执行 `docker compose up -d` 会落到
`latest`（一个会移动的 tag），或者复用本地已有的旧镜像。两者都不能证明运行的是
哪个 commit。

`scripts/deploy-core.sh` 因此强制要求 40 位完整 commit SHA，并在部署前校验镜像
label，而不是依赖隐式的 `latest`。

## 使用方式

```bash
cd /home/xiaonan/Aether

# 1) 确认目标 commit 的 CI 已成功、GHCR 已有对应 tag
#    tag 形如 sha-<40-char-commit>

# 2) 只读预览（不执行任何变更）
scripts/deploy-core.sh --dry-run <40-char-commit>

# 3) 部署
scripts/deploy-core.sh <40-char-commit>

# 4) 查看当前实际运行的镜像与身份
scripts/deploy-core.sh --digest

# 5) 回滚到上一个已知健康的 commit
scripts/deploy-core.sh --rollback <40-char-commit>
```

`--rollback` 与普通部署走同一条校验与健康检查路径，区别只在于调用方明确知道
自己在回退。脚本在部署成功后也会打印可以直接复制的回滚命令。

## 脚本做了什么

1. **参数校验**：拒绝短 SHA、`latest`、`main` 或其他非 40 位十六进制值。
2. **配置存在性**：要求 `docker-compose.yml` 与 `docker-compose.extensions.yml` 存在。
3. **镜像身份校验**：`org.opencontainers.image.revision` 必须等于目标 commit，
   否则拒绝部署。
4. **当前状态记录**：打印当前镜像、revision、健康状态、启动时间。
5. **只更新一个服务**：`up -d --no-deps --no-build gateway`。
6. **Compose 解析校验**：确认 compose 实际解析出的镜像就是目标镜像。
7. **部署后健康检查**：容器 health 状态 + 容器内 `/healthz`。
8. **失败自动回滚**：任一步失败都会用部署前的镜像重建 gateway，并再次验证健康；
   回滚也失败时以非零状态退出并提示人工介入。

## 前置条件

- 目标镜像已经在本地（`docker pull ghcr.io/xiaonan-520/aether:sha-<commit>`），
  或已通过离线方式 `docker load` 导入。
- 当前运行的 `ai-gateway` 已经钉在 `sha-<40-char>` 镜像上（脚本会拒绝继续，
  直到现状可追溯）。
- Docker daemon 能访问 GHCR；代理问题见下节。

## Docker daemon 代理

Docker daemon 的代理来自 systemd drop-in：

```text
/etc/systemd/system/docker.service.d/http-proxy.conf
```

其中 `HTTP_PROXY` / `HTTPS_PROXY` 指向内网代理。若该代理不可达，所有
`docker pull` 都会超时，即使宿主机 `curl` 直连正常。检查方式：

```bash
systemctl show docker --property=Environment --no-pager
timeout 3 bash -c '</dev/tcp/<proxy-host>/<proxy-port>' && echo up || echo down
sudo systemctl restart docker   # 仅在确认代理配置已修正后执行，会重启所有容器
```

注意：`systemctl restart docker` 会重启宿主机上所有容器。执行前必须记录当前
容器状态，执行后逐个核对健康状态与启动时间。

## 回滚信息

- 回滚镜像不需要访问 registry：脚本使用本地已有的旧镜像。
- 数据库 schema 无破坏性迁移；回滚不需要恢复数据库。
- `aether_gateway-data` 卷与 Extension 数据卷不随版本回退。
- Extension 的回滚走它自己的 Manager 流程，不是这个脚本的职责。
