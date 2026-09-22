# 四个内置 preset 的适用性(代码级验证)

> 结论一句话:**插件本体(改写 + 分片救援 + 手动命令)对四个内置 preset 全部适用;
> "自动压缩"本身是 preset 提供的,极简模式(`minimal`)没有,插件不会替它装。**
> **新增**:minimal 专用「80% 预警 / 98% 自动压缩」设计已确定,待实现后仅对
> `minimal` 生效,不影响其余 preset 的官方自动压缩。

验证日期:2026-09-09 · 对应版本:1.0.3 · 验证方式:代码路径核对 + 自动化测试
(`test/preset-applicability.mjs`,10 条断言)。minimal 自动管理为后续版本设计,见
[`minimal-context-budget.md`](./minimal-context-budget.md)。

## 1. 内置 preset 一览

来源:`packages/preset/agent-presets/presets/`

| preset | 中文名 | 是否组装 `compaction-basic`(自动压缩引擎) | 依据 |
|---|---|---|---|
| `standard` | 标准模式 | ✅ | `standard/agent.cordis.yml` 的 compaction 段(`compaction-basic` + `compaction-tool-result-pruner`) |
| `ptc` | PTC 模式 | ✅ | `ptc/agent.cordis.yml` 同款 compaction 段 |
| `cordis` | 创造模式 | ✅ | `cordis/agent.cordis.yml` 同款 compaction 段 |
| `minimal` | 极简模式 | ❌ | `minimal/agent.cordis.yml` 顶部注释:*"Context compaction is absent."* |

另一个关键事实:四个 preset 的 `agent.cordis.yml` 里**都没有** `dsh-llm-pi-ai` /
`dsh-commands` / `dsh-token-meter` 行——模型路由、命令、token 计量都是 **host(profile)
层服务**。所以插件作为 profile 级 bundle,其钩子与所有 preset 无关。

## 2. 适用性矩阵

| 插件能力 | 实现层 | standard / ptc / cordis | minimal |
|---|---|---|---|
| 压缩请求体改写(关思考 + 采样 + `max_tokens` 下限) | 进程级 `globalThis.fetch` 包装 | ✅ | ✅(标题/其他命中调用同样生效;**但无自动压缩可救**) |
| 引擎分流(`ninModels` 跳过 `chat_template_kwargs`) | 同上 | ✅ | ✅ |
| 超大对话分片 map-reduce 救援 | 同上 | ✅ | ✅(手动 `/gateway-compact` 路径) |
| 瀑布层 `reasoningEffort: off` 打标 | `ctx.on("llm/stream")` | ✅(有 compaction 调用可打标) | —(没有 compaction 调用) |
| 手动命令 `/gateway-compact`、`/clear-context` | `ctx.inject(["commands","tokenMeter","sessions"])` | ✅ | ✅(插件自带引擎,不依赖 preset) |
| 自动压缩本身 | preset 组装 | ✅ | ❌(插件不注入) |
| **minimal 自动上下文管理(80% 预警 / 98% 压缩)** | `agent/pre-step` + tokenMeter | **不适用(不触发)** | **设计确定,待实现** |

模型白名单是横切收口:只有 `models` 里的精确 id(默认 `Qwen3.8-27B-GGUF` /
settings.yaml 覆盖后的 `qwen3.8-27b` 等)才会被改写,其他模型逐字节透传。

## 3. 代码级证据

### 3.1 插件是 host 级,与 preset 无关

- 插件 host half 由 profile 的 `dsh.profile.bundles` 加载(profile 级,每个 dsh 实例一次)。
- 只注册四类东西(见 `index.js`):
  - 进程级 fetch 包装:`installSamplingFetch` 包裹 `globalThis.fetch`(`index.js:1132–1191`);
  - 一个瀑布监听:`ctx.on("llm/stream", ...)`(`index.js:1521`);
  - 手动命令:`ctx.inject(["commands","tokenMeter","sessions"], ...)`(`index.js:1371`);
  - **minimal 自动管理监听(待实现)**:`agent/pre-step` + `tokenMeter.measure`。
- **没有任何自动压缩引擎注册**:插件不组装 `compaction-basic`、不注册 step 钩子,所以
  minimal 里"到期自动压缩"依旧不存在(与官方行为一致)。minimal 自动管理把「到期
  自动压缩」以独立、仅 minimal 的监听补充进来,见下文第 5 节。

### 3.2 fetch 包装为什么覆盖所有 preset / 所有会话

请求链:

1. `@earendil-works/pi-ai/dist/api/openai-completions.js:202` —— **每次 stream 都新建 client**,
   并透传 `options?.fetch`(未指定时为空);
2. `openai/client.js:160` —— `this.fetch = options.fetch ?? Shims.getDefaultFetch()`;
3. `openai/internal/shims.js:9–14` —— `getDefaultFetch()` 返回**当时的全局 `fetch`**。

