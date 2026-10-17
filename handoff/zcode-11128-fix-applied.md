# 11128 修复实施记录：git 上下文标签串归一（2026-10-17）

> 本文不原样写出触发串（见 `zcode-11128-history-contamination.md` §6 规则）。
> 一律称「git 上下文标签串」。

## 1. 根因（已实测确认，非推测）

buddy / workbuddy / workbuddycn / codebuddy 上游对**请求文本**做渠道校验，
命中客户端指纹库即返回 `400 / 11128`。

已确认的触发源之一：ZCode CLI 在 git 工作区内启动时，
`apps/zcode-cli/packages/core/src/context/sections/env-info.ts:24`
的 `MAIN_BRANCH_LABEL` 会被 `buildGitSystemContextSection` 注入动态 system 段。
该串是「Main branch」+ 一段括号说明（说明该分支通常用于 PR）。

关键判断：**括号内容是给模型的分支选择提示，不含任何客户端身份语义**，
模型除了「这是主分支」之外不需要它。

## 2. 校验范围（实测，role 分离）

| 位置 | 是否触发 |
|---|---|
| system 消息（任一） | **是** |
| assistant 正文 | **是** |
| user 消息 | 否 |
| tool 结果 content | 否 |
| tool_call arguments | 否 |
| reasoning_content | 否 |

即：**system + assistant 正文**。旧 Pi 会话之所以「越重试越坏」，
就是因为污染落在 assistant 正文里，随历史每轮重放。

## 3. 修复方案

在每个 buddy 族 wire 组装点，把该句改写为语义等价、更短的表述
（"Main branch (for PRs)"），**只动这一句**。

| 位置 | 文件 |
|---|---|
| workbuddycn 扩展 | `extensions/workbuddycn/src/util/channel-text.ts`（新）+ `provider/workbuddycn/chat.ts` |
| workbuddy 扩展 | `extensions/workbuddy/src/util/channel-text.ts`（新）+ `provider/workbuddy/chat.ts` |
| codebuddy 扩展 | `src/providers/shared/buddy/channel-text.ts`（新）+ `src/extensions/codebuddy/main.ts` |
| 内置 buddy provider | 同上 util + `src/providers/shared/buddy/provider.ts` |

**明确没有做的事**（与「不准规避」边界一致）：
- 不改 user / tool / tool_call args / reasoning 的内容（实测不触发，保持字节不变）
- 不改写 Claude Code 身份整句——它是**另一条独立指纹**，改写等于冒充其他客户端，超出范围，遇到就诚实失败
- 不屏蔽错误码、不删历史、不整体删 system

## 4. 真实上游验证（经 18080 → workbuddycn 1.0.7）

| 用例 | 修复前 | 修复后 |
|---|---|---|
| system 含触发串 | 400 / 11128 | **200** |
| 同上，流式 | — | **200**，6398 bytes + [DONE] |
| assistant 历史含触发串 | 400 / 11128 | **200** |
| 普通请求 | 200 | **200** |
| 工具调用（system 含触发串） | — | **200**，finish=tool_calls，`bash {"command":"ls -la /tmp"}` |
| 工具结果回传 | — | **200**，正确引用输出 |
| developer role | — | **200** |

## 5. 版本与部署

- commit `35c0d45`，GitHub Actions run `39006059923` **success**
- workbuddycn `1.0.6 → 1.0.7`（已部署，Manager upgrade 200，healthy，restarts=0）
- workbuddy `1.0.3 → 1.0.4`（镜像已构建，**未部署**）
- codebuddy/buddy-intl manifest `1.0.5 → 1.0.6`（镜像已构建，**未部署**）
- `phase3-gateway` / `phase3-extension-manager` 全程未动
- 生产 `ai-gateway`（8080，旧镜像）未触碰

## 6. 未解决 / 边界情况

1. **workbuddy / codebuddy / buddy-intl 扩展尚未升级**，仍跑旧版本：
   若这些渠道遇到同一触发串，仍会 11128。升级需逐个走 Manager（各自独立验证）。
2. **生产 8080 仍是旧镜像**，无 developer-role 修复，也无本次修复。
3. **Claude Code 身份整句**这条独立指纹未处理（按设计不做）。
4. ZCode 侧仍无配置可关闭该 git 上下文注入（已确认源码无开关）。
5. 旧会话仍是被污染的，不要复用。

## 7. 测试

- Core `tests/buddy-channel-check.spec.ts`：5 例（wire 级，断言实际上游 payload）
- `extensions/workbuddycn/test/unit/channel-text.spec.ts`：17 例
- `extensions/workbuddy/test/unit/channel-text.spec.ts`：17 例
- Core 全量 **699 passed | 2 skipped**；两扩展各 **92 passed**；typecheck 全绿
