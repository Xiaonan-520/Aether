# 故障排查

按症状索引。每条给出：怎么确认、为什么、怎么修。

---

## 登录与控制台

### 控制台一直显示 "Sign in"，密码正确也进不去

1. 确认网关活着：`curl -s http://127.0.0.1:8080/healthz` → `{"ok":true}`
2. 确认管理员已初始化：`curl -s http://127.0.0.1:8080/api/auth/status`
   - `{"initialized":false}` → 还没注册，控制台会显示注册页而不是登录页
   - `{"initialized":true}` → 已注册
3. 连续输错 5 次会触发 15 分钟限流，此时返回 **429**，页面提示 "Too many failed attempts"。
   等窗口过去，或**重启网关进程**（限流计数在内存里）。

### 忘了管理员密码

目前没有"重置密码"的公开入口（没有 SMTP，不做邮件找回）。可选做法：

- 用 `GATEWAY_ADMIN_TOKEN` 登录控制台（登录页有 "Use a static admin token" 开关），
  然后用它调管理 API；密码本身无法读回（只存 scrypt 摘要）。
- 彻底重来：停掉网关，删除数据目录里的 `gateway.db`，重启后重新走首次注册。
  **这会丢掉所有账号、凭据和 Token**，务必先备份。

### 注册时提示 "An administrator already exists"

正常行为：公开注册在第一个管理员创建成功后永久关闭。用邮箱密码登录，或用静态 token。

---

## Admin Token

### 客户端（RikkaHub 等）调用 /v1 返回 401 invalid API key

检查顺序：

1. Token 是不是 **Admin Token**（`gw-` 开头）？会话 token（`adm-` 开头）**不能**用于 `/v1`。
2. 是不是被撤销了？控制台 **API Keys** 页面看状态是否为 `revoked`。
3. 是不是过期了？看 `Expires` 列。
4. 请求头是不是 `Authorization: Bearer <token>`（注意 `Bearer` 后面一个空格）。

### 用 Admin Token 访问 /api 返回 401

这是设计如此。Admin Token 只用于 `/v1/*`；管理 API 需要**登录会话**或 `GATEWAY_ADMIN_TOKEN`。
如果是自动化脚本，用 `GATEWAY_ADMIN_TOKEN`；如果是人，登录控制台。

### 创建 Token 后忘了复制

完整 Token 只在创建时返回一次，库里只存 SHA-256。**无法找回**，只能在控制台撤销旧的、再创建一个。

---

## Extension

### 控制台 Extensions 页面报 "Extension manager unreachable"

说明 Core 调不到 Manager。检查：

```bash
docker ps --filter name=ai-gateway-extension-manager
docker logs --tail 30 ai-gateway-extension-manager
```

确认 `GATEWAY_EXTENSION_MANAGER_URL` / `GATEWAY_EXTENSION_MANAGER_TOKEN` 已配置且两边一致。
未配置时 Extension 相关路由是**不存在**的（404），不是报错。

### Manager 显示 unhealthy 但功能正常

历史遗留配置问题（KI-002）。Manager 监听 **9100**，如果 healthcheck 探测 8080 就会一直失败：

```bash
docker inspect ai-gateway-extension-manager --format '{{json .Config.Healthcheck}}'
docker exec ai-gateway-extension-manager sh -c 'curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:9100/healthz'
```

后者返回 200 就说明服务是好的，只是探测端口写错了。修正 `docker-compose.extensions.yml` 里
manager 的 healthcheck 指向 `9100/healthz`。

### 安装扩展报 `forbidden_image_source`

两种原因：

1. 镜像仓库不在信任列表 —— 只接受 `local/gateway-extension-<extensionId>`（或配置的仓库前缀）。
2. **镜像 tag 与 manifest 里的 `extension.version` 不一致**。这是最常见的一个：
   扩展作者升级了镜像 tag 却忘了改 manifest 版本号。确认方法：

   ```bash
   docker run --rm --entrypoint sh local/gateway-extension-xxx:1.0.14 \
     -c 'node -e "fetch(\"http://127.0.0.1:8080/manifest\").then(r=>r.json()).then(j=>console.log(j.extension.version))"'
   ```

   输出的版本必须和 tag 相同。不同就修扩展源码里的版本号重新构建。

### 安装成功但 `providersRegistered=false`

```bash
curl -X POST -H "Authorization: Bearer $SESSION" \
     http://127.0.0.1:8080/api/console/extensions/<id>/reload
```

升级后 Manager 会轮换扩展 token，Core 需要重新挂载才能用新 token 通信。新版 Core 会自动恢复，
但显式 reload 是幂等的、更可靠。

### 扩展装好了，但 /v1/models 里没有它的模型

1. 确认扩展 `healthState=healthy` 且 `providersRegistered=true`
2. 确认扩展里已经登录了至少一个账号（扩展只注册 Provider，模型通常随账号出现）
3. `curl -H "Authorization: Bearer $ADMIN_TOKEN" http://127.0.0.1:8080/v1/models` 看原始列表

---

## 数据与部署

### 升级镜像后账号/Token 全没了

说明数据卷没接上或用了错误的卷。检查：

```bash
docker inspect ai-gateway --format '{{json .Mounts}}'
```

`/data` 必须挂在命名卷上（`gateway-data`），且 `GATEWAY_SECRET` 必须和创建账号时一致
（变了就解不开已存的凭据）。

### 忘记 GATEWAY_SECRET

凭据是用它派生的密钥加密的，**丢了就无法解密**，只能重新登录所有 Provider 账号。
把它和数据库一起备份。

### 备份与恢复

```bash
# 备份（数据库 + 环境变量）
docker run --rm -v multi-provider-ai-gateway_gateway-data:/data -v "$PWD":/backup \
  alpine tar czf /backup/aether-backup-$(date +%F).tgz -C /data .
cp .env aether-env-$(date +%F).bak

# 恢复
docker compose down          # 保留卷
docker run --rm -v multi-provider-ai-gateway_gateway-data:/data -v "$PWD":/backup \
  alpine tar xzf /backup/aether-backup-2026-01-01.tgz -C /data
docker compose up -d
```

`GATEWAY_SECRET` 必须与备份时相同，否则凭据不可用。

### 回滚到上一个版本

```bash
# 钉到之前记录的 sha tag
GATEWAY_IMAGE_TAG=sha-<commit> docker compose up -d
```

数据库迁移是向前兼容的（只新增表和列），旧版本会忽略新表，通常不需要回滚数据库。
