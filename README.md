# 本地网关压缩与上下文管理插件（dsh-gateway-compaction）

**一句话定位**：面向本地模型网关（llama.cpp / Unsloth Studio、NInfer）的 DSH **上下文压缩与预算管理**插件，
默认面向 **Qwen3.8-27B GGUF**；在不改 DSH 上游源码的前提下，补齐「压缩请求修复 + 分片救援 + 自动压缩兜底 + 手动硬重置」。

英文文档见 [`README.en.md`](./README.en.md)。

## 当前能力

| 能力 | 作用 |
|---|---|
| 压缩辅助调用关闭 thinking | 仅处理匹配模型的 compaction 请求，不改变普通对话 |
| 会话标题关闭 thinking | 避免标题调用的短输出预算被 reasoning 消耗 |
| llama.cpp / NInfer wire 字段分流 | llama.cpp 走 `chat_template_kwargs.enable_thinking:false` + `reasoning_effort`；NInfer 只发 `reasoning_effort` |
| 压缩采样参数与 `max_tokens` 下限 | `maxTokensFloor` 抬升压缩请求输出上限，避免被客户端钳制 |
| 超大对话分片 map-reduce 救援 | 分片 → 局部摘要 → 合并 → 交给 DSH 作摘要检查点；无法安全解析/窗口未知/超过上限/中途失败时 **fail-open**，不伪造成功 |
| `/gateway-compact` | 手动摘要压缩（有损，本地 27B 可能耗时较长） |
| `/clear-context` | 零 LLM 调用的硬重置：丢弃模型可见历史开启新窗口；原始 session 事件日志仍在磁盘 |
| 设置页只读展示压缩提示词 | 主压缩指令（`dsh-compaction-basic` 参考副本，每次压缩校验首行）+ 可开关的 6 条补充规则 + 分片合并前言 |
| **自动压缩救援**（无内置引擎兜底） | 未挂 `dsh-compaction-basic` 的 preset（如 `minimal`）：达 `thresholdRatio × 窗口`（默认 0.8）提前压缩；网关报上下文溢出（400）时压缩后重试（`maxOverflowRetries` 默认 1）。已挂内置引擎的 preset（如 `standard`）**一律不干预**，检测不确定时按「有引擎」处理，绝不双重压缩 |

- 提示词与控制台卡片：压缩提示词只读不可编辑；客户端设置卡片在 1.3.1 完成 harness 0.1.7 原生适配
  （插件行 `Config` 字段全部 `.volatile()`；客户端由退役的 `settingsScope` 改为经 `ctx.configForms`）。
- **适用模型**：`Qwen3.8-27B-GGUF`（llama.cpp/Unsloth id）与 `qwen3.8-27b`（NInfer id，需同时填入 `ninModels`）；
  压缩机制本身与模型无关，把目标模型 id 加入 `models` 即可复用；不适用非 OpenAI 兼容网关与关思考开关不同的模型族。
- **服务端硬限制**（当前目标 NInfer 配置）：窗口 378144 / 默认最大输出 192000 / 安全余量 18908 → 最大输入 **167236** tokens，
  超出直接返回 `context_length_exceeded`，客户端必须在发请求前按同一预算计算压力。
- 主要配置键（`$DSH_HOME/settings.yaml`，段名 `gateway-compaction`）：`models`、`ninModels`、`maxTokensFloor`、
  `wireReasoning`、`enableThinkingOff`、`chunking.contextWindows/chunkRatio/chunkMaxTokens/mergeMaxTokens/maxChunks`、
  `command.enabled/newContext.enabled`、`autoCompaction.{enabled,thresholdRatio,retainRatio|retainTokens,maxTokens,compactionRetries,maxOverflowRetries}`。
- **命名沿革**：原 `dsh-qwen38-gateway-compaction`，2026-09-19 起改名 `dsh-gateway-compaction`；
  从旧名升级需先把 `settings.yaml` 里的 `qwen38-gateway-compaction:` 段名改成 `gateway-compaction:`（内容不变），否则读不到旧配置。

## 安装

