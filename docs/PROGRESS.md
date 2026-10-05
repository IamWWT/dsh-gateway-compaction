# dsh-gateway-compaction — 进度档案

> 本插件进度真源。开发/维护本插件的 agent 在每次需求/事故后更新本文件；
> 工作区根 `progress.md` 只放指向本文件的索引链接，不写细节。

## 当前状态

| 项 | 值 |
|---|---|
| 文档性质 | 进度真源 / 操作与状态记录 |
| 对应版本 | **2.0.1**（以 `package.json` 为准） |
| 状态 | 2.0.0 由 codex 完成 native 重构（provider-neutral）；**2.0.1 修复「压缩在真实网关必失败」根因（网关流式大输入连接重置）**；已装 desktop 待重启验收（`/gateway-compact` 成功压缩）；Ubuntu 3082 待重装 |
| 维护者 | 本插件开发者（monorepo `dsh-plugins/dsh-gateway-compaction/`） |

## 一句话定位

Qwen3.8 本地网关（llama.cpp / NInfer）上的会话压缩修复插件：tgz 安装于 3082 dev web
（`~/.dsh-dev`），对「压缩摘要 / 会话标题」两类辅助调用做五层 fetch 拦截，
并处理超大对话的分片 map-reduce 压缩救援 + 无内置引擎 preset 的自动溢出救援（功能 6）。
仓库：monorepo `dsh-plugins/dsh-gateway-compaction/`（代码准绳，private）；public 独立仓
`IamWWT/dsh-gateway-compaction` 双轨同步。

## 终态事实（当前生效）

- 版本 1.3.1；安装方式 = **tgz**（`npm pack` → `dsh-dev plugin --profile web add <tgz>`），
  源码 link 安装自 2026-09-23 起停用；重打包必须升版本号。
- **`package.json` 未声明任何 `scripts`，因此不存在 `pnpm check`。** 回归验证 = 逐个跑
  `node test/*.mjs`（8 个文件，无构建步骤：`index.js` / `client.js` 即产物）。
- 3082 已装，profile 已切到新名 `dsh-gateway-compaction`；**host 端改动需
  `systemctl --user restart dsh-dev-web` 才生效**（重启由用户执行）。
- 双网关/双引擎配置：`models`（llama.cpp id，如 `Qwen3.8-27B-GGUF`）与 `ninModels`
  （NInfer id，如 `qwen3.8-27b`）——命中 `ninModels` 的请求跳过
  `chat_template_kwargs`，只走 `reasoning_effort`；白名单外模型逐字节透传。
- 手动命令：`/gateway-compact`（调模型、有损保信息）、`/clear-context`（零 LLM 调用硬重置）。

## 未闭环（待用户验证 / 待人工动作）

1. **自动压缩救援（功能 6）**：重启后行验收——设置页应见「自动压缩救援」开关（默认开）；
   standard preset 会话行为**零变化**；minimal（或任一未挂 `compaction-basic` 的 preset）
   构造 400 溢出 → `journalctl --user -u dsh-dev-web` 应见
   `pressure compaction (rescue)` / `overflow recovery (rescue)` / `automatic overflow rescue`，
   且会话恢复。
2. **压缩提示词三段展示**：重启 + 刷新 3082 后，设置页应见三段提示词 + 「启用补充规则」
   开关（默认开）；真实大会话跑 `/gateway-compact` 验证分片压缩质量。
3. **settings.yaml 段名需用户手工改名**：`qwen38-gateway-compaction:` → `gateway-compaction:`
   （段内容不动）。未改 = 新插件按全默认值运行（功能仍在，个性化配置失效）。
4. **`/clear-context` 改名后 3082 是否已重启**：用户端未确认。

> 说明：以上 1/2 的测试断言已绿（见下），但**运行期行为尚未由用户复验**。

## 测试与验证记录

- 2026-09-26 记录：全部测试绿——`smoke`(58) / `window-resolution`(10) / `rescue-e2e`(29) /
  `integration-fetch`(11) / `preset-applicability`(10) / `client-smoke` / `prompt-sync`(3) /
  `auto-rescue`(36)。
