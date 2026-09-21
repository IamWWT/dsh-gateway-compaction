# Qwen3.8 网关压缩与上下文管理插件

`dsh-qwen38-gateway-compaction` 是 DeepSeek Harness（DSH）插件，面向本地 Qwen3.8 模型网关，支持 llama.cpp / Unsloth Studio 与 NInfer。

GitHub 默认展示本文档。英文文档见 [`README.en.md`](./README.en.md)。

## 当前能力

| 能力 | 状态 | 作用 |
|---|---|---|
| 压缩辅助调用关闭 thinking | 已实现 | 仅处理匹配模型的 compaction 请求，不改变普通对话 |
| 会话标题关闭 thinking | 已实现 | 避免标题调用的短输出预算被 reasoning 消耗 |
| llama.cpp / NInfer wire 字段分流 | 已实现 | NInfer 不发送其不支持的 `chat_template_kwargs` |
| 压缩采样参数与 `max_tokens` 下限 | 已实现 | 避免客户端钳制把摘要输出预算压到极低 |
| 超大对话分片 map-reduce 救援 | 已实现 | 处理大上下文模型切换到小上下文模型后的压缩溢出 |
| `/qwen38-compact` | 已实现 | 手动调用模型生成摘要检查点 |
| `/clear-context` | 已实现 | 手动丢弃模型可见历史，零 LLM 调用地开启新窗口 |
| 设置页展示压缩提示词（只读） | 已实现 | 主压缩指令（dsh-compaction-basic）、补充规则、分片合并前言在设置页可见 |
| 压缩提示词优化（补充规则 + 合并前言） | 已实现 | 主指令后追加 6 条补充规则（近期加权/逐字保真/进行中任务/冲突取最新/按会话语言/不虚构）；分片合并换成显式合并规则；补充规则可开关 |
| 自动压缩救援（无内置引擎兜底） | 已实现 | preset 未挂内置压缩引擎时：上下文达阈值(默认 0.8×窗口)提前压缩；网关报上下文溢出(400)时自动压缩并重试(默认 1 次)。已挂 `dsh-compaction-basic` 的 preset(如 standard)一律不干预，检测不确定时也按「有引擎」处理，绝不双重压缩 |
| minimal 80% 预警 / 98% 自动压缩 | 已实现（并入上一行） | 80% 预警 = `thresholdRatio 0.8 × 窗口`（窗口 167236 → 133788）；98% 区间的自动压缩由「溢出→压缩→重试」覆盖，见「功能 6」 |

## 服务端硬限制

本插件的上下文预算必须与 NInfer 服务端的硬限制保持一致。当前目标服务配置为：

```text
上下文窗口:       378144 tokens
默认最大输出:     192000 tokens
安全余量:         ceil(378144 × 5%) = 18908 tokens
最大输入:         378144 - 192000 - 18908 = 167236 tokens
```

超过 `167236` 输入 token 的请求由 NInfer 直接返回：

```text
context_length_exceeded
```

该请求不会进入 GPU prefill，也不会继续到后续生成阶段。因此，客户端不能等到服务端报错后再处理，必须在发出请求前按同一预算计算上下文压力。

## minimal preset 的上下文策略

`minimal` preset 不组装 DSH 官方 `compaction-basic` 自动压缩引擎。插件在不修改 DSH 源码的前提下增加兜底策略——2026-09-19 起已落地为通用的「自动压缩救援」（见下文「功能 6」）：适用于**任何**未挂载内置压缩引擎的 preset（不止 minimal），压力预警按「阈值 × 实际窗口」、溢出恢复按「网关 400 → 压缩 → 重试」。下面保留原始预算设计供参考：

```text
usableInputBudget = contextWindow
                   - maxOutputTokens
                   - ceil(contextWindow × safetyMarginRatio)

warningTokens      = floor(usableInputBudget × warningRatio)
autoCompactTokens  = ceil(usableInputBudget × autoCompactRatio)
```

默认策略：

