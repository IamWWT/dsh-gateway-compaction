# Changelog

## 1.3.1 (2026-09-24)

0.1.7 原生适配（harness 0.1.6→0.1.7 升级）：

- **host**：插件行 `Config` 顶层字段全部声明 `.volatile()`（0.1.7 settings 服务
  仅接受 volatile 路径）；`apply()` 对 0.1.7 loader 传入的 volatile getter 文档保持
  活引用（每次 LLM 调用前重读，设置页写入热生效），普通对象（≤0.1.6/单测）仍走
  schema 校验补默认值并解开 volatile 包装；旧 dsh-settings 两代 API 的兼容分支保留
  （0.1.7 下自然空转）。
- **client**：`settingsScope` 服务已随 0.1.7 移除 → 改经 `ctx.configForms`
  （`@deepseek-ai/dsh-client-ui-settings` 提供，`get('gateway-compaction')` 即本插件
  entry）；`ConfigForm` 面（getSnapshot/subscribe/mutate）与旧 binder scope 同形，
  控制器加 null 守卫（服务缺失时卡片降级只读）。
- 全部测试通过：smoke 58 / client-smoke / auto-rescue / window-resolution / prompt-sync。

## 1.3.0 (2026-09-19)

### 改名：`dsh-qwen38-gateway-compaction` → `dsh-gateway-compaction`

- 包名 / 插件 id / 设置命名空间 / 日志前缀 / GitHub 仓库统一改名：能力不止 Qwen3.8（压缩机制与模型无关），名字与能力对齐。
- 手动命令 `/qwen38-compact` → **`/gateway-compact`**（功能不变：模型摘要压缩，大会话自动分片；`/clear-context` 不变）。改名原因：harness 已有内置 `/compact`（command-compact），新名字同时避免与其冲突。
- **升级注意**：`settings.yaml` 中的配置段名 `qwen38-gateway-compaction:` 需手工改名为 `gateway-compaction:`（段内容不变），否则新插件按默认值运行、读不到旧配置。安装需先 `rm` 旧插件再 `add` 新路径（详见 README「安装」节）。
- 设置页卡片标题改为「本地网关压缩与上下文管理」，描述文案补充适用模型说明（本地 Qwen3 系网关；其他模型把 id 加入 `models` 即可复用压缩机制）。
- README（中/英）新增「适用模型」章节：默认 Qwen3.8-27B GGUF（llama.cpp / Unsloth / NInfer），Qwen3 相关 wire 字段说明，扩展到其他模型的方法与不适用场景。
- 测试：全套 8 套断言同步新名字/新标题，全绿。

## 1.2.0 (2026-09-19)

### 自动压缩救援（无内置压缩引擎兜底，功能 6）

- 新增 `autoCompaction` 配置段（默认开启，设置页「自动压缩救援」开关 + 高级参数 `thresholdRatio` / `maxOverflowRetries` 可调）：为**没有内置压缩引擎**的 preset（如 `minimal`）提供两级兜底——
  - **压力预警**：每轮开始前按 `thresholdRatio(0.8) × 实际窗口` 提前压缩（窗口 = `contextWindows` 设置值 > 网关 `/v1/models` 活查 > dsh 模型配置）；
  - **溢出恢复**：网关报上下文溢出（`CONTEXT_WINDOW_EXCEEDED` / 400）时自动压缩并重试，重试预算每会话独立（默认 1 次，`agent/status(idle)` 或新 assistant 消息后重置），防 400 死循环。
- **归属判定，绝不双压**：app 级 `compaction` 服务启用 → 跳过；否则查 preset 组件清单（`agentPresets.compositionInventory()`，30s TTL 缓存）是否挂载 `@deepseek-ai/dsh-compaction-basic`；检测不确定一律按「有引擎」处理。standard 等自带引擎的 preset **行为零变化**（验收标准）。
- 救援引擎以 `auto: false` 实例化（`BasicCompactionEngine` + detached ctx，永不自我注册为 `compaction` 服务），其 `llm` 经 Proxy 包装：`resolveModelInfo` 的窗口用插件 `contextWindows` 映射矫正（declared < 配置值时保留 declared，防硬件超窗），其余透传。
- 全链路失败开放：任何守卫异常都原样放行事件、保留原始错误；救援摘要走本插件 wire 层（thinking-off / 采样参数照写），救援调用自身溢出时走既有分片救援。
- 新增 `test/auto-rescue.mjs`（36 条断言：`decideBuiltInCompaction` 全分支 / `patchModelInfoWindows` 纯函数语义 / `autoCompactionEngineConfig` 映射与回退）。
- 设置页：新增「自动压缩救援」开关与高级参数（阈值 / 重试上限），中英 locale 同步。

