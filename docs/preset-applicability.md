# 四个内置 preset 的适用性（代码级验证 + 1.3.0 终态）

> 结论一句话：**插件全部能力（请求改写 + 分片救援 + 手动命令 + 自动压缩救援）对四个
> 内置 preset 全部适用。**「自动压缩」本身按归属分工：`standard`/`ptc`/`cordis` 由
> preset 自带的官方 `compaction-basic` 引擎负责，插件**绝不干预**；`minimal` 等未挂
> 内置引擎的 preset 由插件的自动压缩救援引擎接管（压力预警 + 400 溢出恢复，功能 6，
> 1.2.0 起实现）。

验证日期：2026-09-09 · 对应版本：1.0.3 · 验证方式：代码路径核对 + 自动化测试
（`test/preset-applicability.mjs`，10 条断言）。
2026-09-19 复核（1.3.0）：自动压缩救援另由 `test/auto-rescue.mjs`（36 断言）与
`smoke.mjs` 覆盖；全部测试绿。

## 1. 内置 preset 一览

来源：`packages/preset/agent-presets/presets/`

| preset | 中文名 | 是否组装 `compaction-basic`(自动压缩引擎) | 依据 |
|---|---|---|---|
| `standard` | 标准模式 | ✅ | `standard/agent.cordis.yml` 的 compaction 段(`compaction-basic` + `compaction-tool-result-pruner`) |
| `ptc` | PTC 模式 | ✅ | `ptc/agent.cordis.yml` 同款 compaction 段 |
| `cordis` | 创造模式 | ✅ | `cordis/agent.cordis.yml` 同款 compaction 段 |
| `minimal` | 极简模式 | ❌ | `minimal/agent.cordis.yml` 顶部注释：*"Context compaction is absent."* |

另一个关键事实：四个 preset 的 `agent.cordis.yml` 里**都没有** `dsh-llm-pi-ai` /
`dsh-commands` / `dsh-token-meter` 行——模型路由、命令、token 计量都是 **host(profile)
层服务**。所以插件作为 profile 级 bundle，其钩子与所有 preset 无关。

## 2. 适用性矩阵（1.3.0 终态）

| 插件能力 | 实现层 | standard / ptc / cordis | minimal（及任何未挂内置引擎的 preset） |
|---|---|---|---|
| 压缩请求体改写（关思考 + 采样 + `max_tokens` 下限） | 进程级 `globalThis.fetch` 包装 | ✅ | ✅（标题/其他命中调用同样生效） |
| 引擎分流（`ninModels` 跳过 `chat_template_kwargs`） | 同上 | ✅ | ✅ |
| 超大对话分片 map-reduce 救援 | 同上 | ✅ | ✅（手动 `/gateway-compact` 路径同样可用） |
| 瀑布层 `reasoningEffort: off` 打标 | `ctx.on("llm/stream")` | ✅（有 compaction 调用可打标） | ✅（救援/手动压缩调用同样走该瀑布） |
| 手动命令 `/gateway-compact`、`/clear-context` | `ctx.inject(["commands","tokenMeter","sessions"])` | ✅ | ✅（插件自带引擎，不依赖 preset） |
| 自动压缩：压力预警（`thresholdRatio × 窗口`，默认 0.8） | `agent/pre-step` 监听（`registerAutoRescue`） | 不触发（preset 自带引擎，归属判定 → 跳过） | ✅ 接管（`builtInVerdict === "absent"` 才动作） |
| 自动压缩：400 溢出恢复（压缩 → 重试，每会话默认 1 次） | `agent/request-error` 监听（同上） | 不触发（同上） | ✅ 接管 |
| 自动压缩引擎本身 | preset 组装 / 插件救援引擎 | ✅ preset 自带官方引擎（插件绝不双压） | ✅ 插件的隔离救援引擎（`auto:false` 的 `BasicCompactionEngine`） |

归属判定（`decideBuiltInCompaction`）：app 级 `compaction` 服务启用 → 有引擎；否则扫
preset `compositionInventory()` 是否含 `@deepseek-ai/dsh-compaction-basic`（30s TTL 缓存）；
**不确定时按「有引擎」处理**——宁可漏救，绝不双压。