- **本次文档终态化改动未重跑测试**，上列为历史记录（未复验）；命令为
  `cd dsh-plugins/dsh-gateway-compaction && for f in test/*.mjs; do node "$f"; done`。

## 已知限制（非阻塞，记录在案）

1. **旧会话的补充规则标记**：改名（`qwen38-` → `gateway-`）前生成的摘要/检查点带旧
   `SUPPLEMENT_MARKER` 文本；新代码识别新标记，最坏是补充规则在提示词里重复一次——
   纯文本重复，无功能影响，新会话不受影响。
2. **`minimalContext:` 配置块是设计占位**：代码不消费；实际键为 `autoCompaction.*` +
   `chunking.contextWindows`。
3. **98% 没有独立触发器**：由「400 溢出 → 压缩 → 重试」路径覆盖（数值区间等价，
   见 [minimal-context-budget.md](./minimal-context-budget.md)）。
4. **可选优化（未拍板）**：尾部原文保护 / `chunkMaxTokens` 调大 / 边界感知切片 / 滚动接力；
   设置页三区折叠 UI 方案未确认。

## 关键约定（勿忘）

- host 代码改动必须重启 3082（`systemctl --user restart dsh-dev-web`）才生效；
  `client.js` 改动刷新页面即可，稳妥起见一并重启。
- 网关 `127.0.0.1:8881`（qwen3.8-27b）；`contextWindows.qwen3.8-27b = 167236`
  （= 378144 − 192000 − 18908，见 [minimal-context-budget.md](./minimal-context-budget.md)）。
- 窗口解析链：显式 `contextWindows` > 网关活查 `/v1/models`（5min TTL）> settings.yaml 声明；
  全无则一次性 warn + fail open。
- 压缩主指令真源在 harness `dsh-compaction-basic`（本插件只复用 + 追加，不替换）；
  `COMPACTION_SIGNATURE` 首行校验防 harness 升级后静默失配。

## 历史沿革

- **2026-09-09 迁移**：`dsh-qwen38-llamacpp-compaction-fix` →（网关通用版，先去 `-fix`
  再去 `qwen38-` 前缀）→ `dsh-gateway-compaction`。根因与经过见
  [migration-2026-09-09-llamacpp-to-gateway.md](./migration-2026-09-09-llamacpp-to-gateway.md)。
- **1.0.x**：五层 fetch 拦截 + 分片 map-reduce 救援 + 手动命令。
- **1.1.0 / 1.1.1**：去 `-fix` 尾缀；`/qwen38-new-context` → `/clear-context`；双 slot 注册；
  `contextWindows` 修正为 167236；窗口自动解析（活查 / 声明兜底）。
- **1.2.0**：压缩提示词优化（补充规则 / 合并前言 / 设置页三段展示，`test/prompt-sync.mjs` 守卫）
  + 自动压缩救援（功能 6：压力预警 + 400 溢出压缩重试，归属判定绝不双压）。
- **1.3.0**：改名 `dsh-gateway-compaction`——仓库/包名/插件 id/设置段/GitHub 仓/本地目录，
  手动命令 `/qwen38-compact` → `/gateway-compact`（harness 已有内置 `/compact`，不可复用），
  `/clear-context` 不变；适用面由「仅 minimal」泛化到所有未挂内置压缩引擎的 preset。
- **1.3.1**：docs 对齐审计（README 中/英环境支持矩阵、tgz 安装章节、`minimalContext` 注释、
  仓库归属与双轨说明），只改 `*.md`，未动代码。
