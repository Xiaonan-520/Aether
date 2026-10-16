# WorkBuddyCN → Phase 3 Gateway → OpenAI 兼容客户端 长期使用指南

更新：2026-10-11 ｜ 全文仅用占位符，无真实凭据。
所有接口均为实测（只读验证），未修改任何服务/数据库。

## 0. 当前运行现状（实测）

| 项 | 值 |
|---|---|
| Gateway 镜像 | `local/mpag-phase3:1.2.0`（Core），容器 `phase3-gateway`，healthy |
| Extension Manager | 同镜像，容器 `phase3-extension-manager`，healthy |
| WorkBuddyCN Extension | `local/gateway-extension-workbuddycn:1.0.3`，容器 `gw-ext-workbuddycn`，healthy；近期日志有 `chat.success`（deepseek-v4-flash） |
| 对外地址 | `http://192.168.10.53:18080`（实测 `/healthz` → `{"ok":true}`；局域网可达） |
| Console | `http://192.168.10.53:18080/console/`（实测 200，SPA hash 路由，Keys 页 `#/keys`） |
| 健康检查 | `GET /healthz`（无需认证） |

## 1. Gateway API Key 管理（实测接口）

认证：所有 `/api/*` 需要 **admin token**（容器环境变量 `GATEWAY_ADMIN_TOKEN`，与 OpenAI 面的 `gw-...` Key 是两回事）。

| 操作 | 方法与路径 | 说明 |
|---|---|---|
| 创建 | `POST /api/keys` | body `{"name":"rikkahub-dev","expiresAt":<epoch毫秒,可选>}`；**完整 Key 只在响应里出现一次** |
| 列表 | `GET /api/keys` | 脱敏视图：`id / name / keyPrefix / enabled / createdAt / lastUsedAt / expiresAt / revokedAt`，无完整 Key |
| 撤销 | `DELETE /api/keys/:id` | 软撤销，不可恢复 |

Key 格式：`gw-<prefix>.<secret>`。支持的参数只有 `name`（≤120字符）和 `expiresAt`（毫秒时间戳，不填=永久）。没有按模型/Provider 的权限范围参数——不要假设存在。

### 创建步骤（推荐用 Console，避免 Shell 历史）

1. 浏览器打开 `http://192.168.10.53:18080/console/`，输入 admin token 登录。
2. 侧栏进入 **API Keys**（`#/keys`），点创建，填名称如 `rikkahub-dev`（可留空有效期）。
3. 创建成功后**完整 Key 只显示这一次**，立即复制到密码管理器 / 客户端配置，刷新后不可再查看。
4. 确认可用（本机或局域网任意终端，Key 从环境变量读，不进 Shell 历史）：
   ```bash
   export GW_KEY='<你的gw-...Key>'   # 或从密码管理器粘贴，用完 unset
   curl -s http://192.168.10.53:18080/v1/models -H "Authorization: Bearer $GW_KEY" | head -c 500
   ```
   返回模型 JSON 数组即正常。
5. 查看状态/最近使用：Console Keys 页可看 `lastUsedAt`、`expiresAt`、启用状态。
6. 轮换：先在 Console 创建新 Key → 客户端换上新 Key 验证通过 → 再撤销旧 Key（DELETE 或页面操作），避免服务中断。

安全要求（务必遵守）：
- 完整 Key 不写入 Git、handoff 文档、聊天记录、Shell 历史（用 `read -s` 或环境变量，避免 `curl -H "Bearer gw-xxx"` 明文）。
- 一把钥匙一个用途（如 rikkahub-dev、ci-dev 分开），便于单独撤销。

## 2. RikkaHub / OpenAI 兼容客户端配置

| 字段 | 值 |
|---|---|
| Base URL | `http://192.168.10.53:18080/v1` |
| API Key | 你创建的 `gw-...` Key |
| Model | 见下方模型 ID |

可用模型 ID（workbuddy-cn 扩展清单，`deepseek-v4-flash` 近期实测有成功调用记录；创建 Key 后用 `/v1/models` 核对最终列表）：

```
workbuddy-cn::deepseek-v4-flash   （推荐，近期有成功记录）
workbuddy-cn::glm-5.3
workbuddy-cn::hy3
```

要点：
- **必须带 `workbuddy-cn::` 命名空间前缀**。裸 `deepseek-v4-flash` 若被多个 provider 同时提供会报 400 `model_ambiguous`。
- RikkaHub 仅支持局域网直连此地址；外网需自行建立 VPN/隧道（见 §6），Gateway 未暴露公网。
- 配置后先在客户端内拉一次模型列表验证连通。

## 3. 请求验证（占位符示例）

普通聊天：
```bash
export GW_KEY='<你的gw-...Key>'
curl -s http://192.168.10.53:18080/v1/chat/completions \
  -H "Authorization: Bearer $GW_KEY" -H 'content-type: application/json' \
  -d '{"model":"workbuddy-cn::deepseek-v4-flash","messages":[{"role":"user","content":"ping"}]}'
```
预期：200 + OpenAI 格式 JSON，`choices[0].message.content` 有内容。