模型白名单是横切收口：只有 `models` 里的精确 id（默认 `Qwen3.8-27B-GGUF` /
settings.yaml 覆盖后的 `qwen3.8-27b` 等）才会被改写，其他模型逐字节透传。

## 3. 代码级证据

### 3.1 插件是 host 级，与 preset 无关

- 插件 host half 由 profile 的 `dsh.profile.bundles` 加载（profile 级，每个 dsh 实例一次）。
- 注册的东西（见 `index.js`）：
  - 进程级 fetch 包装：`installSamplingFetch` 包裹 `globalThis.fetch`；
  - 瀑布监听：`ctx.on("llm/stream", …)`（`reasoningEffort` 打标 + wire 层兜底）；
  - 手动命令：`ctx.inject(["commands","tokenMeter","sessions"], …)` 注册
    `/gateway-compact` 与 `/clear-context`；
  - 自动压缩救援：`registerAutoRescue` 注册 `agent/pre-step`（压力预警）与
    `agent/request-error`（400 溢出恢复）两个监听，入口经 `decideBuiltInCompaction`
    归属判定，仅在「无内置引擎」时动作。
- **插件从不注册 `compaction` 服务**：救援引擎是 detached 上下文中 `auto:false` 的
  官方引擎实例，不进入 preset 组装，所以对任何 preset 都不会"装上"一个第二压缩引擎。
- 护栏：`ctx.get` 不可用的旧 harness 上，自动救援整段自禁用（仅告警一次），手动命令
  与 wire 层不受影响。

### 3.2 fetch 包装为什么覆盖所有 preset / 所有会话

请求链：

1. `@earendil-works/pi-ai/dist/api/openai-completions.js:202` —— **每次 stream 都新建 client**，
   并透传 `options?.fetch`（未指定时为空）；
2. `openai/client.js:160` —— `this.fetch = options.fetch ?? Shims.getDefaultFetch()`；
3. `openai/internal/shims.js:9–14` —— `getDefaultFetch()` 返回**当时的全局 `fetch`**。

插件在启动早期就把 `globalThis.fetch` 换成包装器，因此此后构造的每个 OpenAI 兼容客户端
都拿的是包装器 → 与 preset、会话、子代理无关。**运行时实证**：aiops 会话切到 NInfer 后，
56 次压缩调用全部被写入了 `chat_template_kwargs.enable_thinking`（NInfer 400
`chat_template_option_not_supported`）——这正是 fetch 层在真实链路里生效的证据
（该 preset 未声明 `ninModels`，即修复前的误配场景）。

### 3.3 为什么 minimal 里也能手动/自动压缩

`ctx.inject(["commands","tokenMeter","sessions"], cb)` 依赖的是 host 服务，四个 preset
都不组装它们（所以一定来自 host）。回调里注册的是两个**全局命令**；`/gateway-compact`
的处理链路由插件自行构造引擎（`dsh-compaction-basic` 的事务实现）并对 min/max 会话都可
使用，`/clear-context` 完全不做 LLM 调用。代码注释也明确了这一意图
（"makes the commands visible to every session — including minimal-preset …"）。
自动压缩救援同理：引擎实例由插件自己构建并托管在隔离上下文，preset 不需要声明任何
compaction 能力。

## 4. 自动化验证

`test/preset-applicability.mjs`（10 断言）全部通过，覆盖：

1. minimal 形状（无 `compaction` 服务、无 `ctx.get`）apply：插件不抛错，**只注册
   `llm/stream` 瀑布**（auto-rescue 因 `ctx.get` 缺失自禁用）——证明不注入压缩引擎；
2. 同一形状下手动命令仍注册（`/gateway-compact` / `/clear-context`）；
3. 命令注册依赖的是 host 服务注入，而非 preset 组装；
4. `globalThis.fetch` 被替换（进程级）；
5. 允许模型的压缩请求体被改写（NInfer：有 `reasoning_effort: none`、**无**
   `chat_template_kwargs`；`max_tokens` 抬到下限；采样写入）——全程无任何压缩引擎；