### 压缩提示词优化（补充规则 + 合并前言重写）

- 新增 `supplementOn` 配置（默认开启）：每次压缩调用（单次压缩、分片救援的每一片、最终合并）都在官方主指令**之后**追加 6 条补充规则——① 近期加权（旧内容更激进压缩，但不丢仍有效的决策/约束/纠正/未决问题）；② 路径/命令/端口/数值/标识符/错误串逐字保真；③ 进行中任务写清「已完成/剩余/唯一下一步」；④ 事实冲突取最新（旧值仅在变更本身有意义时保留）；⑤ 按会话主语言输出（覆盖官方「英文行文」规则，代码/路径/标识符保持原文）；⑥ 不虚构，空段落写 "(none)"。设计参考 agentscope 系压缩/记忆整理提示词与分片救援的实测弱点。官方主指令从不被替换（只追加），八段结构契约与 `COMPACTION_SIGNATURE` 前缀匹配不受影响；关闭后仅发送官方主指令。
- 分片合并前言重写：由一句话「split into N parts」换成显式合并规则（后片优先 / 去重 / 事实并集 / "Current Work" 与 "Next Step" 取最后一片 / 不丢段落），降低多片摘要合并时的状态回退与事实丢失。
- 设置页「压缩提示词」展示区扩展为三段：主压缩指令 + 补充规则（随 `supplementOn` 开关，位于基础设置组）+ 分片合并前言；中英文 locale 同步。
- 新增 `test/prompt-sync.mjs`：守护 client 展示文本与 host 实际下发文本逐字一致（`SUPPLEMENT_TEXT === SUMMARY_SUPPLEMENT`；合并前言以前缀匹配）。

### 设置页可见压缩提示词（只读）

- 插件设置页（设置→插件配置卡片，以及 dsh ≥ 0.1.6 侧边栏「插件」面板页，两个入口一致）新增「压缩提示词（只读展示）」折叠区：
  - 展示 dsh 官方压缩组件 `dsh-compaction-basic` 的**主压缩指令**参考副本（标注来源与 harness 版本；运行时每次压缩都会校验其首行，与当前 harness 不一致时告警）；
  - 展示本插件**分片合并前言**（仅触发分片救援时出现的那段固定前言）；
  - 只读，不可在页面编辑；要改提示词内容需改 harness / 插件源码。
- `test/client-smoke.mjs` 新增断言：展示区正常渲染，且副本与 harness 源码中的指令逐字一致（工作区存在 harness 源码时自动交叉校验）。

### 此前批次（随本版发布）

- **改名**：硬重置命令 `/qwen38-new-context` → `/clear-context`（代码 / 测试 / 文档全部同步）。
- 设置页双入口注册：`settings.plugin.item`（旧插件配置页）+ `plugins.bundle.config`（0.1.6 侧边栏「插件」面板）。
- `cordis.patch.yml` 中 `contextWindows.qwen3.8-27b` 由 369144 修正为 **167236**（网关真实输入上限 = 378144 − 192000 − 5% 余量）。
- 新增上下文窗口自动解析：显式 `contextWindows` > 网关活查 `/v1/models` > dsh 模型配置（settings.yaml 声明）。
- package.json 版本 1.1.0 → 1.1.1（源码 link 安装，版本号仅作簿记）。

### minimal 上下文预算文档

- 重写中文 `README.md`,新增英文 `README.en.md`;GitHub 默认仍展示中文 README。
- 新增 `docs/minimal-context-budget.md`,明确 NInfer 服务端硬限制、预算公式、自动/手动行为与失败边界。
- 重写 `docs/preset-applicability.md` 与 `docs/codex-token-budget-hard-rollover.md`,区分已实现能力、后续 minimal 自动管理设计、Codex 客户端/后端能力与本地插件能力。
- 统一服务端限制示例:`contextWindow=378144`、`maxOutputTokens=192000`、`ceil(5%)=18908`、`maxInput=167236`、80% 预警约 `133788`、98% 自动压缩约 `163892`。

## 1.1.0 (2026-XX-XX)

### 改名:去掉 `-fix` 尾缀

