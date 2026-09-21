# Codex token budget + 硬上下文切换 对本插件的启示(修订版)

> 状态:调研修订版(2026-09-11),替代早期「token budget 提示做不了」的表述。
> 结论先行:Codex 的 token-budget compaction 是**默认关闭、账户后端限定**的客户端/
> 后端协同实验能力,不是任意 OpenAI-compatible API 能单独开启的通用参数。
> 对本插件(本地 llama.cpp + NInfer + Qwen3.8-27B + dsh),**预算编排与生命周期可在
> 插件侧完成;精确记账与容量数据仍需服务端/API 提供**。

## 1. Codex 在做什么(已核实事实)

| 事实 | 证据 | 判定 |
|---|---|---|
| `Feature::TokenBudget` 下,compaction 语义改为「新开 context window」:不请求服务端摘要,不把旧 user/assistant 消息带入下一请求 | [PR #29743](https://github.com/openai/codex/pull/29743)(merged 2026-06-23,body 描述原文)+ [compact_token_budget.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/compact_token_budget.rs)("skips model/server summarization and installs a fresh context window") | 已证实 |
| 该操作仍走 compaction 生命周期,compaction hook 与 `ContextCompaction` turn item 照常触发 | 同上 PR body 与源码 | 已证实 |
| `new_context` 是注册给模型的**客户端工具**,语义:「开始新窗口;不清除、不重置、不影响环境状态」 | [new_context_window_spec.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/new_context_window_spec.rs) | 已证实(host 侧能力,非模型 API 参数) |
| `get_context_remaining` 模型工具存在,返回宿主记账的剩余 token | [get_context_remaining.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/get_context_remaining.rs)(读 `base_window_tokens_remaining`) | 已证实;是「模型主动查询」的工具,不是每轮自动注入 |
| `history` / `notes` 工具(列窗口/条目、读、搜索;笔记追加/写)于 2026-08-21 合并 | [PR #39827](https://github.com/openai/codex/pull/39827) | 已证实;启用受 OpenAI provider + Codex backend 认证限定 |
| rust-v0.153.0(2026-09-03 发布)新增**默认关闭**的 `features.context_management.experimental_mode`;仅符合条件的 ChatGPT Plus/Pro/Pro Lite + Codex backend 会话获得 token-budget context、history notes、`new_context`;**API key 会话、自定义 provider、临时 structured threads 明确排除** | [release rust-v0.153.0](https://github.com/openai/codex/releases/tag/rust-v0.153.0) 正文(引用 PR #42385) | 已证实,逐字 |
| 动机:重复 compaction 使长任务「执行前沿」退化 | [issue #34095](https://github.com/openai/codex/issues/34095) | 用户报告观察(24 次 `compacted` 事件后收敛性下降);issue 正文自称「未证实 Ultra 单独致因」——**不能写为官方已确认根因** |
| atomic handoff 原语 | [issue #33310](https://github.com/openai/codex/issues/33310) | **开放 enhancement 提案** + 下游原型,非已实现能力 |

下载/部署斜杠:`rust-v0.153.0` 是 openai/codex 的发布标签;上表 URL 以仓库现状为准。

## 2. 插件侧可做 vs 需模型/API 支持

### 2.1 插件侧已实现/可近似

| 能力 | 形态 | 说明与差距 |
|---|---|---|
| 显式硬重置(断片) | `/clear-context`(**已实现**,零 LLM 调用) | 复用官方 `dsh-compaction-basic` 事务,摘要器换固定模板;与 `new_context`「不总结、丢可见历史、环境不变」语义一致;**但是用户手动命令,不是模型可调用工具** |
| 超大对话分片救援 | 已实现 | 与本文主题独立,保证小窗口模型压缩仍可用 |
| minimal 上下文预算管理(80% 预警 / 98% 自动压缩) | 设计确定,待实现 | 用 `tokenMeter.measure()` + 服务端硬限制预算,在 `agent/pre-step` 对 minimal 会话检查;见 [`minimal-context-budget.md`](./minimal-context-budget.md) |
| 近似预算提醒 | `agent.inject()` 注入 user 角色上下文 + 本地估算 | dsh 有 `agent.inject(message)` 与 `agent/pre-step`;但**无服务器端预算记账、无每轮自动注入钩子**——只能「本地估算 + 显式注入」的近似,不等价于 Codex `get_context_remaining` 的宿主记账;且注入必须满足 dsh「Model-visible ⟺ logged」约束(需对应 session 事件) |
| 历史检索 / 交接 note | 插件命令读 `session.v2.jsonl`(append-only,压缩只改 surface)+ 工作区文件 | 产品层替代;事件日志是原始档案,**不是** Codex `history.*` / `notes.*` 这种带后端检索、可跨窗口取回的模型工具 |

### 2.2 需模型/API(或宿主)支持,插件做不了

- **服务端 token-budget 记账与 context-window lineage**(响应元数据携带窗口/条目 ID,讨论见 [discussion #42703](https://github.com/openai/codex/discussions/42703))——本地 llama.cpp/NInfer 网关无此概念;
- `get_context_remaining` 式「模型主动查询真实剩余预算」工具——宿主无 `base_window_tokens_remaining` 记账;
- `new_context` 作为**模型可调用工具**(而非用户命令);
- `history.*` / `notes.*` 的跨窗口检索后端(旧窗口全文搜索、笔记持久化服务);
- 每轮自动注入「剩余预算」——dsh 无该自动钩子;`agent.inject()` 需显式触发且一次只排队到最近一个 pre-step;
- 精确 tokenizer 计数、真实上下文窗口 / 最大输出限制、输入输出与 cache usage、KV/prefix cache 复用——需服务端能力。

## 3. 早期文档需修正的表述

| 原文(2026-09-05 版) | 修正 |
|---|---|
| 「dsh 没有给插件的 per-request 上下文注入钩子,做不了(除非改 dsh 本体)」 | 不准确:dsh 有 `agent.inject()` 与 `agent/pre-step`。准确表述:**无服务器端预算记账、无每轮自动注入钩子;可做「本地估算 + 显式注入」的近似,非 Codex 记账** |
| 「`history.*` 的等价物其实已经存在(session.v2.jsonl 可查)」 | 过度断言:append-only 事件日志 ≠ 带后端检索/跨窗口取回的 `history.*` 模型工具;只能作为产品层替代/命令入口 |
| 「token budget 感知注入……做不了」 | 降级为「近似可做,不等价」 |
| 「24 次 compaction 后收敛性下降」作为已确认根因 | 降级为「用户报告观察,非已证实根因」 |
| history/notes「解决硬重置后怎么找回状态」作为通用事实 | 注明启用限定(OpenAI provider + Codex backend + feature 开关) |

## 4. 对本插件的落地优先级

1. **已落地**:`/clear-context`(硬重置)、分片救援、请求体改写。
2. **设计确定**:minimal 80% 预警 → 98% 自动摘要压缩(插件侧预算编排,服务端硬限制
   对齐:`378144 − 192000 − 18908 = 167236` 输入上限)。
3. **可选增强(标注启发式/有损)**:handoff-note(硬重置前只让模型基于最近一小段
   surface 写交接 note,一次廉价调用)。
4. **明确不做(第一版)**:把「剩余预算」注入每次普通对话请求——会改变模型可见上下文
   且破坏 Model-visible ⟺ logged 一致性,收益不稳定。

## 5. 参考链接

- [PR #29743 — reset context for token budget compaction](https://github.com/openai/codex/pull/29743)
- [compact_token_budget.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/compact_token_budget.rs)
- [new_context_window_spec.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/new_context_window_spec.rs)
- [get_context_remaining.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/get_context_remaining.rs)
- [PR #39827 — history and notes tools](https://github.com/openai/codex/pull/39827)
- [rust-v0.153.0 release](https://github.com/openai/codex/releases/tag/rust-v0.153.0)
- [issue #34095 — repeated auto-compaction degrades convergence](https://github.com/openai/codex/issues/34095)
- [issue #33310 — atomic handoff primitive (proposal)](https://github.com/openai/codex/issues/33310)
- [discussion #42703 — history retrieval 跨窗口语义](https://github.com/openai/codex/discussions/42703)

dsh 侧依据(仓库源码,公开 API 属 pre-stable,按版本核实):
`deepseek-harness/packages/core/agent/src/runtime-types.ts`(`agent.inject` /
`agent/session-start` / `agent/pre-step` / `agent/request`)。