```text
contextWindow      = 378144
maxOutputTokens    = 192000
safetyMarginRatio  = 0.05
usableInputBudget  = 167236
warningRatio       = 0.80
autoCompactRatio   = 0.98
```

因此：

```text
80% 预警       = floor(167236 × 0.80) = 133788 tokens
98% 自动压缩   = ceil(167236 × 0.98)  = 163892 tokens
```

这里的 80% 和 98% 是对**最大输入预算**的比例，不是对 378144 完整上下文窗口的比例。

### 自动与手动行为

| 操作 | 触发方式 | 适用范围 | 是否调用 LLM | 效果 | 前提 |
|---|---|---|---:|---|---|
| 80% 预警 | minimal 每轮开始前自动检查 | 仅 minimal | 否 | 记录当前输入 token、预算与剩余空间；不改变会话 | 能获得可信 token 计量与模型窗口 |
| 98% 自动摘要压缩 | minimal 每轮开始前自动检查 | 仅 minimal | 是 | 总结旧历史为 checkpoint，保留近期上下文；超大输入走分片 | compaction engine 可加载，agent 当前可维护 |
| `/qwen38-compact` | 用户手动输入命令 | 所有 preset，包括 minimal | 是 | 有损但尽量保留信息的摘要压缩 | 插件命令启用，agent 空闲，可解析 `dsh-compaction-basic` |
| `/clear-context` | 用户手动输入命令 | 所有 preset，包括 minimal | 否 | 秒级开启新模型可见窗口；旧可见历史丢弃，原始事件日志保留 | agent 空闲且存在可重置历史 |

自动策略不会自动执行硬重置。硬重置会丢弃模型可见历史，保留给用户明确手动确认。

> 注：2026-09-19 起，上表的「80% 预警」与「98% 自动摘要压缩」已由「功能 6：自动压缩救援」实现——预警阈值 = `thresholdRatio(默认 0.8) × 窗口`；98% 区间由「网关报溢出 → 自动压缩 → 重试」覆盖。适用面从 minimal 扩展到任何未挂内置压缩引擎的 preset。

### 预算来源优先级

1. 当前模型服务端实际限制的插件设置覆盖；
2. DSH `resolveModelInfo()` 返回的 `context.contextWindow` 与 `defaultMaxTokens`；
3. 模型级手工配置；
4. 如果无法取得可信窗口或输出上限，则不自动压缩，并记录原因。

对于当前 NInfer 模型，建议显式配置 `378144` 与 `192000`，不要继续使用旧的 `369144` 窗口值。

## 已实现功能详解

### 1. 压缩请求修复

对允许列表中的模型，插件可以在压缩和标题辅助请求中：

- 关闭 thinking；
- 写入 `reasoning_effort`；
- 写入非 thinking 采样参数；
- 将压缩请求的输出上限抬到配置的最低值；
- 保持白名单外的请求原样透传。

网关差异：

| 网关 | thinking 关闭方式 |
|---|---|
| llama.cpp / Unsloth Studio | `chat_template_kwargs.enable_thinking: false` + `reasoning_effort` |
| NInfer | 仅 `reasoning_effort`；不发送 `chat_template_kwargs` |

### 2. 超大对话分片救援

当会话曾经使用大上下文模型，后来切换到较小上下文模型时，单次摘要请求可能无法容纳全部历史。插件会在满足安全条件时：

1. 将历史分成连续片段；
2. 分别生成局部摘要；
3. 合并局部摘要；
4. 把最终结果交给 DSH 作为摘要检查点。

无法安全解析、模型窗口未知、分片超过上限或中途失败时，插件 fail-open，不伪造成功结果。

### 3. `/qwen38-compact`

这是模型摘要压缩。它会把当前可压缩历史替换为摘要检查点，尽量保留任务信息，但摘要本身仍然是有损的，并且本地 27B 模型可能耗时较长。

### 4. `/clear-context`

这是 Codex hard-rollover 思路的本地手动版本：不调用模型，使用固定短标记替换当前模型可见 surface。原始 session 事件日志仍保留在磁盘，文件、git、运行中的服务和外部状态不受影响。