- **改名**:包名 `dsh-qwen38-gateway-compaction-fix` → `dsh-qwen38-gateway-compaction`
  (设置命名空间同步改为 `qwen38-gateway-compaction`;仓库更名为
  IamWWT/dsh-qwen38-gateway-compaction)。更名原因:插件本身是"压缩修复"能力,
  `-fix` 尾缀与"修复/修 bug"语义重复,且与 `dsh-compaction-basic` 等内置包对齐
  (它们都不带 `-fix` 尾缀)。
- 设置覆盖段:~/.dsh*/settings.yaml 里的 `qwen38-gateway-compaction-fix:` 段需
  手动改名为 `qwen38-gateway-compaction:`(旧命名空间不再被识别)。
- cordis id / 设置命名空间 / 日志前缀同步更名;`/qwen38-compact`、
  `/qwen38-new-context` 两个手动命令不变。

## 1.0.3 (2026-09-09)

### 四个内置 preset 的适用性:代码级验证 + 文档

- 新增 `docs/preset-applicability.md`:适用性矩阵(standard/ptc/cordis 有自动压缩,
  minimal 没有)、代码路径证据(host 级 fetch 包装 / `llm/stream` / 命令注入;
  pi-ai 每次 stream 新建 openai client → `getDefaultFetch()` 取全局 fetch)、
  运行时实证(aiops 会话 56 次 400 证明 fetch 层真实生效)与边界说明。
- 新增 `test/preset-applicability.mjs`(10 条断言):无压缩引擎时仍 apply 成功且只注册
  `llm/stream`;手动命令照常注册;全局 fetch 被包装;允许模型压缩体被改写、白名单外
  逐字节透传;llama.cpp/NInfer 引擎分流;compaction 打标与非 compaction 透传。
- README 增加"适用 preset"小节并链接该文档。

## 1.0.2 (2026-09-09)

### 去掉重复的设置入口

- 删除 v0.3.0 起额外注册的左侧导航独立条目(`settings.section` /
  「Qwen3.8 压缩修复」);插件设置现在只保留 **设置 → 插件 → 插件配置** 的卡片,
  与所有内置插件一致,不再重复出现两处。
- `/qwen38-compact` / `/qwen38-new-context` 手动命令说明移入卡片正文(展开可见),
  不因去掉独立页面而丢失。
- README 同步为单一入口说明;`nav` locale 键与 `Qwen38Section` 组件移除;
  client 冒烟测试断言改为"只注册一个 slot"。

## 1.0.1 (2026-09-09)

### 设置页展示对齐内置插件

- 插件配置卡改为**可折叠卡片**:头部按钮 = 插件名 + 描述 + chevron,展开后才渲染
  控件,保存落定后自动收起(与内置 `PluginCard` 同一套交互);收起时若有未保存修改,
  头部用 `Tag` 提示。
- 卡片外观复用平台主题变量(`--dsw-alias-bg-layer-*` / `--dsw-alias-border-*` /
  `--dsw-alias-label-*`),字号与分隔线对齐内置插件(hint 12px tertiary、分组标题
  12.5px secondary、0.5px hairline),深浅色主题下都不突兀。
- 专用左侧设置区(设置 → 「Qwen3.8 压缩修复」)的标题/描述同步自然化。

## 1.0.0 (2026-09-09)

### 改名 + NInfer 引擎支持

- **改名**:包名 `dsh-qwen38-llamacpp-compaction-fix` → `dsh-qwen38-gateway-compaction-fix`
  (设置命名空间同步改为 `qwen38-gateway-compaction-fix`;仓库更名为
  IamWWT/dsh-qwen38-gateway-compaction-fix)。更名原因:插件不再只服务 llama.cpp。
- **新增 NInfer 引擎支持**:新增 `ninModels` 配置(默认 `[]`)——列入其中的模型由
  NInfer 网关服务,自动跳过 `chat_template_kwargs.enable_thinking` 合并(NInfer 对该
  字段返回 400 `chat_template_option_not_supported`),思考关闭改走
  `reasoning_effort` wire 字段;采样/max_tokens 下限/分片救援对两种引擎一视同仁。
  修复"llama.cpp 插件误用于 NInfer 模型导致所有压缩 400 失败"的故障。
- 基础层默认 `models` 增加 `qwen3.8-27b`、`ninModels: [qwen3.8-27b]`、
  `chunking.contextWindows` 增加 `qwen3.8-27b: 369144`(均可被 settings.yaml 覆盖)。
