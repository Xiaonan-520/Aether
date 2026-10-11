# Provider Extension 迁移批次状态（滚动更新）

| 批次 | Provider | Commit | 测试 | 内置注册移除 | 镜像 |
|---|---|---|---|---|---|
| 1 | lobsterai + raccoon | 408869a | E2E 13 ✓ | ✓（-2） | raccoon 1.0.0 |
| 2 | loomy | f698ebe | E2E 13 ✓ | ✓（-1） | loomy 1.0.0 |
| 3 | cline | a110e18 | E2E 14 ✓ | ✓（-1） | cline 1.0.0 |
| 4 | trae ×2（单镜像双产品） | 683ffa1 | E2E 9 ✓ | ✓（-2） | trae 1.0.0 |
| 5 | codearts | 6d9c441 | E2E 12 ✓ | ✓（-1） | codearts 1.0.0 |

内置注册表现状：7 实例（buddy 族 x4、qoder x2、zcode）。

## 剩余批次评估

### 批次6（候选）：buddy 族 ×4 → workbuddycn Extension 多产品化
- 方案：把 workbuddycn Extension 从单产品改为 providers[] 多条目（workbuddy-cn/workbuddy/codebuddy/buddy-intl），每条目独立 endpoint/platform/productCode/userAgent；凭据存储按 providerId 分区。
- 风险：中高。① 对已部署运行的 1.0.3 扩展是结构性改动（需要 1.1.0 蓝绿升级 + 存储迁移）；② credential store 的 salt/文件名需按 provider 区分以避免跨产品凭据混淆；③ Core 侧 providers 表已存在 4 个 buddy provider 行，provider id 不变所以镜像兼容。
- 建议窗口：需要专门授权（涉及运行中扩展升级）。

### 批次7：qoder ×2
- 阻塞：WASM 二进制不随镜像分发（合规红线），运行时依赖 QODER_WASM_PATH 卷挂载；RFC §24.7 卷方案需先落地（manifest volumes 声明 + 运营者放置二进制）。协议面本身可完整迁移（除 WASM 加密请求外全部可测）。
- 建议等待：WASM 卷挂载部署方案确认。

### 批次8：zcode
- 阻塞：Core http/app.ts 的 captcha 人工交互特判（POST /api/accounts/:provider/captcha + GET /captcha/zcode 渲染页）依赖"服务端渲染 HTML + widget 参数"能力，RFC 规划用 §16 交互式 Action 通道替代。需先扩展 Action 协议（browser/form UI + HTML 透传），属于协议演进而非单纯迁移。
- 建议最后做或暂缓，保留双轨。

## Core 侧清理（阶段6，随批次递进）
- register.ts 已从 14 实例降至 7；已迁移 provider 的 in-process 代码保留为共享协议模块（extensions 复用其 protocol/credits 纯函数），符合"不删除仍被使用的公共组件"。
- app.ts 的 zcode captcha 特判保留至批次8。