适合任务状态已经写入代码、文件、git 或数据库的场景。不适合必须依赖完整对话上下文才能继续的问答任务。

### 5. 设置页展示压缩提示词

压缩质量由发给模型的提示词决定，此前这些文本散落在 harness 源码与插件代码里、设置页完全看不到。现在设置页（插件配置卡片 / 插件面板页，两个入口一致）新增「压缩提示词（只读展示）」折叠区，共三段：

- **主压缩指令**：来自 dsh 官方压缩组件 `dsh-compaction-basic`（harness 源码），页面显示其参考副本（标注来源与 harness 版本）；每次压缩本插件都会校验其首行，与当前 harness 不一致时告警。
- **补充规则**（本插件提供，可开关，默认开启）：追加在主指令之后的 6 条规则，针对官方指令在长会话上的实测弱点——① 近期加权（越近的对话越重要，旧内容更激进地压缩）；② 逐字保真（路径/命令/端口/数值/标识符/错误串不转述）；③ 进行中任务写清「已完成/剩余/下一步」；④ 冲突取最新（旧值只在变更本身有意义时保留）；⑤ 按会话主语言输出（覆盖官方「英文行文」规则，代码/路径/标识符保持原文）；⑥ 不虚构（空段落写 "(none)"）。设计参考 agentscope 系压缩/记忆整理提示词与本插件分片救援的实测问题。单次压缩、分片救援的每一片与最终合并都会带上；关闭开关后只发官方主指令。
- **分片合并前言**：本插件在触发分片救援时补的固定前言，含显式合并规则（后片优先 / 去重 / 事实并集 / Current Work 与 Next Step 取最后一片 / 不丢段落），同样只读展示。

提示词展示区只读不可编辑：要修改提示词内容需改 harness / 插件源码（插件侧文本由 `test/prompt-sync.mjs` 守卫，与 host 实际下发的文本保持逐字一致）。

### 6. 自动压缩救援（无内置压缩引擎兜底）

部分 preset（如 `minimal`）不挂载 DSH 官方压缩引擎 `dsh-compaction-basic`：这类会话的上下文压力无人处理，一旦网关报 `context_length_exceeded`（400），整轮对话直接失败。本功能给这些 preset 一个兜底恢复路径，**有内置引擎的 preset 一律不干预**（standard 等挂有 `dsh-compaction-basic` 的 preset 行为完全不变，这是验收标准之一）：

- **压力预警**：每轮开始前，用插件自己的压缩引擎（`auto: false` 实例，只按插件指令驱动）检查上下文是否达到 `thresholdRatio × 窗口`（默认 0.8；窗口优先取「上下文窗口」设置，缺失时自动解析）。达到即提前压缩，把压力消化在网关报错之前。
- **溢出恢复**：网关返回上下文溢出（`context_length_exceeded` / 400）时，先压缩再原样重试；每个会话的重试次数受 `maxOverflowRetries` 限制（默认 1），防止 400 死循环。
- **归属判定（绝不双压）**：救援只作用于「确实没有内置引擎」的 preset——先看 app 级 `compaction` 服务是否启用，再看该 preset 的组件清单是否挂载 `@deepseek-ai/dsh-compaction-basic`；任何一步检测不确定，一律按「有引擎」处理（宁可漏救、保留 400 原样上报，绝不在已有引擎之上再压一次烧 GPU）。
- **失败开放**：所有守卫分支异常时都原样放行事件；救援摘要走本插件的 wire 层（自动带上 thinking-off 与采样参数），摘要调用本身若仍溢出则按分片救援再切。

设置（全部可选，缺省即默认行为；在设置页「自动压缩救援」开关与高级参数中调整）：