```bash
cd dsh-plugins/dsh-gateway-compaction
npm pack                                # 产出 dsh-gateway-compaction-1.3.1.tgz

cd <DEEPSEEK_ROOT>/deepseek-harness
DSH_HOME=$HOME/.dsh-dev pnpm dsh plugin --profile web add \
  /abs/path/to/dsh-plugins/dsh-gateway-compaction/dsh-gateway-compaction-1.3.1.tgz
```

- **重打包必须升版本号**：同版本重打包时 pnpm 按 lockfile `integrity` 判「已最新」不重解压，会残留旧布局。
- `ubuntu-4090` 安装/升级后 `systemctl --user restart dsh-dev-web`（需用户同意）；`windows-lite` 手动重启 `dsh-dev` 实例。
- 卸载：`pnpm dsh plugin --profile web rm dsh-gateway-compaction`。

## 构建与验证

**本包没有构建步骤，也没有 npm scripts（`package.json` 的 `scripts` 为空）——不存在 `pnpm check` / `pnpm build`。**
host 入口就是仓库根 `index.js`，client 产物是根 `client.js`（IIFE），两者与 `cordis.patch.yml` 一起在 `files`
白名单内直接分发（`main: ./index.js`、`exports["./client"] → ./client.js`；`dsh.bundle.patch → ./cordis.patch.yml`）。

验证直接跑测试脚本（无聚合入口，逐个执行）：

```bash
node test/smoke.mjs                 # 主冒烟
node test/integration-fetch.mjs     # 请求改写集成
node test/preset-applicability.mjs  # preset 归属判定
node test/rescue-e2e.mjs            # 分片救援端到端
node test/client-smoke.mjs          # client bundle 结构
node test/auto-rescue.mjs           # 自动压缩救援
node test/prompt-sync.mjs           # 提示词与 host 实际下发文本逐字一致
node test/window-resolution.mjs     # 上下文窗口解析
```

## 环境支持矩阵

| 环境 | 支持度 | 说明 |
|---|---|---|
| `ubuntu-4090` | **全量** | 本地 llama.cpp / NInfer 网关可起，压缩、分片救援、自动救援、手动命令全量可用 |
| `windows-lite` | **降级** | 独显差、LLM 跑不动 → **无本地网关**；指向远端 OpenAI 兼容端点时压缩机制与 `/clear-context` 可用；无可用端点时插件可安装、可加载不崩，模型策略对本地网关不生效 |

环境差异一律走配置键（`models` / `ninModels` / `chunking.contextWindows`），插件不做 OS 探测分支；
`systemctl --user …` 只适用于 `ubuntu-4090`。

Peer 依赖：`@deepseek-ai/schemastery`（>=3.18.0 <4）、`@deepseek-ai/dsh-settings`。

## 文档索引

| 文件 | 内容 |
|---|---|
| [`docs/preset-applicability.md`](docs/preset-applicability.md) | 四个内置 preset 的适用性（代码级验证 + 1.3.0 终态） |
| [`docs/minimal-context-budget.md`](docs/minimal-context-budget.md) | minimal preset 上下文预算与自动管理（终态记录） |
| [`docs/codex-token-budget-hard-rollover.md`](docs/codex-token-budget-hard-rollover.md) | Codex token budget + 硬上下文切换对本插件的启示（调研修订版） |
| [`docs/migration-2026-09-09-llamacpp-to-gateway.md`](docs/migration-2026-09-09-llamacpp-to-gateway.md) | 迁移史：llama.cpp 专用压缩插件 → 网关通用版 |
| [`docs/PROGRESS.md`](docs/PROGRESS.md) | 本插件进度真源 |
| `docs/specs/001-windows-compat/` | Windows 兼容规格目录（当前为空） |

License：MIT，见 [`LICENSE`](./LICENSE)。

## 版本号

**1.3.1**（`package.json` 与本文件同步）；归档包 `dsh-gateway-compaction-1.3.1.tgz`。

<!-- deepseek-shared-layout -->

本项目遵循 [DeepSeek 共用目录约定](../dsh-agent-presets/docs/DIRECTORY-LAYOUT.md)。管理根统一写作 `<DEEPSEEK_ROOT>`（`.../deepseek/`），历史部署记录不能视为当前机器状态；Bash/systemd 命令只适用于对应环境，配置文件中的路径须在本机解析。