6. 白名单外的模型逐字节透传；
7. llama.cpp 模型保留自己的字段（`chat_template_kwargs.enable_thinking: false` +
   `reasoning_effort`）——引擎分流正确；
8. compaction purpose 调用在模型声明了 `off` 时被打上 `reasoningEffort: "off"`；
9. 非 compaction 调用原样透传（不做全局关思考）；
10. 未声明 effort 的模型保持默认（此时仍有 wire 层兜底）。

自动压缩救援由 `test/auto-rescue.mjs`（36 断言）专项覆盖：`decideBuiltInCompaction`
全部分支（app 级引擎 / preset 引擎 / 无引擎 / 检测不确定 / ctx.get 缺失）、
`patchModelInfoWindows` 纯函数语义（declared < 配置值时保留 declared，防硬件超窗）、
`autoCompactionEngineConfig` 配置段映射与回退。
其余相关：`smoke.mjs`（门控/切片/命令注册，58 断言）、`integration-fetch.mjs`
（端到端 fetch 改写）、`rescue-e2e.mjs`（分片救援）、`window-resolution.mjs`
（窗口解析优先级）、`client-smoke.mjs`（设置卡片）、`prompt-sync.mjs`（提示词展示同步）。

## 5. minimal 自动上下文管理（已实现 = 功能 6「自动压缩救援」）

原设计（见 `minimal-context-budget.md`：仅 minimal、80% 预警 + 98% 独立触发、
`minimalContext:` 配置块）的**落地形态**：

- 监听 `agent/pre-step`：输入达到 `thresholdRatio(0.8) × 实际窗口` 且该 preset 无内置
  引擎时，在下一请求发出前压缩（日志 `pressure compaction (rescue)`）；
- 监听 `agent/request-error`：网关 400 `context_length_exceeded` → 压缩 → 重发
  （每会话预算 `maxOverflowRetries`，默认 1，新 assistant 消息后重置；日志
  `overflow recovery (rescue)`）——原设计「98% 触发器」由该路径覆盖；
- 窗口解析：设置页/`chunking.contextWindows` > 网关 `/v1/models` 活查（5min TTL）>
  DSH 声明；全无则 fail-open + 一次性 warn；
- 归属判定 `decideBuiltInCompaction`：app 级 `compaction` 服务 → 有引擎；否则 preset
  `compositionInventory()` 扫描（30s TTL）；不确定按「有引擎」；
- 失败语义：任何救援失败都放行（fail-open），绝不触发硬重置（那是手动命令
  `/clear-context` 的职责）。

与设计原文的差异（实现者注）：适用面从「仅 minimal」扩到「所有无内置引擎 preset」；
98% 独立触发器未实现（由 400 恢复覆盖）；`minimalContext:` 配置块保持设计占位，
实际键为 `autoCompaction.*`。

## 6. 边界与注意

- **自动压缩的归属**：standard / ptc / cordis 由 preset 自带官方引擎负责（插件零干预，
  验收标准即「standard 会话行为零变化」）；minimal 等无引擎 preset 由插件救援引擎接管。
  用户手动兜底永远是 `/gateway-compact`（有损保信息）或 `/clear-context`（秒级硬重置）。
- **模型白名单**：新增 NInfer 模型 id 时要同时进 `models` 和 `ninModels`，否则要么不生效、
  要么会对 NInfer 误发 `chat_template_kwargs`（400）。
- **子代理**：子代理调用走同一进程/同一 fetch，因此同样被覆盖（前提是模型 id 命中白名单）。
- **其他模型/其他 provider**：逐字节透传，不会因本插件改变任何请求。
- **分片救援**需要 `chunking.contextWindows[model]` 填对网关实际窗口；未填的模型 fail-open
  （退回单次调用，不救援也不破坏）。
- **自动救援是新增监听，不与官方 compaction 冲突**：对已挂引擎的 preset 无触发、无日志、
  无额外压缩（归属判定先行）。
- **服务端硬限制**：NInfer 超过 `167236` 输入 token 直接 `context_length_exceeded`，
  插件预算计算必须与服务端一致（见 `minimal-context-budget.md`）。