# minimal preset 上下文预算与自动管理（终态记录）

> **状态（2026-09-19，v1.3.0 终态）**：本文档原设计的「80% 预警 / 98% 自动摘要压缩」
> 已由 **功能 6「自动压缩救援」（`autoCompaction`，默认开启）以等价/覆盖的方式落地**，
> 实现与设计有两处明确差异：
>
> | 原设计 | 实现终态 |
> |---|---|
> | 80% 预警（`floor(usableBudget × 0.8)`） | `agent/pre-step` 压力检查：输入达到 `thresholdRatio(默认 0.8) × 实际窗口` 时**提前压缩**（不阻塞、失败放行）。显式配置了 `contextWindows`（如 qwen3.8-27b → 167236）时数值与「80% × 可用输入预算」一致：0.8 × 167236 = 133788 |
> | 98% 自动摘要压缩（独立触发器） | **没有独立的 98% 触发器**。98% 区间由「网关报 400 `context_length_exceeded` → 自动压缩 → 重试」覆盖（每会话独立预算，默认 1 次） |
> | 仅 `agentPreset === "minimal"` 生效 | 扩大到**所有未挂内置压缩引擎的 preset**（含 minimal）；挂了 `dsh-compaction-basic` 引擎的 preset（standard/ptc/cordis）绝不干预，归属检测不确定时也按「有引擎」处理 |
> | `minimalContext:` 配置块 | **设计占位，代码不消费**（README 配置示例中已注明）。实际生效的键是 `autoCompaction.*`（enabled/thresholdRatio/retainRatio/retainTokens/maxTokens/compactionRetries/maxOverflowRetries）+ `chunking.contextWindows` |
>
> 实现细节见 README「功能 6：自动压缩救援」与 `docs/preset-applicability.md`；
> 原文档其余章节保留，作为设计依据与预算推导记录。

## 结论（设计时）

`minimal` preset 不加载 DSH 官方 `compaction-basic` 自动压缩引擎。插件设计为在 host 层
监听 `agent/pre-step`，用 token meter 在请求发出前计算输入压力，在配置阈值处预警或压缩。
（实现终态见文首状态块：压力预警已实现，且适用面扩到所有无内置引擎的 preset。）

## 服务端硬限制

目标 NInfer 服务端不是仅在 DSH settings 中声明容量，而是在服务端执行硬拒绝：

```text
contextWindow       = 378144
maxOutputTokens     = 192000
safetyMargin        = ceil(378144 × 0.05) = 18908
maxInputTokens      = 378144 - 192000 - 18908 = 167236
```

当请求输入超过 `167236` tokens，NInfer 直接返回 `context_length_exceeded`，
不会进入 GPU prefill，也不会继续到生成阶段。

因此插件必须在请求前按同一公式计算可用输入预算。服务端拒绝无法由客户端事后补救——
唯一的补救路径就是已实现的「400 → 压缩 → 重试」（每会话预算 1 次，防止压缩无效时
无限重试）。

## 预算公式（设计依据，数值仍有效）

```text
usableInputBudget = contextWindow
                  - maxOutputTokens
                  - ceil(contextWindow × safetyMarginRatio)

warningTokens     = floor(usableInputBudget × warningRatio)
autoCompactTokens = ceil(usableInputBudget × autoCompactRatio)
```

默认策略：

```text
warningRatio       = 0.80
autoCompactRatio   = 0.98
safetyMarginRatio  = 0.05
```

以目标 NInfer 服务为例：

```text
usableInputBudget  = 167236
80% warning        = floor(167236 × 0.80) = 133788 tokens   ← 实现中的压力预警点
98% 区间           = [133788, 167236)                       ← 实现中由 400 溢出恢复覆盖
```

80% 和 98% 是**可用输入预算**的比例，不是对 378144 完整上下文窗口的比例。

## 数据来源（实现终态）

插件解析「模型实际窗口」的优先级（窗口 = 预警/分片的基准）：