插件在启动早期就把 `globalThis.fetch` 换成包装器,因此此后构造的每个 OpenAI 兼容客户端
都拿的是包装器 → 与 preset、会话、子代理无关。**运行时实证**:aiops 会话切到 NInfer 后,
56 次压缩调用全部被写入了 `chat_template_kwargs.enable_thinking`(NInfer 400
`chat_template_option_not_supported`)——这正是 fetch 层在真实链路里生效的证据
(该 preset 未声明 `ninModels`,即修复前的误配场景)。

### 3.3 为什么 minimal 里也能手动压缩

`ctx.inject(["commands","tokenMeter","sessions"], cb)` 依赖的是 host 服务,四个 preset
都不组装它们(所以一定来自 host)。回调里注册的是两个**全局命令**;`/gateway-compact`
的处理链路由插件自行构造引擎(`dsh-compaction-basic` 的事务实现)并对 min/max 会话都可
使用,`/clear-context` 完全不做 LLM 调用。代码注释也明确了这一意图
(`index.js:1313–1318`:"makes the commands visible to every session — including
minimal-preset …")。

## 4. 自动化验证(`test/preset-applicability.mjs`)

`npm`/`node test/preset-applicability.mjs` 10 条断言全过,覆盖:

1. 以 minimal 形状(无 compaction 服务)apply:插件不抛错,且**只注册 `llm/stream`**
   ——证明"不注入自动压缩";
2. 同一形状下手动命令仍注册(`gateway-compact` / `clear-context`);
3. 命令注册依赖的是 host 服务注入,而非 preset 组装;
4. `globalThis.fetch` 被替换(进程级);
5. 允许模型的压缩请求体被改写(NInfer:有 `reasoning_effort: none`、**无**
   `chat_template_kwargs`;`max_tokens` 抬到下限;采样写入)——**全程没有任何压缩引擎**;
6. 白名单之外的模型逐字节透传;
7. llama.cpp 模型保留自己的字段(`chat_template_kwargs.enable_thinking: false` +
   `reasoning_effort`)——引擎分流正确;
8. compaction purpose 调用在模型声明了 `off` 时被打上 `reasoningEffort: "off"`;
9. 非 compaction 调用原样透传(不做全局关思考);
10. 未声明 effort 的模型保持默认(此时仍有 wire 层兜底)。

其余相关测试:`smoke.mjs`(门控/切片/命令注册)、`integration-fetch.mjs`(端到端 fetch
改写)、`rescue-e2e.mjs`(分片救援)、`client-smoke.mjs`(设置卡片)。

## 5. minimal 自动上下文管理(设计,待实现)

目标:minimal preset 下,在模型请求**发出前**按服务端硬限制计算可用输入预算,
80% 预警、98% 自动摘要压缩。详见 [`minimal-context-budget.md`](./minimal-context-budget.md)。

要点:

- 挂 `agent/pre-step`,用 `tokenMeter.measure(agent.session)` 取真实输入压力;
- 只用 `agentPreset === "minimal"` 的 session;其余 preset 直接 `next()` 透传;
- 预算 = `contextWindow − maxOutputTokens − ceil(contextWindow × safetyMarginRatio)`;
- 无法取得可信窗口/输出上限时不自动动作,记原因;
- 98% 压缩复用现有 compaction 事务与 wire 层;失败保持事务语义,不伪造成功;
- 不做自动 hard reset(该命令是明确的手动操作)。

实现后新增测试:`test/minimal-auto-context.mjs`(preset 门控、阈值边界、去重/冷却、
并发保护、成功压缩、失败回退、非-minimal 透传)。

## 6. 边界与注意

- **自动压缩只属于 standard / ptc / cordis 或 minimal 自动管理**;minimal 会话在
  自动管理实现前,要压缩请用 `/gateway-compact`(有损保信息)或
  `/clear-context`(秒级硬重置)。
- **模型白名单**:新增 NInfer 模型 id 时要同时进 `models` 和 `ninModels`,否则要么不生效、
  要么会对 NInfer 误发 `chat_template_kwargs`(400)。
- **子代理**:子代理调用走同一进程/同一 fetch,因此同样被覆盖(前提是模型 id 命中白名单)。
- **其他模型/其他 provider**:逐字节透传,不会因本插件改变任何请求。
- 分片救援需要 `chunking.contextWindows[model]` 填对网关实际窗口;未填的模型 fail-open
  (退回单次调用,不救援也不破坏)。
- **minimal 自动管理是新增监听,不与官方 compaction 冲突**:对其他 preset 无注册、无触发。
- **服务端硬限制**:NInfer 超过 `167236` 输入 token 直接 `context_length_exceeded`,
  插件预算计算必须与服务端一致(见 `minimal-context-budget.md`)。