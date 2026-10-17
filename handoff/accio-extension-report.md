
## 登录阻塞（2026-10-17 实测）

真实登录尝试失败：**Accio 登录页成功登录后跳转到官方工作台 `/work`，
不携带 `code`/`state` 回跳 `return_url`**（多轮实测，双浏览器）。

原因分析：参考实现的登录闭环运行在**桌面客户端的 localhost loopback**——
官方登录页对 `http://127.0.0.1:PORT` 类 return_url 会执行 code 回跳；
而我们的 `return_url` 是**局域网/overlay 网络地址**，登录页大概率把
非本地回环地址判定为「网页端登录」，走工作台路径而不回发授权码。

已验证不成立的方案：
- 换用 easytier overlay 地址（10.126.126.1）→ 仍跳 /work
- 同浏览器已登录态下重新走授权链接 → 仍跳 /work，URL 无 code

## 解除阻塞的可能路径

1. **本机桌面客户端方案**（参考实现的原始形态）：在用户 PC 上跑
   dsh/Accio 客户端完成 loopback 登录，把生成的凭据
   （access_token / refresh_token / region）通过扩展的
   `POST /v1/accounts` + `submit-auth-code` 类 action 导入。
   → 需要扩展增加「凭据导入」action（协议允许，RFC §16.4）。
2. **Tailscale/EasyTier 内把回调地址伪装成 localhost**：不可行，
   回跳发生在浏览器端，地址永远是浏览器视角。
3. **等待上游支持网页端 return_url 回跳**：不可控。

结论：Accio 的协议层、Extension 骨架、测试（11 E2E + 21 协议例）全部就绪，
唯一缺口是**一次合法获取到的凭据**。最小解锁路径 = 路径 1（凭据导入 action）。