1. 插件设置/设置页的 `chunking.contextWindows`（模型 id → 窗口值）——最可信，显式声明；
2. 网关活查：`GET {gateway}/v1/models`（5min TTL）读取该模型声明的窗口与 maxOutput；
3. DSH 模型声明（settings.yaml 的 `llm-pi-ai.providers.<provider>.models[]`）；
4. 三者都拿不到 → 该模型的超大压缩/压力救援保持关闭，一次性 warn 说明原因（fail-open）。

显式建议（仍有效）：

```yaml
gateway-compaction:
  chunking:
    contextWindows:
      qwen3.8-27b: 167236   # = 378144 - 192000 - 18908，与服务端硬限制对齐
```

> README 配置示例中的 `minimalContext:` 块是**设计占位**，代码不读取；
> 不要依赖它，请配置 `chunking.contextWindows` 与 `autoCompaction.*`。
> 不要再用过时的 `369144` 窗口值。

## 自动动作（实现终态）

### 压力预警（设计中的「80% 预警」，已实现）

每个 `agent/pre-step` 检查点：会话路由模型的可信窗口已知、且该 preset 无内置压缩引擎时，
输入达到 `thresholdRatio × 窗口`（默认 0.8 × 167236 = 133788）→ 在发出下一请求前
先做一次压缩（走本插件 wire 层 + 分片救援）。全部失败时放行不阻塞（fail-open），
日志 `pressure compaction (rescue)`。

### 400 溢出恢复（覆盖原「98% 自动摘要压缩」）

请求被网关以 `context_length_exceeded`（400）拒绝时：若该会话仍有溢出重试预算
（`maxOverflowRetries`，默认 1）→ 压缩后让 agent loop 重发同一请求。
日志 `overflow recovery (rescue)`。每会话独立计数，新 assistant 消息后重置。

设计中的 6 步流程（检查可维护性 → 选可压缩区间 → wire 层 → 分片 → 提交 checkpoint →
失败不伪造成功）在实现中全部保留，且补充了：

- **绝不双压**：app 级 `compaction` 服务启用，或 preset 挂载了
  `@deepseek-ai/dsh-compaction-basic`（compositionInventory 扫描，30s TTL）→ 跳过；
  检测不确定时按「有引擎」处理。
- 救援引擎为**隔离实例**（`auto: false` 的 `BasicCompactionEngine`，detached ctx），
  绝不注册为 app 的 `compaction` 服务。
- 并发保护：同一会话的压缩事务互斥；失败不触发任何不可逆动作（hard reset 永远是手动命令）。

## 手动动作

| 命令 | 是否调用模型 | 信息保留 | 适用场景 |
|---|---:|---|---|
| `/gateway-compact` | 是 | 摘要尽量保留，但有损 | 希望继续保留对话任务状态 |
| `/clear-context` | 否 | 模型可见历史丢弃；原始事件日志保留 | 状态已在文件、git、数据库或外部环境中 |

两个命令对所有 preset（含 minimal）可用。`/gateway-compact` 需要
`dsh-compaction-basic` 包可解析；`/clear-context` 使用插件内固定模板摘要器，不调模型。

## 失败与边界

- 超过服务端硬限制后，请求可能已在发送时被拒绝；插件的补救是「压缩 + 重试」，
  每会话限 1 次（可配），重试仍 400 时把错误原样上抛，不循环。
- tokenizer 差异、工具内容、系统提示词、多模态内容可能使本地估算与网关计数不同；
  5% margin（体现在 167236 的推导里）用于降低风险，但不是协议保证。
- 配置错误（窗口 − 输出 − margin ≤ 0）时跳过自动动作并报告，不猜测。
- 自动摘要失败**不应也不得**自动执行 hard reset（`/clear-context` 是手动命令）。
- 全链路 fail-open：救援任何一步失败都不阻塞会话继续。

## 配置约束（设计时公式，实现按 schema 校验）

```text
0 < thresholdRatio <= 1
retainRatio 与 retainTokens 互斥（同时给则 retainTokens 生效），与引擎自身约束一致
contextWindow - maxOutputTokens - ceil(contextWindow × safetyMarginRatio) > 0
```

`thresholdRatio`、`maxOverflowRetries` 等已进设置页（「自动压缩救援」开关 + 高级参数）；
模型窗口用 `chunking.contextWindows`（设置页可改）。