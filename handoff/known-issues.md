# 已知问题与待办

按项目惯例记在 `handoff/`。每条包含现象、根因、影响、建议修复和验收标准。
本文件只记录问题，不代表已排期。

---

## KI-001 扩展安装流程对普通用户过于复杂

**记录日期**：2026-10-24
**优先级**：P2（易用性）
**状态**：**已修复（2026-10-25）**

### 原现象

安装一个扩展需要用户手工：

1. 知道镜像名与 tag；
2. 起临时容器读 `/manifest`，还要注入 `GATEWAY_EXTENSION_TOKEN` 才被允许访问；
3. `docker cp` 把 JSON 取出来；
4. 理解请求体是 `{manifest, image:{repo,tag}}`，且 tag 必须与 `manifest.extension.version` 逐字节相等；
5. 从 `.env` 取 `GATEWAY_ADMIN_TOKEN`；
6. `curl POST /api/console/extensions/install`；
7. 若 `providersRegistered=false` 再调一次 `/reload`。

### 修复内容

- **Manager**：新增 `ExtensionManager.inspectImage()` 和 `POST /api/extensions/inspect-image`。
  用与正式安装相同的加固 spec 起一个**无卷、一次性**的探针容器，读取镜像实际服务的
  `/manifest` 后必定销毁（成功/失败都清理）。不写任何状态。
- **Core**：新增 `POST /api/console/extensions/install-from-image`，body 只需
  `{"image": {"repo", "tag"}}`。Core 让 Manager 探针取 manifest，再走**原有**的
  `install()` 路径 —— 信任校验（仓库前缀、tag == manifest 版本）、健康检查、conformance
  全部保留，只是去掉了手工复制 JSON 这一步。
- **Console**：Extensions 页面新增 **Install** 按钮和对话框（镜像仓库 + tag 两个输入框），
  带加载态、错误提示、成功后自动刷新列表。

### 保留的手工路径

`POST /api/console/extensions/install`（带 manifest）仍然存在，供离线/特殊场景使用。

### 验收

- [x] `inspectImage` 返回镜像真实 manifest，且不留下安装记录、不残留容器
- [x] 镜像无法提供 manifest 时失败并清理探针（测试覆盖）
- [x] `latest` 被拒绝
- [x] Console 可用镜像名安装，无需接触 JSON
- [x] 原有 `install`（带 manifest）路径不受影响

---

## KI-002 Extension Manager 健康检查端口错误

**记录日期**：2026-10-24
**优先级**：P1（运维可见性）
**状态**：**已修复（2026-10-25）**

### 原现象

`ai-gateway-extension-manager` 长期显示 `unhealthy`，`docker inspect` 报：

```
curl: (7) Failed to connect to 127.0.0.1 port 8080 after 0 ms
```

### 根因

Manager 实际监听 **9100**（`HTTP_PORT: "9100"`），但 healthcheck 探测 **8080** ——
那是 gateway 的端口。Manager 功能完全正常（安装/reload/注册全部成功），只是被 Docker 误判。

本地 `docker-compose.extensions.yml` 原本**没有** healthcheck，部署时被外部加上了错误的一份。

### 修复内容

在 `docker-compose.extensions.yml` 的 `gateway-extension-manager` 服务补上正确的健康检查：

```yaml
healthcheck:
  test: ["CMD-SHELL", "curl -f http://127.0.0.1:9100/healthz || exit 1"]
  interval: 30s
  timeout: 5s
  start_period: 10s
  retries: 3
```

**没有关闭健康检查来掩盖问题** —— 探测的是真实服务端口。

### 验收

- [ ] `docker ps` 显示 manager `healthy`（需在部署环境重启该容器后观察）
- [ ] `docker inspect` 的 `FailingStreak` 归零
- [ ] 停掉 manager 进程时健康检查能正确转为 unhealthy

前两项需要在运行环境验证，本轮只改了配置并做了本地静态校验。

---

## 已知但本轮不修的问题

### 会话限流计数在内存中

连续登录失败 5 次后的 15 分钟锁定记在进程内存里，**重启网关即清除**。
单实例部署下这是可接受的；多副本部署需要外部存储（Redis 或数据库表）。

### 没有"忘记密码"流程

设计上没有 SMTP，也就不做邮件找回。恢复手段只有：用 `GATEWAY_ADMIN_TOKEN` 进入控制台
（但改不了密码）、或清库重来（丢数据）。如果将来需要，应实现"本地恢复码"而不是邮件。

### `GATEWAY_ADMIN_TOKEN` 不可撤销

它是环境变量，改它需要重启。这一轮没有引入在线轮换机制。它是内部后门，
不要发给浏览器或客户端。