- 设置卡(client)文案更新为双引擎描述。

## 0.5.0

## 0.5.0 (2026-09-06)

### Added — `/qwen38-new-context` hard-reset command (the researched Codex third feature, now implemented)

- **New global command `/qwen38-new-context`**: drops the session's visible history from the model context in seconds with **zero LLM calls and zero token cost**, writing a fixed "new window" marker instead of an LLM summary. The whole manual transaction (idle check, range selection, commit protocol, flush, rollback) stays the official `dsh-compaction-basic` implementation — only the summarizer is swapped for a template via its documented subclass hook (`summarize`, unmarked-SummaryResult variant).
- **Independent switch** `command.newContext.enabled` (default on), separate from `command.enabled`; web settings card gains a third labeled switch (已启用/已停用) with tooltip, and the left-nav section's command hint now documents both commands.
- README: feature 3 in the intro, dedicated usage section, settings.yaml keys, research-notes section updated from "research only" to implemented.

### Fixed (both found by live e2e during this release)

- **Engine construction precedence bug**: `new makeHardResetEngine(Engine)(ctx, cfg)` parses as `new (makeHardResetEngine(Engine)(ctx, cfg))` — the returned class was invoked *without* `new`, so on first use both manual commands failed with "Class constructor … cannot be invoked without 'new'". Now constructed via an intermediate binding; regression-guarded in smoke.
- **Service-registration collision in standard-preset sessions**: `CompactionEngine` hard-codes `super(ctx, "compaction")`, so any extra engine instance collided with the built-in compaction service (or would shadow it). Manual engines are now constructed on a detached context view that no-ops `reflect.provide` — they run purely through their instances and never touch the registry, in both minimal and standard sessions; regression-guarded in smoke.

### Tests

- smoke: 37 → 58 cases (dual-command registration + per-command gating, hard-reset engine behavior, the two regression guards above).
- Verified end-to-end on a sandbox home and on the live source-build instance: reset of a ~2.3k-token history completed in ~4s with no LLM call; strict amnesia check (exact-wording recall) confirms pre-reset history is gone from the model context while the event log on disk stays intact.

## 0.4.0 (2026-09-05)

### Changed (settings UI, browser half only)

- **Enum dropdown for `wireReasoning`**: the reasoning_effort value is now a
  `<select>` (none / low / medium / high / “不写该字段”) instead of free text —
  no more typos in an enumerated field.
- **Hover tooltips with explicit dependency labels**: every field label carries a
  `title` tooltip stating whether the field is independent (“独立项”) or which
  switch gates it (e.g. “依赖「超大对话分片救援」开启”). The only two
  dependency chains are: `models` (root — empty disables the whole policy) and
  the rescue master switch (gates context windows + the four chunk tuning
  fields).
- **Rescue-gated dimming**: when the rescue switch is off, the per-model
  context-window rows and the four chunking advanced fields are greyed out and
  disabled (values kept, just inert), with an orange “depends on rescue being
  on” note — the UI now shows the dependency structure instead of hiding it.
- README: FAQ (when `/qwen38-compact` can be triggered; whether anything runs
  automatically), UI dependency documentation, and a research-notes section.

### Added