```yaml
qwen38-gateway-compaction:
  autoCompaction:
    enabled: true        # 默认 true；false 完全关闭本功能
    thresholdRatio: 0.8  # 预警阈值（对实际窗口）
    # retainRatio: 0.16      # 压缩后保留的近期窗口占比（与 retainTokens 二选一，后者优先）
    # retainTokens: 2000     # 或保留固定 token 数
    # summarizationProvider: ""  # 留空 = 继承会话模型
    # summarizationModel: ""
    # maxTokens: 8192        # 摘要输出上限
    # compactionRetries: 1
    # maxOverflowRetries: 1
```

## 配置示例

配置文件：`$DSH_HOME/settings.yaml`；开发 profile 通常是 `~/.dsh-dev/settings.yaml`。

```yaml
qwen38-gateway-compaction:
  models:
    - Qwen3.8-27B-GGUF
    - qwen3.8-27b

  ninModels:
    - qwen3.8-27b

  maxTokensFloor: 16384
  wireReasoning: none
  enableThinkingOff: true

  chunking:
    enabled: true
    contextWindows:
      Qwen3.8-27B-GGUF: 262144
      qwen3.8-27b: 378144
    chunkRatio: 0.7
    chunkMaxTokens: 8192
    mergeMaxTokens: 16384
    maxChunks: 8

  # 设计占位（未实现）：minimal 专用预算策略；实际兜底能力由下面的 autoCompaction 提供（功能 6）。
  minimalContext:
    enabled: true
    warningRatio: 0.8
    autoCompactRatio: 0.98
    safetyMarginRatio: 0.05
    contextWindows:
      qwen3.8-27b: 378144
    maxOutputTokens:
      qwen3.8-27b: 192000

  command:
    enabled: true
    newContext:
      enabled: true

  # 自动压缩救援（默认开启；缺省整段即可，全部取默认值）
  autoCompaction:
    enabled: true
    thresholdRatio: 0.8
    # retainRatio: 0.16
    # summarizationProvider: ""
    # summarizationModel: ""
    # maxTokens: 8192
    # compactionRetries: 1
    # maxOverflowRetries: 1
```

`warningRatio`、`autoCompactRatio`、`safetyMarginRatio` 与模型级窗口/最大输出配置应在设置页可调。要求：

```text
0 < warningRatio < autoCompactRatio <= 1
0 <= safetyMarginRatio < 1
contextWindow - maxOutputTokens - ceil(contextWindow × safetyMarginRatio) > 0
```

## 安装

```sh
dsh-dev plugin --profile web add \
  /home/wwt/Downloads/aigc/proj/deepseek/dsh-plugins/dsh-qwen38-gateway-compaction
```

安装或升级后重启开发服务：

```sh
systemctl --user restart dsh-dev-web
```

卸载：

```sh
dsh-dev plugin --profile web rm dsh-qwen38-gateway-compaction
```

## Codex token budget 对本插件的启示

Codex 的 token-budget compaction 不是普通模型 API 参数，而是客户端/后端协同能力：在必要时直接开启新 context window，而不是请求模型总结全部旧历史。

本插件可以在插件侧完成：

- 预算计算；
- 提前预警；
- minimal 专用自动摘要；
- 手动硬重置；
- 原始事件日志保留。

模型或服务端仍需提供：

- 精确 tokenizer 计数；
- 真实上下文窗口与最大输出限制；
- 输入、输出、缓存 token usage；
- KV/prefix cache 能力。

因此最稳妥的路线是：**预算与生命周期由插件编排，容量与精确 token 数据由服务端/API 提供**。不建议第一版把“剩余预算”强行注入每次普通对话请求。

详见：

- [`docs/preset-applicability.md`](./docs/preset-applicability.md)
- [`docs/minimal-context-budget.md`](./docs/minimal-context-budget.md)
- [`docs/codex-token-budget-hard-rollover.md`](./docs/codex-token-budget-hard-rollover.md)

## 测试

```sh
node test/smoke.mjs
node test/integration-fetch.mjs
node test/preset-applicability.mjs
node test/rescue-e2e.mjs
node test/client-smoke.mjs
node test/auto-rescue.mjs
node test/prompt-sync.mjs
```

## License

MIT，见 [`LICENSE`](./LICENSE)。