- **1.4.0**：兼容 DSH `0.2.0-rc.1`（`dsh-settings` peer 区间追加 0.2.x 分支，纯范围修正）。
- **1.5.0（2026-10-05）**：取消模型白名单限制 —— 新增 `matchAll`（bundle patch 默认 `true`），
  wire 层对**所有模型**的压缩/标题调用生效：
  - 背景：desktop（goai-vision / `qwen3.8-max-0902`）上 `/gateway-compact` 一直失败——
    模型不在白名单 → 调用不被改写 → thinking 输出占满 → 摘要无文本块 → 引擎报
    「模型没有产出可用的摘要」。会话上下文 257K/262K ≈ 98% 满仍无法压缩。
  - 白名单外模型走**保守 wire**（只写 `reasoning_effort`，不写 `chat_template_kwargs`——
    OpenAI 兼容网关会 400）；采样/max_tokens 下限/去工具全部生效；`ninModels` 语义不变。
  - 修复 `client-smoke.mjs` 存量过期断言（0.1.7 槽退役 → 单表面；hooks 键 qwen38Card；
    无折叠渲染；id 前缀 -plugins-）——1.4.0 起该测试已坏，随本次对齐。
  - **已打包 1.5.0 装 desktop（待重启验收：obisdian 会话 /gateway-compact 成功压缩）**。
  - 下一步：Ubuntu 3082（profile web）重装 1.5.0；public 仓同步已做/待做。
- **1.5.1（2026-10-05）**：修复「摘要被输出上限截断」（1.5.0 重启后实证：失败从
  「无文本摘要」变为 `summarization truncated at the token cap`——wire 已生效、模型在写
  checkpoint、但 16k 上限不够；解压会话日志确认 reasoning 582 块 + tool-call 1182 块）：
  - 新增 `slimOversized`（patch 默认开，设置页开关）：压缩前规则瘦身——`reasoning` 全丢、
    `tool-call` 降级为 `[tool-call: 名]` 一行标记（结果走引擎 toolHistory 通道不受影响）、
    空消息删；保留/丢弃分层参考 AgentScope 工具选择策略（留信息、弃负载）。
  - `maxTokensFloor` 默认 16384 → 32768（patch 同步）。
  - 保守 wire 补顶层 `enable_thinking: false`（OpenAI 兼容官方字段，双保险关思考）。
  - smoke 88 全绿（+16：slim 12 / extended 顶层字段 / floor）；client-smoke 全过。
  - **已打包 1.5.1 装 desktop（待重启验收）**；public 仓待同步。
- **1.5.2（2026-10-05）**：分片救援完善（用户指令「保留最近 N 条、分片提示词优化」，参考
  agentscope-java `ConversationCompactor`/`CompactionConfig`：
  - **`keepRecentMessages`（chunking 配置，默认 15，设置页可改，参考 agentscope `keepMessages`
    默认 20 而按产品要求取 15）**：分片时最近 N 条消息**原样保留**（不经摘要提取），直接并入最终
    合并调用——最新事实/当前进度零损失；只对更早部分分片。
  - **分片提示词优化**：新增 `CHUNK_SUMMARY_INSTRUCTION`（agentscope `DEFAULT_SUMMARY_PROMPT`
    风格：角色「context-extraction assistant」+ 四章节 SESSION INTENT/SUMMARY/ARTIFACTS/
    NEXT STEPS + 只输出提取内容）；分片调用不再复用完整官方压缩指令（每片输出最终骨架会造成
    重复与变长），改为轻量提取式；合并调用仍用官方指令出最终 checkpoint；MERGE_PREAMBLE 的
    merge 规则（recency wins/dedupe/union）天然覆盖原样尾部。
  - **窗口兜底**：`resolveChunkWindow` 全链miss时返回默认 262144（`DEFAULT_CHUNK_WINDOW`，
    goai/qwen3.8-max-0902 声明窗口）并告警一次——未列模型/无披露/无声明的超大压缩也会分片，
    不再原样转发进必然 overflow；解释 5206 `pi-ai detected context overflow`（自动路径客户端
    fetch 前拒绝，插件层不可达，依赖手动路径成功后上下文回落）。
  - **每请求生效日志**：fetch 层每次改写压缩体打一行（model/估算 tokens/slim 标志）——下次失败
    可直接核对插件是否生效与输入量级，不再黑箱。
  - fork 实测（真实 goai 调用）：窗口内 192K 输入 → 8888 字符完整 checkpoint（finish=stop 无
    截断）✓；全量 slim 310K → goai 接受但输出无框架+泄漏思考 → 佐证分片必要性。
  - 测试：smoke 88 + client-smoke + window-resolution 10（unresolvable 改断言：fallback 仍分片）
    + prompt-sync 3 + preset-applicability + auto-rescue 36 + **新增 chunking.mjs 9**（mock fetch
    捕获内部分片/合并：keepTail 进 merge 不进 slice、分片用 CHUNK_SUMMARY_INSTRUCTION、
    fallback 窗口触发）。
  - **已打包 1.5.2 装 desktop（待重启验收）**；public 仓待同步。前提：重启脚本改用 detached
    独立进程（agent 杀宿主=自杀，此前两次 kill 后 Start-Process 未执行）。