- `docs/codex-token-budget-hard-rollover.md`: verified research on Codex's
  token-budget + hard context rollover direction (rust-v0.153.0 release notes,
  PR #29743, PR #39827 — all checked online) and the design sketch for a
  candidate third feature, `/qwen38-new-context` (instant zero-LLM hard reset,
  plus a handoff-note variant). Research only; not implemented.

## 0.3.0 (2026-09-05)

### Added

- **`/qwen38-compact` manual compaction command**: type it in any session's
  composer to compact that session's history into a summary checkpoint right
  now. This is the unstick path for conversations over the model's context
  window in presets without a built-in compaction engine (e.g. minimal),
  where no automatic compaction ever fires and the preset selector only
  applies to new sessions. The command reuses the official
  `dsh-compaction-basic` transaction (`BasicCompactionEngine` with
  `auto: false`, so no pressure hooks are registered) — its summarization
  call flows through `llm/stream {purpose:'compaction'}` and therefore gets
  every wire-layer treatment (thinking off, sampling params, max_tokens
  floor, tools strip) plus the chunked map-reduce rescue for oversized
  prompts. Registered as a global command via
  `ctx.inject(['commands','tokenMeter','sessions'])`, so it is visible in
  every session regardless of preset; friendly failure text on busy /
  missing-engine / no-summary outcomes, transaction rolls back untouched.
  Disable with `command.enabled: false`.
- **Dedicated settings section**: the plugin now registers its own left-nav
  row (Settings → “Qwen3.8 压缩修复”, order 20) in addition to the
  plugins-tab card — same live scope, plus a scope banner (“all parameters
  apply only to compaction/title auxiliary calls; normal conversation is
  untouched”) and the `/qwen38-compact` usage hint.
- **UI redesign** (client.js): boolean fields are now labeled on/off pill
  switches with explicit “已启用/已停用” state text (no more mystery
  checkboxes); per-model context-window rows (one row per id in `models`,
  so a changed `-c` is unambiguous which model it belongs to); consistent
  label-column alignment and grouped sections (基础设置 / 高级参数).
- README: “上下文窗口长度变了怎么办” guide (when/what to change, how to
  verify the live n_ctx via `GET /v1/models`, safe-fail semantics),
  `/qwen38-compact` usage section, and a corrected stuck-session recipe
  (preset switching does NOT work mid-session — use the command).

### Fixed

- **Compaction summarization produced no text on Qwen3.8 / llama.cpp build
  10798**: dsh's compaction prompt includes the conversation's `tools`
  schemas (KV-cache prefix affinity). With tools present AND thinking off,
  this model answers with an empty-content tool call instead of a summary —
  measured: tools+thinking-off → empty; tools+thinking-on → works;
  no-tools+thinking-off → works. Both `rewriteCompactionBody` and
  `rewriteTitleBody` now strip `tools`/`tool_choice` from matched bodies.
  (The summarization prompt itself never references tool names, so nothing
  is lost.)

### Verified end-to-end

- Sandbox minimal-preset session: `/qwen38-compact` recognized as a command,
  compacted 7 history items (~3047 tokens) into a checkpoint; the model then
  answered a follow-up question that only makes sense with the pre-compaction
  context (checkpoint survived).
- Real instance (the user's dsh web, port 3082): the stuck veinmap session at
  **262519 tokens > 262144 window** compacted via one command — 130 nodes
  (~49.5K tokens) → a 10.1K-character Chinese checkpoint, context usage back
  to 8%, conversation resumed immediately.

## 0.2.0 (2026-09-05)

### Added

- **Web settings card** (browser half): the plugin now ships a self-contained
  client bundle (`client.js`, no build step) declared through `package.json`
  `dsh.client` + the `./client` export. In dsh web it renders as the
  “Qwen3.8 llama.cpp 压缩修复” card under Settings → Plugins → Plugin
  configuration, editing every config key (model ids, context window,
  thinking-off / wire-reasoning toggles, max_tokens floor, rescue switch,
  and an advanced section with all sampling + chunk tuning fields). Saving
  writes `settings.yaml` live; the “overrides default” badge stages a
  reset-to-default (unset) op on save — same staging model as the built-in
  cards. Chinese + English locale.
- `test/client-smoke.mjs`: loads the client bundle in a VM with a stubbed
  module loader, drives the Cordis surface (locale registration, slot
  entry), renders the card through a minimal React renderer, and exercises
  edit / save / invalid-block / reset-unset / discard against a fake
  settings scope.
- README: web-card usage section plus a troubleshooting section for
  already-stuck conversations (minimal preset ships no compaction engine;
  pi-ai rejects any `reasoningEffort` — including `off` — for models that
  declare no reasoning capability, which is why this plugin's effort layer
  stays silent for undeclared models and relies on the wire layers).

### Verified end-to-end (real dsh web instance + headless Chrome via CDP)

- card renders with live values from the real settings scope;
- UI edit → save writes `settings.yaml` (`maxTokensFloor: 16000` observed on
  disk); badge → save removes the key again (unset path), leaving no residue.

## 0.1.1 (2026-09-05)

### Fixed

- **Boot failure on source builds**: `@deepseek-ai/dsh-settings` has two API
generations — npm releases (0.1.1-rc.x) export the free functions
  `installSettingsSection`/`settingsNamespace`, while newer source-tree
  releases (>= 0.1.3) expose `ctx.settings.installSection(...)` on the service
  and export no free functions. The static named import crashed plugin loading
  in source builds ("does not provide an export named
  'installSettingsSection'"). The module now imports dsh-settings dynamically
  and supports both generations: new API via the optional
  `ctx.inject(["settings"], cb)` scope, legacy free function as fallback,
  schema-resolved composition entry as the final fallback (no settings service
  mounted). Works unchanged in npm and source builds.
- Test coverage for both settings API generations added to `test/smoke.mjs`
  (41 cases total).

## 0.1.0 (2026-09-05)

Initial release. Local plugin for llama.cpp gateways (tuned on Unsloth Studio +
Qwen3.8-27B GGUF, llama.cpp build 10798).

### R1 — thinking off for auxiliary calls only

- `llm/stream` waterfall layer: stamps `reasoningEffort: "off"` on calls whose
  `purpose` is in `purposes` and whose `options.model` is in `models`; resolves
  the model's offered efforts with preference order configured → `off` → `low`.
- HTTP compaction-body layer: process-global `fetch` wrapper writes, on bodies
  carrying the dsh-compaction-basic instruction signature for an allowed model:
  - `chat_template_kwargs.enable_thinking = false` (merged; other template kwargs preserved),
  - `reasoning_effort` set to the configured wire value (default `"none"`),
  - the configured non-thinking sampling entries (`temperature/top_p/top_k/min_p/presence_penalty/repetition_penalty`, default Qwen3's recommended non-thinking set),
  - a raise-only `max_tokens`/`max_completion_tokens` floor (default 16384) restoring the output budget when pi-ai's client-side context clamp collapses it.
- HTTP session-title layer: same two thinking-off wire fields on bodies carrying
  the dsh-session-title-llm system-prompt signature for an allowed model; the
  title plugin's own `max_tokens` is left untouched.
- Model allow-list (`models`, default `["Qwen3.8-27B-GGUF"]`) enforced at every
  layer; empty list disables the whole policy. Signature gates use structural
  prefix matches (compaction instruction must start the final user message; the
  title prompt must start a system/developer message), so conversation turns
  that merely quote either signature pass through untouched.
- Settings section `qwen38-gateway-compaction-fix:` in `$DSH_HOME/settings.yaml`
  overrides the bundle config live, without a restart.

### R2 — oversized-conversation compaction rescue (chunked map-reduce)

Fixes the "chatted on a 1M-context model, switched to a 250k-context local
model, now 'cannot compact'" case: dsh-compaction-basic's single-shot
summarization cannot fit a conversation larger than the target window.

- HTTP rescue layer: after the compaction-body rewrite, estimates the prompt
  tokens (CJK-conservative heuristic: ~1 token/CJK char, chars/4 otherwise,
  1024 per image block, `tools` schemas included). When it exceeds
  `chunkRatio × contextWindows[model]` and chunking is enabled for that model,
  the original request is NOT forwarded; instead:
  - the message range is split into consecutive slices (leading system/developer
    messages re-sent per slice and charged to the budget; a `tool`-role message
    never starts a slice; an over-budget single message is head/tail-truncated
    for internal calls only — the durable surface is untouched);
  - each slice is summarized sequentially (non-streaming, thinking off, sampling
    applied, `max_tokens = chunkMaxTokens`, the conversation's own compaction
    instruction appended verbatim);
  - partial checkpoints are merged in a final call (`mergeMaxTokens`), with an
    automatic two-level hierarchical merge when even the flat merge would not fit;
  - the merged checkpoint is returned to dsh as a standard OpenAI response: SSE
    stream with keep-alive pings (15s) when the original request was streaming,
    plain JSON otherwise.
- Fail-open semantics everywhere: unknown model window / more slices than
  `maxChunks` / unparseable body → forward the original untouched; mid-flight
  failure (after one retry per call) → stream ends with EMPTY content, which
  dsh-compaction-basic rejects cleanly and the conversation surface is preserved
  — the same safe outcome as today's overflow.

### Verification

- `test/smoke.mjs`: 37 gating/estimation/slicing/body-shaping cases pass.
- `test/rescue-e2e.mjs`: 29 end-to-end cases with a mock transport pass (slice
  fan-out, merge call, thinking-off carry-over, tools dropped, SSE shape).
- Live gateway checks (llama.cpp build 10798 via Unsloth Studio :8880): default
  requests think (non-empty `reasoning_content`); both
  `chat_template_kwargs.enable_thinking=false` and `reasoning_effort="none"`
  independently suppress thinking (streaming and non-streaming, easy and hard
  prompts); all six sampling fields are accepted without error.
