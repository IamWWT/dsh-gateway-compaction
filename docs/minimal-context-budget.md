# minimal preset 上下文预算与自动管理

## 结论

`minimal` preset 不加载 DSH 官方 `compaction-basic` 自动压缩引擎。插件可以在 host 层监听 `agent/pre-step`，使用 token meter 在请求发出前计算输入压力，并在配置阈值处预警或压缩。

该策略只对当前 session 的 `agentPreset === "minimal"` 生效。`standard`、`ptc`、`cordis` 继续交给官方 compaction 引擎，插件不重复触发自动压缩。

## 服务端硬限制

目标 NInfer 服务端不是仅在 DSH settings 中声明容量，而是在服务端执行硬拒绝：

```text
contextWindow       = 378144
maxOutputTokens     = 192000
safetyMargin        = ceil(378144 × 0.05) = 18908
maxInputTokens      = 378144 - 192000 - 18908 = 167236
```

当请求输入超过 `167236` tokens，NInfer 直接返回 `context_length_exceeded`，不会进入 GPU prefill，也不会继续到生成阶段。

因此插件必须在请求前按同一公式计算可用输入预算。服务端拒绝无法由客户端事后补救。

## 预算公式

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
80% warning        = floor(167236 × 0.80) = 133788
98% auto-compaction = ceil(167236 × 0.98)  = 163892
```

80% 和 98% 是**可用输入预算**的比例，不是完整上下文窗口的比例。

## 数据来源

按可信度优先级：

1. 插件设置中的服务端硬限制覆盖；
2. 当前路由的 `llm.resolveModelInfo()`；
3. 模型级手工配置；
4. 没有可靠窗口或输出上限时，跳过自动动作并记录原因。

服务端有硬限制时，建议显式填写：

```yaml
minimalContext:
  contextWindows:
    qwen3.8-27b: 378144
  maxOutputTokens:
    qwen3.8-27b: 192000
```

不要继续使用已经过时的 `369144` 窗口值。

## 自动动作

### 80% 预警

在 minimal session 的每个 `agent/pre-step` 检查点计算输入 token 数。达到 `warningTokens` 后写入包含以下字段的结构化宿主日志：

- session id；
- provider/model；
- 当前输入 token 数；
- usable input budget；
- 百分比；
- 距离硬限制的剩余 token。

预警不改变 session surface，不向模型追加消息，不消耗推理 token。相同 session 在同一压力区间只报告一次，避免每轮刷屏。

### 98% 自动摘要压缩

达到 `autoCompactTokens` 后，在下一次模型请求前执行一次模型摘要压缩：

1. 检查 agent 是否仍可维护；
2. 选择可压缩的旧 surface 区间；
3. 使用现有压缩请求修复与 thinking-off wire 策略；
4. 历史过大时使用 chunked map-reduce；
5. 成功提交 checkpoint 后重新测量；
6. 失败时保持事务语义，不伪造成功。

自动策略不执行硬重置。若摘要压缩无法完成，用户仍可手动执行 `/qwen38-compact` 或 `/clear-context`。

## 手动动作

| 命令 | 是否调用模型 | 信息保留 | 适用场景 |
|---|---:|---|---|
| `/qwen38-compact` | 是 | 摘要尽量保留，但有损 | 希望继续保留对话任务状态 |
| `/clear-context` | 否 | 模型可见历史丢弃；原始事件日志保留 | 状态已在文件、git、数据库或外部环境中 |

两个命令在 minimal session 中都可以使用。`/qwen38-compact` 需要 `dsh-compaction-basic` 包可解析；`/clear-context` 使用插件内的固定摘要器，不需要模型调用。

## 失败与边界

- 超过服务端硬限制后，请求可能已在发送时被拒绝，插件不能追溯恢复该请求。
- tokenizer 差异、工具内容、系统提示词、多模态内容可能使本地估算与网关计数不同；5% margin 用于降低风险，但不是协议保证。
- `maxOutputTokens` 过大或窗口配置错误导致可用输入预算不为正时，必须跳过自动动作并报告配置错误。
- 自动摘要期间要有 per-session 并发保护，不能同时启动多个压缩事务。
- 自动摘要失败不应自动执行不可逆的 hard reset。

## 配置约束

```text
0 < warningRatio < autoCompactRatio <= 1
0 <= safetyMarginRatio < 1
contextWindow - maxOutputTokens - ceil(contextWindow × safetyMarginRatio) > 0
```

`warningRatio`、`autoCompactRatio`、`safetyMarginRatio`、context window 和最大输出都应支持设置页手动调整。默认值仍针对上面的 NInfer 服务端限制。