流式（SSE）：
```bash
curl -sN http://192.168.10.53:18080/v1/chat/completions \
  -H "Authorization: Bearer $GW_KEY" -H 'content-type: application/json' \
  -d '{"model":"workbuddy-cn::deepseek-v4-flash","stream":true,"messages":[{"role":"user","content":"数到5"}]}'
```
预期：`content-type: text/event-stream`，连续多行 `data: {...}` 增量 delta。RikkaHub 打开"流式输出"开关即走此路径。

## 4. 错误判别（实测映射）

| 现象 | 含义 | 处理 |
|---|---|---|
| 401 `invalid_api_key` | Gateway Key 缺失/错误/过期/已撤销 | 检查 Key；Console 看 `enabled/revokedAt/expiresAt`；必要时换新 Key |
| 400 `model_ambiguous` | 裸模型 id 命中多个 provider | 改用 `workbuddy-cn::模型名` |
| 400 `model_not_found` 类 | 模型 id 写错或未注册 | 用 `/v1/models` 返回的确切 id |
| 502 `type: upstream_auth_error`（code `auth_invalid`/`token_expired`） | **上游 WorkBuddyCN 账号凭据失效** | 与你的 Key 无关；需在 Console 重新登录该上游账号 |
| 502 `type: rate_limit_error` | 上游限流 | 稍后重试 |
| 502 `type: insufficient_quota`（code `quota_exhausted` 类） | **上游免费额度用尽/过期** | 见 §5 |
| 502 `type: upstream_error` / `timeout` | 上游 5xx 或网络 | 稍后重试；持续出现查 `docker logs phase3-gateway` |
| 502 `type: manual_action_required` | 上游要求人工动作（如 captcha） | 去 Console 处理对应账号 |

## 5. 额度与有效期——务必区分四层

1. **Gateway API Key 有效期**：创建时自定义（不填=永久）。只控制"能否进 Gateway 的门"，与上游额度无关。
2. **WorkBuddyCN 上游账号免费额度**：以腾讯/WorkBuddyCN 官方活动规则为准（每日签到等）。**创建新 Gateway Key 不能恢复已过期的上游积分**——额度记在上游账号上。
3. **上游模型可用性**：由上游决定，Gateway 清单是投影；上游下线某模型时聊天会报上游错误。
4. **Gateway 能力**：路由（`provider::model`）、鉴权（Key 哈希校验 + `lastUsedAt`）、账号池调度（上游失败自动换同 Provider 其它账号）、配额镜像与 credit 触发接口。

**额度过期后怎么办**：
- 典型报错：502 + `upstream_auth_error` 或 `insufficient_quota`，且多个模型都失败 → 大概率上游账号额度/凭据问题。
- 处理：① Console 里对该 WorkBuddyCN 账号做签到/领积分（或用管理员手动触发接口）；② 若凭据过期则在 Console 重新登录；③ 需要继续开发时可临时把 Base URL 指向其它已配置 Provider（修改客户端配置里的模型前缀即可，如其它 `xxx::模型`），**但切换 Provider 前先确认该账号额度政策，避免意外消耗付费额度；不要改 Gateway 默认模型路由**。

## 6. 外网访问安全注意事项

- 当前 Gateway **只监听内网**（0.0.0.0:18080 由 Docker 发布在宿主机；无公网映射）。外网使用请走 WireGuard/Tailscale 等 VPN，**不要做公网端口转发**——Gateway 面虽有 Key 鉴权，但 `/console/` HTML 无需认证即可加载，公网暴露会放大爆破与探测风险。
- admin token 与 `gw-` Key 分开保管；admin token 泄露等同于控制面失守（可建/撤 Key、看账号投影）。
- 隧道场景下仍建议给 Key 设置 `expiresAt` 并定期轮换。

## 7. 快速自检清单

```bash
# 1. 健康与版本
curl -s http://192.168.10.53:18080/healthz
# 2. 模型列表（需 Key）
curl -s http://192.168.10.53:18080/v1/models -H "Authorization: Bearer $GW_KEY"
# 3. 非流式聊天
curl -s http://192.168.10.53:18080/v1/chat/completions \
  -H "Authorization: Bearer $GW_KEY" -H 'content-type: application/json' \
  -d '{"model":"workbuddy-cn::deepseek-v4-flash","messages":[{"role":"user","content":"hi"}]}'
# 4. 流式
curl -sN http://192.168.10.53:18080/v1/chat/completions \
  -H "Authorization: Bearer $GW_KEY" -H 'content-type: application/json' \
  -d '{"model":"workbuddy-cn::deepseek-v4-flash","stream":true,"messages":[{"role":"user","content":"hi"}]}'
# 5. Key 状态（需 admin token，非 gw Key）
curl -s http://192.168.10.53:18080/api/keys -H "Authorization: Bearer $ADMIN_TOKEN"
```