- **2.0.0（2026-10-05，codex 重构）**：`native-compaction.js` 原生中间件（走公开 `ctx.llm`
  waterfall，purpose=compaction 拦截）替换 fetch 劫持；`config.js` 的 `Config` schema 统一配置
  （`cordis.patch.yml` 只做注册）；分片 map-reduce + 迭代收敛（`maxMergeRounds`）；保尾双保险
  （`keepRecentMessages`/`keepRecentTokens`）；`modelPolicies` 按模型路由；`transactions.js`
  事务化 `/gateway-compact`、`/clear-context`。codex 会话因 usage limit 中断（未装包、
  `scripts/build-client.mjs` 空、`scripts/check.mjs` 缺失、`host.test.mjs` fixture 断言
  `messages.length<=5` 与「按 token 大块切片」冲突而失败）。

- **2.0.1（2026-10-05）事故根因与修复**——用户重启后 `/gateway-compact` 报
  「manual compaction could not produce a smaller summary」：
  - **根因（实测锁定）**：该文案是 `compaction-basic/src/region.ts:296` 的**通配归类**
    （非 commit/changed 的一切失败都归为摘要失败），真因是**网关对流式大输入的连接重置**：
    同一段 767k tokens 真实会话，流式 30k 通过、**60k/90k/120k 全部 ECONNRESET**（~5 秒即断，
    3/3 稳定），**同体非流式可过 126k+**（非流式 310k 亦通过）；另**单条消息 283k 字符**也被
    重置，拆成多条小消息后可过。宿主压缩**必然流式**（`compaction-basic/src/summarizer.ts:163`
    `for await (const chunk of ctx.llm.stream(options))`），而 2.0.0 单片预算 ≈170k tokens
    → 每片首发即被重置；中间件对无 `code` 的 fetch 网络错误**还不重试** → 直接 throw。
  - **修复**：新增 `chunking.maxStreamInputTokens`（默认 45000，0=不限），`fits = min(窗口预算,
    maxStreamInputTokens)` 统一约束 **simple/分片/合并** 三处输入判定；连接层失败
    （`isTransportFailure`：TypeError/fetch failed/ECONNRESET/socket hang up/terminated，查
    `cause` 链）纳入可重试；`totalTimeoutMs` 默认 15min → 90min；设置页加对应字段
    （`ui-fields.js` + client.js 内嵌副本手动同步，因 build 脚本为空）。
  - **验证**：native.test 13（含 ui-fields↔Config schema 覆盖）、native-compaction PASS、
    auto-rescue 36 全绿；端到端真实会话+真实网关：修复后 `streamCap=45000` → 20 片，
    首片 39k tokens 输入 **22 秒成功**（修复前同量 5 秒重置）。
  - 诊断副产品：`~/.dsh/logs` 不落插件日志（桌面宿主 logger 不写该目录），排障需靠复现 +
    会话日志；`git add/commit` 在 workspace-write 沙箱下被 `.git/index.lock` 拒（full access 可写，
    .git 本身可写——非 ACL 问题）。
