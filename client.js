/**
 * dsh-gateway-compaction — browser half (self-contained client bundle).
 *
 * Hand-written on purpose: the dsh web shell serves this file verbatim into the
 * page module table (package.json `dsh.client` + `./client` export), so it must
 * be a standalone script that registers one lazy factory through
 * `window.__ModuleLoader__.load`. No build step, no imports beyond the client
 * baseline (react, dsh-client-ui-primitives, dsh-client-store).
 *
 * What it renders:
 *   - the plugin card inside Settings → 插件 → 插件配置 (the `settings.plugin.item`
 *     slot; the one home every built-in plugin uses; no extra left-nav entry), and
 *   - on dsh ≥ 0.1.6 (ui-plugin-manager): the same form on the bundle's page in the
 *     sidebar 插件 panel, registered into the `plugins.bundle.config` slot keyed by
 *     this package's name. Both surfaces edit the same `gateway-compaction`
 *     settings namespace.
 *   - on both surfaces: a read-only “压缩提示词” (compaction prompts) section
 *     showing the exact text that shapes summary quality — the main compaction
 *     instruction of dsh-compaction-basic (harness), the optional plugin
 *     supplement rules (toggleable), and this plugin's chunked-merge preamble.
 *     Display only: changing any of these texts requires a harness/plugin code
 *     change, not a setting.
 * It edits the `gateway-compaction` settings namespace.
 */
window.__ModuleLoader__.load({
	id: 'dsh-gateway-compaction',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const React = require('react');
		const h = React.createElement;
		const { Button, Input, Tag, IconChevronDownOutline14 } = require('@deepseek-ai/dsh-client-ui-primitives');
		const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store');

		/** Settings namespace this card edits (must match the Host half). */
		const NS = 'gateway-compaction';

		// ------------------------------------------------------------------
		// Locale dictionaries (flat key -> string, zh primary / en fallback).
		// ------------------------------------------------------------------
		const LOCALES = {
			zh: {
				title: '本地网关压缩与上下文管理',
				description: '适用模型:本地 Qwen3 系网关(llama.cpp / Unsloth Studio 与 NInfer,默认 Qwen3.8-27B GGUF;其他模型把 id 加入「适用模型 ID」)。让本地网关上的会话压缩可靠完成:辅助调用按引擎写入对应的关思考字段(llama.cpp: chat_template_kwargs.enable_thinking;NInfer: reasoning_effort),并用非思考模式推荐采样参数;超大对话自动分片压缩;无内置压缩引擎的 preset 自动溢出救援。保存后实时生效,无需重启。',
				scopeNote: '作用域:本页全部参数只作用于「压缩摘要」与「会话标题」两类辅助调用。正常对话完全不受影响,仍使用你网关(llama.cpp/NInfer)的默认参数。NInfer 模型请把模型 id 同时填入 ninModels(设置页不展示该项,见 settings.yaml),否则会对 NInfer 网关误发 chat_template_kwargs 导致 400。',
				commandHint: '手动操作:在任意会话输入框输入 /gateway-compact(模型总结,保信息,大会话走分片)或 /clear-context(硬重置:不调模型、秒级完成、历史丢弃)。极简模式等无内置压缩引擎的会话也可用。',
				basicTitle: '基础设置',
				advancedTitle: '高级参数(仅作用于压缩/标题调用)',
				modelsLabel: '适用模型 ID',
				modelsHint: '逗号分隔,须与 settings.yaml 中 llm-pi-ai providers 声明的模型 id 完全一致;留空则整个策略停用。',
				windowsTitle: '上下文窗口(tokens)——每个模型一行',
				windowsHint: '该模型网关实际运行的上下文窗口(llama.cpp: -c;NInfer: n_ctx)。只影响“何时分片”:设小=更早分片(慢一点),设大=可能单次溢出(安全回退)。留空则自动解析:先查网关 /v1/models,再查 dsh 模型配置(settings.yaml 中该模型的 contextWindow);两者都查不到才需要手填。',
				enableThinkingOffLabel: '压缩/标题调用关闭思考',
				enableThinkingOffHint: '开启:向匹配的辅助请求写入 chat_template_kwargs.enable_thinking=false(Qwen3 在 llama.cpp 上的主开关;对 NInfer 模型自动跳过——NInfer 不认该字段,只走 reasoning_effort)。正常对话不受影响。',
				wireReasoningLabel: 'reasoning_effort 字段值',
				wireReasoningHint: '双保险:同时写入请求体的 reasoning_effort(llama.cpp 与 NInfer 均接受,如 none);留空表示不写该字段。',
				maxTokensFloorLabel: 'max_tokens 下限',
				maxTokensFloorHint: '辅助调用的 max_tokens 至少抬到该值(只升不降),防止客户端上下文钳制吃掉输出预算;0 停用。',
				rescueLabel: '超大对话分片救援',
				rescueHint: '开启:压缩提示词超过单次调用容量时,自动切分逐段摘要再合并,而不是报“无法压缩”。',
				newContextLabel: '硬重置命令 /clear-context',
				newContextHint: '开启后任意会话可硬重置上下文:不调用模型、秒级完成、历史直接丢弃(环境状态不变)。',
				temperatureLabel: 'temperature',
				topPLabel: 'top_p',
				topKLabel: 'top_k',
				minPLabel: 'min_p',
				presencePenaltyLabel: 'presence_penalty',
				repetitionPenaltyLabel: 'repetition_penalty',
				chunkRatioLabel: '分片输入占比 chunkRatio',
				chunkMaxTokensLabel: '单片摘要上限 chunkMaxTokens',
				mergeMaxTokensLabel: '合并摘要上限 mergeMaxTokens',
				maxChunksLabel: '最大分片数 maxChunks',
				on: '已启用',
				off: '已停用',
				collapse: '收起',
				expand: '展开',
				unsaved: '未保存',
				save: '保存',
				saving: '保存中…',
				discard: '放弃修改',
				overridden: '已覆盖默认值',
				reset: '恢复默认',
				invalidNumber: '请输入数字,或留空使用默认值。',
				saveFailed: '部署未接受这些值,改动仍保留在表单中,请修正后重试。',
				readOnly: '当前部署的设置存储为只读。',
				unavailable: '设置服务暂不可用。',
				wireOmit: '不写该字段',
				rescueOffNote: '依赖「超大对话分片救援」开启——当前已停用,以上项不生效(配置保留)。',
				// Hover tooltips (label title attribute): each states the field's
				// dependencies explicitly — “独立项” or which switch gates it.
				tipModels: '根开关(其余全部依赖它):留空则整个插件策略停用——本页其他参数全部不生效。逗号分隔,须与 settings.yaml 中 llm-pi-ai providers 声明的模型 id 完全一致。',
				tipEnableThinkingOff: '独立项(不依赖其他项)。开启:向匹配的压缩/标题请求写入 chat_template_kwargs.enable_thinking=false(Qwen3 在 llama.cpp 上的主开关)。与「reasoning_effort 字段值」是双保险关系,二者可各自独立开关。正常对话不受影响。',
				tipWireReasoning: '独立项(不依赖其他项)。下拉选择写入请求体 reasoning_effort 的值(llama.cpp 接受 none/low/medium/high);选「不写该字段」则省略。与「压缩/标题调用关闭思考」互为双保险。',
				tipMaxTokensFloor: '独立项(不依赖其他项)。辅助调用的 max_tokens 至少抬到该值(只升不降),防止客户端上下文钳制吃掉输出预算;0 停用。',
				tipChunkingEnabled: '「分片救援」组的总开关(5 项依赖它):上下文窗口 + chunkRatio/chunkMaxTokens/mergeMaxTokens/maxChunks。停用后这些项变灰且不生效(配置仍保留,只是不使用)。',
				tipWindows: '依赖①「超大对话分片救援」开启;②模型 id 出现在「适用模型 ID」列表里。填该模型 llama-server 实际运行的 -c(Unsloth 改过 -c 或换 GGUF 后用 curl /v1/models 查 context_length 同步过来)。只影响“何时分片”:设小=更早分片(慢一点),设大=可能单次溢出(安全回退)。',
				tipSampling: '独立项(不依赖其他项)。原样写入压缩/标题调用的请求体;正常对话不受影响。',
				tipChunkRatio: '依赖「超大对话分片救援」开启。单次内部调用输入预算 = 上下文窗口 × 该比例(其余留给指令、估算误差与输出上限),取值 (0,1]。',
				tipChunkMaxTokens: '依赖「超大对话分片救援」开启。单个分片摘要的输出上限(token)。',
				tipMergeMaxTokens: '依赖「超大对话分片救援」开启。最终合并 checkpoint 的输出上限(token)。',
				tipMaxChunks: '依赖「超大对话分片救援」开启。单次救援的分片数安全上限;超出的区间 fail-open(转发原请求并告警)。',
				tipNewContext: '独立项(不依赖其他项)。语义与 /gateway-compact 不同:本命令不调用模型、不做摘要——直接把模型可见历史丢弃并写入新窗口标记,秒级完成、零 token 成本。适合任务状态都在文件/git 里的场景;纯问答会话(状态不在环境里)建议用 /gateway-compact。',
				promptTitle: '压缩提示词(只读展示)',
				promptNote: '压缩质量由下面三段提示词决定,此区只读展示、不可编辑:第 1 段是 dsh 官方压缩组件(dsh-compaction-basic,harness 源码)的指令,本插件每次压缩原样复用;第 2 段是本插件可选追加的补充规则(见下方开关);第 3 段是本插件在触发分片救援时补的合并前言。要修改内容需要改 harness/插件源码。',
				mainPromptTitle: '主压缩指令 — 来源:dsh-compaction-basic(harness 0.1.6-alpha.2 参考副本)',
				mainPromptNote: '每次压缩都会作为最后一条用户消息发给模型:把上面的对话浓缩成固定八段结构的检查点。本插件每次压缩都会校验其首行,与当前 harness 不一致时告警。',
				supplementTitle: '补充规则 — 本插件提供(随主指令一并发给模型,可关闭)',
				supplementNote: '默认开启:压缩时把这 6 条追加在「主压缩指令」之后发给模型(单次压缩与分片救援的每片/最终合并都带上);关闭后只发官方指令。',
				supplementOnLabel: '启用补充规则',
				supplementOnHint: '默认开启;关闭后压缩只使用第一段官方指令。',
				tipSupplementOn: '独立项(不依赖其他项)。作用于所有压缩类调用(单次压缩、分片救援的每片与最终合并),不影响正常对话。',
				autoRescueLabel: '自动压缩救援(无内置引擎兜底)',
				autoRescueHint: '默认开启:当会话所属 preset 没有内置压缩引擎(如极简模式)且网关报上下文溢出(400)时,自动用本插件压缩引擎压一轮并重试,最多重试 1 次。已有内置压缩引擎的会话(如 standard)绝不干预,不会双重压缩。',
				tipAutoRescue: '独立项(不依赖「适用模型 ID」)。只兜底「没有内置压缩引擎」的 preset;standard 等自带 dsh-compaction-basic 的 preset 始终跳过(官方引擎已负责),检测不确定时也按「有引擎」处理,宁可漏救不双压。阈值/重试数在「高级参数」里调。',
				autoRatioLabel: '自动压缩阈值 thresholdRatio',
				tipAutoRatio: '依赖「自动压缩救援」开启。会话上下文达到该比例 × 实际窗口时提前压缩(默认 0.8);窗口取你在「上下文窗口」里声明的值(填得越准,预警越早)。',
				autoMaxRetriesLabel: '溢出后最大重试 maxOverflowRetries',
				tipAutoMaxRetries: '依赖「自动压缩救援」开启。网关报上下文溢出时,压缩后自动重试的次数上限(默认 1);每次重试的预算独立,防止 400 死循环。',
				mergePromptTitle: '分片合并前言 — 本插件提供(仅触发分片救援时出现)',
				mergePromptNote: '历史大到单次装不下时,插件按顺序逐片摘要,再用「这段前言 + 各片部分摘要 + 上面的主指令」做最终合并。',
			},
			en: {
				title: 'Local gateway compaction & context management',
				description: 'Applies to local Qwen3 gateways (llama.cpp / Unsloth Studio AND NInfer; default Qwen3.8-27B GGUF — other models: add their ids to "Model ids"). Makes session compaction reliable: engine-appropriate thinking-off wire fields + non-thinking sampling for auxiliary calls; oversized conversations compact in chunks; presets without a built-in engine get automatic overflow rescue. Changes apply live, no restart.',
				scopeNote: 'Scope: every parameter on this page applies ONLY to auxiliary calls — compaction summaries and session titles. Normal conversation is untouched and keeps your gateway defaults (llama.cpp/NInfer).',
				commandHint: 'Manual operations: type /gateway-compact (model-summarized, keeps information, chunked when oversized) or /clear-context (hard reset: no LLM call, instant, history discarded) in any session composer. Works even in presets without a built-in compaction engine.',
				basicTitle: 'Basics',
				advancedTitle: 'Advanced (auxiliary calls only)',
				modelsLabel: 'Model ids',
				modelsHint: 'Comma-separated; must exactly match the model ids declared under llm-pi-ai providers in settings.yaml. Empty disables the whole policy.',
				windowsTitle: 'Context window (tokens) — one row per model',
				windowsHint: 'The context window the gateway actually runs for that model (llama.cpp: -c; NInfer: its n_ctx). Only affects WHEN chunking kicks in: smaller = earlier chunking (slower), larger = possible single-call overflow (safe fallback). Leave a model blank and the plugin resolves it automatically: live /v1/models probe first, then the declaration in your dsh model config (settings.yaml contextWindow); only fill it in manually if both are missing.',
				enableThinkingOffLabel: 'Disable thinking on compaction/title calls',
				enableThinkingOffHint: 'On: writes chat_template_kwargs.enable_thinking=false into matched auxiliary requests (the primary Qwen3 switch on llama.cpp; skipped automatically for NInfer models, which only get reasoning_effort). Normal conversation is unaffected.',
				wireReasoningLabel: 'reasoning_effort field value',
				wireReasoningHint: 'Belt-and-braces: also written into the request body (llama.cpp accepts none/low/medium/high); blank omits the field.',
				maxTokensFloorLabel: 'max_tokens floor',
				maxTokensFloorHint: 'Raises auxiliary-call max_tokens to at least this value (never lowers) so the client-side context clamp cannot eat the output budget. 0 disables.',
				rescueLabel: 'Oversized-compaction chunked rescue',
				rescueHint: 'On: when a compaction prompt exceeds one call, summarize slices sequentially and merge instead of failing with “cannot compact”.',
				newContextLabel: 'Hard-reset command /clear-context',
				newContextHint: 'When on, any session can hard-reset its context: no LLM call, instant, history discarded (environment state untouched).',
				temperatureLabel: 'temperature',
				topPLabel: 'top_p',
				topKLabel: 'top_k',
				minPLabel: 'min_p',
				presencePenaltyLabel: 'presence_penalty',
				repetitionPenaltyLabel: 'repetition_penalty',
				chunkRatioLabel: 'chunk input ratio (chunkRatio)',
				chunkMaxTokensLabel: 'per-slice output cap (chunkMaxTokens)',
				mergeMaxTokensLabel: 'merge output cap (mergeMaxTokens)',
				maxChunksLabel: 'max slices (maxChunks)',
				on: 'on',
				off: 'off',
				collapse: 'Collapse',
				expand: 'Expand',
				unsaved: 'Unsaved',
				save: 'Save',
				saving: 'Saving…',
				discard: 'Discard',
				overridden: 'overrides default',
				reset: 'Reset to default',
				invalidNumber: 'Enter a number, or leave blank to use the default.',
				saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
				readOnly: 'This deployment stores settings read-only.',
				unavailable: 'The settings service is unavailable.',
				wireOmit: 'omit field',
				rescueOffNote: 'Depends on “oversized-compaction chunked rescue” being on — it is currently off, so the items above are inert (values kept).',
				tipModels: 'Root switch (everything else depends on it): empty disables the whole plugin policy — no other parameter on this page takes effect. Comma-separated; must exactly match the model ids declared under llm-pi-ai providers in settings.yaml.',
				tipEnableThinkingOff: 'Independent item (no dependencies). On: writes chat_template_kwargs.enable_thinking=false into matched compaction/title requests (the primary Qwen3 switch on llama.cpp). Pairs as belt-and-braces with “reasoning_effort field value” — either can be toggled independently. Normal conversation is unaffected.',
				tipWireReasoning: 'Independent item (no dependencies). Dropdown for the reasoning_effort value written into the request body (llama.cpp accepts none/low/medium/high); “omit field” leaves it out. Pairs as belt-and-braces with “disable thinking on compaction/title calls”.',
				tipMaxTokensFloor: 'Independent item (no dependencies). Raises auxiliary-call max_tokens to at least this value (never lowers) so the client-side context clamp cannot eat the output budget. 0 disables.',
				tipChunkingEnabled: 'Master switch of the chunked-rescue group (5 items depend on it): context windows + chunkRatio/chunkMaxTokens/mergeMaxTokens/maxChunks. When off, those items are greyed out and inert (values kept).',
				tipWindows: 'Depends on ① “oversized-compaction chunked rescue” being on; ② the model id appearing in the model-ids list. The llama-server -c actually running for that model (after changing -c or the GGUF in Unsloth Studio, sync from context_length via curl /v1/models). Only affects WHEN chunking kicks in: smaller = earlier chunking (slower), larger = possible single-call overflow (safe fallback).',
				tipSampling: 'Independent item (no dependencies). Written verbatim into compaction/title request bodies; normal conversation is unaffected.',
				tipChunkRatio: 'Depends on “oversized-compaction chunked rescue” being on. Single-call input budget = context window × this ratio (the rest covers instructions, estimation error and the output cap); range (0,1].',
				tipChunkMaxTokens: 'Depends on “oversized-compaction chunked rescue” being on. Per-slice summary output cap (tokens).',
				tipMergeMaxTokens: 'Depends on “oversized-compaction chunked rescue” being on. Final merged-checkpoint output cap (tokens).',
				tipMaxChunks: 'Depends on “oversized-compaction chunked rescue” being on. Safety cap on slices per rescue; ranges beyond it fail open (forward the original request with a warning).',
				tipNewContext: 'Independent item (no dependencies). Different semantics from /gateway-compact: this command makes NO LLM call and writes no summary — it discards the model-visible history and installs a fresh-window marker, instantly and at zero token cost. Best when task state lives in files/git; for pure Q&A sessions (state not in the environment) prefer /gateway-compact.',
				promptTitle: 'Compaction prompts (read-only)',
				promptNote: 'Summary quality is set by the three prompts below. This section is display-only: (1) the official dsh-compaction-basic instruction (harness source), reused verbatim on every compaction; (2) the optional supplement rules this plugin appends (toggle below); (3) the merge preamble this plugin adds when chunked rescue fires. Changing any of them requires a code change.',
				mainPromptTitle: 'Main compaction instruction — source: dsh-compaction-basic (harness 0.1.6-alpha.2 reference copy)',
				mainPromptNote: 'Sent as the final user message on every compaction: condense the conversation above into a fixed eight-section checkpoint. The plugin verifies its first line at runtime and warns if the running harness no longer matches.',
				supplementTitle: 'Supplement rules — provided by this plugin (sent with the main instruction; can be disabled)',
				supplementNote: 'On by default: these six rules are appended after the main instruction on every compaction call (single-shot and each chunked slice / final merge). With the toggle off, only the official instruction is sent.',
				supplementOnLabel: 'Enable supplement rules',
				supplementOnHint: 'On by default; off = compaction uses only the official instruction.',
				tipSupplementOn: 'Independent item (no dependencies). Applies to every compaction call (single-shot, each slice and the final merge of chunked rescue); normal conversation is unaffected.',
				autoRescueLabel: 'Automatic overflow rescue (no built-in engine)',
				autoRescueHint: 'On by default: when a session whose preset has no built-in compaction engine hits a context-window overflow (400), the plugin compacts once with its own engine and retries (max 1 retry). Sessions with a built-in engine (e.g. standard) are never touched — no double compaction.',
				tipAutoRescue: 'Independent item (no dependency on "Model ids"). Only rescues presets WITHOUT a built-in compaction engine; presets that mount dsh-compaction-basic (e.g. standard) are always skipped, and an undetectable deployment is treated as "has engine" — a missed rescue surfaces the 400, a false one would double-compact on GPU. Threshold/retry cap live in Advanced.',
				autoRatioLabel: 'auto-compact threshold (thresholdRatio)',
				tipAutoRatio: 'Depends on "automatic overflow rescue" being on. Pre-compaction triggers at this ratio × the effective window (default 0.8); the window comes from your "Context window" entries above (the more accurate, the earlier the warning fires).',
				autoMaxRetriesLabel: 'overflow retry cap (maxOverflowRetries)',
				tipAutoMaxRetries: 'Depends on "automatic overflow rescue" being on. After the gateway reports a context overflow, the session is compacted and retried at most this many times (default 1); each retry gets its own budget so a 400 loop cannot run away.',
				mergePromptTitle: 'Merge preamble — provided by this plugin (only when chunked rescue fires)',
				mergePromptNote: 'When history no longer fits one call, each slice is summarized in order, then merged using this preamble + the partial checkpoints + the main instruction above.',
			},
		};

		// ------------------------------------------------------------------
		// Read-only prompt display (the “压缩提示词” section). MAIN_PROMPT_TEXT is
		// a reference copy of the summarization instruction from dsh-compaction-basic
		// (harness 0.1.6-alpha.2) — the exact text the engine sends as the final
		// user message on every compaction, which this plugin reuses verbatim for
		// each chunked slice and for the final merge. The host verifies its first
		// line at runtime (COMPACTION_SIGNATURE) and warns if the running harness
		// no longer matches. SUPPLEMENT_TEXT mirrors the host's SUMMARY_SUPPLEMENT
		// (index.js) — the text appended after the main instruction when
		// `supplementOn` is on; MERGE_PREAMBLE_TEXT mirrors the host's
		// MERGE_PREAMBLE plus a worked example of the per-slice partials.
		// test/prompt-sync.mjs keeps all three in lockstep with the host exports.
		// Display only: no block is editable here.
		// ------------------------------------------------------------------
		const MAIN_PROMPT_TEXT = `You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.

Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.

## Primary Request and Intent
- [the user's original and evolving goals; quote verbatim where the exact wording matters]

## Key Technical Concepts
- [technologies, frameworks, patterns, and conventions in play]

## Files and Code
- [exact path: why it matters, key changes or snippets]

## Errors and Fixes
- [error: how it was resolved, plus any related user feedback]

## Pending Jobs
- [explicitly requested work not yet completed]

## Current Work
- [precisely what was in progress at this checkpoint]

## Next Step
- [the single next action, directly in line with the most recent request, or "(none)"]

## Critical Context
- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]

Rules:
- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.
- Capture user feedback and explicit instructions faithfully, especially corrections.
- Do NOT mention this summarization request or that the context was compacted.
- Output only the checkpoint text: do not call any tool or take any other action.
- If the conversation already contains a <compacted-summary> block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`;

		/** Display copy of the host's SUMMARY_SUPPLEMENT (index.js) — the exact text
		 * appended after the main instruction on every compaction call when
		 * `supplementOn` is true. test/prompt-sync.mjs asserts it stays in
		 * lockstep with the host export. */
		const SUPPLEMENT_TEXT = `Additional compaction requirements (appended by dsh-gateway-compaction plugin; where these conflict with the instruction above, THESE RULES WIN):

1. Recency weighting: weight the most recent exchanges most heavily. Compress older material more aggressively, but never drop a decision, constraint, correction, or open question that still applies.
2. Verbatim fidelity: preserve exact file paths, commands, ports and numeric values, identifiers, and error strings; quote the user's own words for instructions and corrections.
3. In-flight work: for every task still in progress, state exactly what is done, what remains, and the single concrete next action.
4. Conflict resolution: when facts conflict, the most recent statement wins; keep a superseded value only when the change itself matters.
5. Language (OVERRIDES the 'concise English prose' rule above): write the checkpoint in the conversation's dominant language; keep code, paths, commands, and identifiers verbatim.
6. Never invent facts that are not present in the conversation; if a section has no content, write "(none)".`;

		/** Display copy of the host's MERGE_PREAMBLE (index.js), followed by a
		 * worked example of how the per-slice partials are embedded in the real
		 * merge call. The wire text is the host's MERGE_PREAMBLE verbatim; the
		 * example tail is display-only. */
		const MERGE_PREAMBLE_TEXT = `The original conversation was too large to summarize in a single pass, so it was split into consecutive parts and each part was summarized separately. The partial checkpoints below are in chronological order. Merge them into the single final checkpoint.

Merging rules:
- Later parts are MORE recent: on any conflict, the most recent partial wins.
- Deduplicate: state each fact once, in its most complete form.
- Union of facts: a fact from any part survives unless a later partial supersedes it.
- "Current Work" and "Next Step" must describe the state at the END of the conversation (the last partial), not an earlier point.
- Keep every section of the required structure; never drop a section.

(示例：实际合并调用中，上述前言之后依次是每片的分片摘要——形如 "Partial checkpoint 1 of N:" 后跟 <compacted-summary>…</compacted-summary>，每片一条；末尾再附上与上方完全相同的「主压缩指令」(若开启补充规则,则连同其后的补充规则一并附上)。)`;

		// ------------------------------------------------------------------
		// Field registry. path(value) may depend on the current section value.
		// ------------------------------------------------------------------
		function getAt(obj, path) {
			let cur = obj;
			for (const key of path) {
				if (cur === null || typeof cur !== 'object') return undefined;
				cur = cur[key];
			}
			return cur;
		}

		/** True when the user layer actually defines this path (override badge). */
		function hasAt(obj, path) {
			let cur = obj;
			for (const key of path) {
				if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, key)) return false;
				cur = cur[key];
			}
			return true;
		}

		function modelList(value) {
			const models = value && value.models;
			return Array.isArray(models) ? models.filter((m) => typeof m === 'string' && m.length > 0) : [];
		}

		const numberParse = (text) => {
			const trimmed = text.trim();
			if (trimmed === '') return { kind: 'clear' };
			const parsed = Number(trimmed);
			return Number.isFinite(parsed) ? { kind: 'set', value: parsed } : undefined;
		};

		const FIELDS = [
			{
				id: 'models', path: () => ['models'], labelKey: 'modelsLabel', hintKey: 'modelsHint', tipKey: 'tipModels',
				format: (v) => Array.isArray(v) ? v.join(', ') : (typeof v === 'string' ? v : ''),
				parse: (text) => {
					const items = text.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
					return items.length > 0 ? { kind: 'set', value: items } : { kind: 'clear' };
				},
			},
			{
				id: 'enableThinkingOff', path: () => ['enableThinkingOff'], labelKey: 'enableThinkingOffLabel', hintKey: 'enableThinkingOffHint', tipKey: 'tipEnableThinkingOff', bool: true,
			},
			{
				id: 'wireReasoning', path: () => ['wireReasoning'], labelKey: 'wireReasoningLabel', hintKey: 'wireReasoningHint', tipKey: 'tipWireReasoning',
				enum: ['', 'none', 'low', 'medium', 'high'],
				format: (v) => typeof v === 'string' ? v : '',
				parse: (text) => {
					const trimmed = text.trim();
					return trimmed === '' ? { kind: 'clear' } : { kind: 'set', value: trimmed };
				},
			},
			{
				id: 'maxTokensFloor', path: () => ['maxTokensFloor'], labelKey: 'maxTokensFloorLabel', hintKey: 'maxTokensFloorHint', tipKey: 'tipMaxTokensFloor', numeric: true,
				format: (v) => typeof v === 'number' ? String(v) : '', parse: numberParse,
			},
			{
				id: 'chunkingEnabled', path: () => ['chunking', 'enabled'], labelKey: 'rescueLabel', hintKey: 'rescueHint', tipKey: 'tipChunkingEnabled', bool: true,
			},
			{
				id: 'newContextEnabled', path: () => ['command', 'newContext', 'enabled'], labelKey: 'newContextLabel', hintKey: 'newContextHint', tipKey: 'tipNewContext', bool: true,
			},
			{
				id: 'supplementOn', path: () => ['supplementOn'], labelKey: 'supplementOnLabel', hintKey: 'supplementOnHint', tipKey: 'tipSupplementOn', bool: true,
			},
			{
				id: 'autoRescueEnabled', path: () => ['autoCompaction', 'enabled'], labelKey: 'autoRescueLabel', hintKey: 'autoRescueHint', tipKey: 'tipAutoRescue', bool: true,
			},
		];

		const ADVANCED_FIELDS = [
			{ id: 'temperature', path: () => ['sampling', 'temperature'], labelKey: 'temperatureLabel', tipKey: 'tipSampling', numeric: true },
			{ id: 'topP', path: () => ['sampling', 'top_p'], labelKey: 'topPLabel', tipKey: 'tipSampling', numeric: true },
			{ id: 'topK', path: () => ['sampling', 'top_k'], labelKey: 'topKLabel', tipKey: 'tipSampling', numeric: true },
			{ id: 'minP', path: () => ['sampling', 'min_p'], labelKey: 'minPLabel', tipKey: 'tipSampling', numeric: true },
			{ id: 'presencePenalty', path: () => ['sampling', 'presence_penalty'], labelKey: 'presencePenaltyLabel', tipKey: 'tipSampling', numeric: true },
			{ id: 'repetitionPenalty', path: () => ['sampling', 'repetition_penalty'], labelKey: 'repetitionPenaltyLabel', tipKey: 'tipSampling', numeric: true },
			{ id: 'chunkRatio', path: () => ['chunking', 'chunkRatio'], labelKey: 'chunkRatioLabel', tipKey: 'tipChunkRatio', numeric: true, rescueDependent: true },
			{ id: 'chunkMaxTokens', path: () => ['chunking', 'chunkMaxTokens'], labelKey: 'chunkMaxTokensLabel', tipKey: 'tipChunkMaxTokens', numeric: true, rescueDependent: true },
			{ id: 'mergeMaxTokens', path: () => ['chunking', 'mergeMaxTokens'], labelKey: 'mergeMaxTokensLabel', tipKey: 'tipMergeMaxTokens', numeric: true, rescueDependent: true },
			{ id: 'maxChunks', path: () => ['chunking', 'maxChunks'], labelKey: 'maxChunksLabel', tipKey: 'tipMaxChunks', numeric: true, rescueDependent: true },
			{ id: 'autoRatio', path: () => ['autoCompaction', 'thresholdRatio'], labelKey: 'autoRatioLabel', tipKey: 'tipAutoRatio', numeric: true, autoDependent: true },
			{ id: 'autoMaxRetries', path: () => ['autoCompaction', 'maxOverflowRetries'], labelKey: 'autoMaxRetriesLabel', tipKey: 'tipAutoMaxRetries', numeric: true, autoDependent: true },
		].map((f) => ({ ...f, format: (v) => typeof v === 'number' ? String(v) : '', parse: numberParse }));

		const ALL_FIELDS = FIELDS.concat(ADVANCED_FIELDS);
		const FIELD_BY_ID = Object.fromEntries(ALL_FIELDS.map((f) => [f.id, f]));

		// ------------------------------------------------------------------
		// Controller: staged form over the bound settings scope.
		// ------------------------------------------------------------------
		class Qwen38CardController {
			constructor(scope) {
				this.scope = scope || null;
				// fieldId -> { text, clear } — mirrors the built-in CardForm staging model:
				// a plain edit stages {text, clear:false}; resetField stages {text: baseValue,
				// clear:true} so saving emits an unset op (the "overrides default" badge is
				// what users click to drop a stored override).
				this.staged = new Map();
				// modelId -> { text, clear } for the per-model context windows.
				this.stagedWindows = new Map();
				this.saving = false;
				this.failed = false;
				// Disclosure is card-local state (mirrors the built-in plugin cards):
				// which card the user has open is a reading gesture, not persisted.
				this.open = false;
				this.store = createSnapshotStore(this.project());
				if (this.scope) this.scope.subscribe(() => this.publish());
			}

			project() {
				const snap = this.scope ? this.scope.getSnapshot() : null;
				const value = (snap && snap.value) || {};
				const fields = {};
				for (const f of ALL_FIELDS) {
					const path = f.path(value);
					const raw = getAt(value, path);
					const entry = this.staged.get(f.id);
					let text;
					let overridden;
					let invalid = false;
					if (entry === undefined) {
						text = f.bool ? String(Boolean(raw)) : f.format(raw);
						overridden = hasAt(snap.user, path);
					} else {
						text = entry.text;
						const write = entry.clear
							? { kind: 'clear' }
							: f.bool ? { kind: 'set', value: entry.text === 'true' } : f.parse(entry.text);
						overridden = write !== undefined && write.kind === 'set';
						invalid = !entry.clear && write === undefined;
					}
					fields[f.id] = { text, overridden, invalid };
				}
				// Per-model context windows (one row per model id in `models`).
				const models = modelList(value);
				const stagedModels = this.staged.has('models') && !this.staged.get('models').clear
					? this.staged.get('models').text.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean)
					: models;
				const windows = {};
				for (const model of stagedModels) {
					const path = ['chunking', 'contextWindows', model];
					const raw = getAt(value, path);
					const entry = this.stagedWindows.get(model);
					let text;
					let overridden;
					let invalid = false;
					if (entry === undefined) {
						text = typeof raw === 'number' ? String(raw) : '';
						overridden = hasAt(snap.user, path);
					} else {
						text = entry.text;
						const write = entry.clear ? { kind: 'clear' } : numberParse(entry.text);
						overridden = write !== undefined && write.kind === 'set';
						invalid = !entry.clear && write === undefined;
					}
					windows[model] = { text, overridden, invalid };
				}
			// Rescue master switch (staged value wins): gates the chunking group.
			const ce = this.staged.get('chunkingEnabled');
			const rescueOn = ce === undefined
				? Boolean(getAt(value, ['chunking', 'enabled']))
				: ce.text === 'true';
			// Auto-rescue master switch (staged value wins): gates the autoCompaction scalars.
			const ae = this.staged.get('autoRescueEnabled');
			const autoOn = ae === undefined
				? Boolean(getAt(value, ['autoCompaction', 'enabled']))
				: ae.text === 'true';
			return {
				status: snap ? snap.status : 'loading',
				writable: Boolean(snap && snap.writable),
				models: stagedModels,
				fields,
				windows,
				rescueOn,
				autoOn,
				open: this.open,
				dirty: this.staged.size > 0 || this.stagedWindows.size > 0,
				saving: this.saving,
				failed: this.failed,
			};
			}

			publish() {
				this.store.set(this.project());
			}

			toggleOpen() {
				this.open = !this.open;
				this.publish();
			}

			edit(id, text) {
				if (!FIELD_BY_ID[id]) return;
				this.staged.set(id, { text, clear: false });
				this.failed = false;
				this.publish();
			}

			resetField(id) {
				const f = FIELD_BY_ID[id];
				if (!f) return;
				const snap = this.scope ? this.scope.getSnapshot() : null;
				const base = getAt((snap && snap.base) || {}, f.path((snap && snap.value) || {}));
				this.staged.set(id, { text: f.bool ? String(Boolean(base)) : f.format(base), clear: true });
				this.failed = false;
				this.publish();
			}

			editWindow(model, text) {
				if (typeof model !== 'string' || model.length === 0) return;
				this.stagedWindows.set(model, { text, clear: false });
				this.failed = false;
				this.publish();
			}

			resetWindow(model) {
				const snap = this.scope ? this.scope.getSnapshot() : null;
				const base = getAt((snap && snap.base) || {}, ['chunking', 'contextWindows', model]);
				this.stagedWindows.set(model, { text: typeof base === 'number' ? String(base) : '', clear: true });
				this.failed = false;
				this.publish();
			}

			discard() {
				this.staged.clear();
				this.stagedWindows.clear();
				this.failed = false;
				this.publish();
			}

			async save() {
				const snap = this.scope ? this.scope.getSnapshot() : null;
				if (!snap || !snap.writable || this.saving) return;
				const value = snap.value || {};
				const ops = [];
				for (const f of ALL_FIELDS) {
					if (!this.staged.has(f.id)) continue;
					const entry = this.staged.get(f.id);
					const write = entry.clear
						? { kind: 'clear' }
						: f.bool ? { kind: 'set', value: entry.text === 'true' } : f.parse(entry.text);
					if (write === undefined) return; // invalid field blocks the save
					const path = f.path(value);
					ops.push(write.kind === 'set' ? { op: 'set', path, value: write.value } : { op: 'unset', path });
				}
				for (const [model, entry] of this.stagedWindows) {
					const write = entry.clear ? { kind: 'clear' } : numberParse(entry.text);
					if (write === undefined) return; // invalid window blocks the save
					const path = ['chunking', 'contextWindows', model];
					ops.push(write.kind === 'set' ? { op: 'set', path, value: write.value } : { op: 'unset', path });
				}
				if (ops.length === 0) return;
				this.saving = true;
				this.failed = false;
				this.publish();
				try {
					if (this.scope) await this.scope.mutate(ops, snap.revision); else this.failed = true;
					// Same gesture as the built-in cards: collapse once the write settled.
					this.open = false;
					this.staged.clear();
					this.stagedWindows.clear();
				} catch (error) {
					this.failed = true;
				} finally {
					this.saving = false;
					this.publish();
				}
			}

			/** The face the slot entry injects into the card component. */
			inject() {
				return {
					// 槽位渲染器把 `hooks` 格的每个键绑定成组件侧的 `use<Key>`——
					// 键 `qwen38Card` → 组件里 `props.useQwen38Card(...)`。
					// 键名必须与调用点一致，否则组件拿到 undefined 直接抛
					// `props.useXxx is not a function`（槽位条目崩溃、表单空白）。
					hooks: { qwen38Card: this.store },
					edit: (id, text) => this.edit(id, text),
					resetField: (id) => this.resetField(id),
					editWindow: (model, text) => this.editWindow(model, text),
					resetWindow: (model) => this.resetWindow(model),
					save: () => this.save(),
					discard: () => this.discard(),
					toggleOpen: () => this.toggleOpen(),
				};
			}
		}

		// ------------------------------------------------------------------
		// UI atoms (plain React + inline styles; primitives for themed inputs).
		// ------------------------------------------------------------------
		const labelWidth = '230px';
		// Typography and rules follow the settings surface's own tokens (the
		// built-in cards), so nothing here reads as a foreign block: label 13px
		// primary, hints 12px tertiary, hairline separators from --dsw-alias-*.
		const rowStyle = { display: 'flex', alignItems: 'flex-start', gap: '16px', padding: '9px 0', borderBottom: '0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.14))' };
		const labelStyle = { flexBasis: labelWidth, flexGrow: 0, flexShrink: 0, fontSize: '13px', lineHeight: 1.5, paddingTop: '6px', color: 'var(--dsw-alias-label-primary, inherit)' };
		const controlStyle = { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '4px' };
		const inputRowStyle = { display: 'flex', alignItems: 'center', gap: '8px' };
		const hintStyle = { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, rgba(128,128,128,0.85))', lineHeight: 1.5 };
		const badgeStyle = { fontSize: '11.5px', marginLeft: '8px', border: 'none', background: 'none', cursor: 'pointer', color: 'var(--dsw-alias-label-tertiary, inherit)', textDecoration: 'underline dotted' };
		const sectionTitleStyle = { fontSize: '12.5px', fontWeight: 600, margin: '16px 0 4px', color: 'var(--dsw-alias-label-secondary, rgba(128,128,128,0.95))' };
		const scopeBannerStyle = {
			margin: '10px 0 12px', padding: '9px 12px', fontSize: '12px', lineHeight: 1.5,
			borderRadius: '8px', border: '0.5px solid var(--dsw-alias-label-warning, #b45309)',
			color: 'var(--dsw-alias-label-secondary, inherit)',
			background: 'color-mix(in srgb, var(--dsw-alias-label-warning, #f59e0b) 10%, transparent)',
		};
		const commandHintStyle = { margin: '0 0 6px', fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary, rgba(128,128,128,0.9))' };
		const promptSubTitleStyle = { fontSize: '12.5px', fontWeight: 600, margin: '10px 0 4px', color: 'var(--dsw-alias-label-primary, inherit)' };
		const promptPreStyle = {
			margin: '0 0 4px', padding: '10px 12px', fontSize: '12px', lineHeight: 1.55,
			fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
			whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowY: 'auto', maxHeight: '360px',
			borderRadius: '8px', border: '0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))',
			background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.06))',
		};

		// Plugin-card chrome copied from the built-in plugin cards
		// (ui-settings-plugins/PluginCard.module.css), expressed against the same
		// --dsw-alias-* tokens: a header naming the plugin over its description,
		// 16px radius on a layer-3 surface, and the controls only when open.
		const cardStyle = {
			listStyle: 'none', border: '0.5px solid var(--dsw-alias-border-l4, rgba(128,128,128,0.28))',
			borderRadius: '16px', background: 'var(--dsw-alias-bg-layer-3, transparent)',
			transition: 'border-color .16s, background .16s',
		};
		const cardOpenStyle = Object.assign({}, cardStyle, {
			background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.06))',
			borderColor: 'var(--dsw-alias-label-dimmed, rgba(128,128,128,0.45))',
		});
		const cardHeaderStyle = {
			width: '100%', appearance: 'none', border: 0, background: 'none',
			font: 'inherit', color: 'inherit', textAlign: 'left', cursor: 'pointer',
			display: 'flex', alignItems: 'center', gap: '12px',
			padding: '14px 16px', borderRadius: '12px',
		};
		const headTextStyle = { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '4px' };
		const cardNameStyle = { fontSize: '15px', fontWeight: 600, lineHeight: 1.4, color: 'var(--dsw-alias-label-primary, inherit)' };
		const cardDescStyle = { fontSize: '13px', lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary, rgba(128,128,128,0.85))' };
		const chevronStyle = { flex: 'none', color: 'var(--dsw-alias-label-tertiary, rgba(128,128,128,0.85))', transition: 'transform .16s' };
		const cardBodyStyle = { borderTop: '0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.18))', margin: '0 16px', paddingBottom: '8px' };

		/**
		 * Self-explanatory on/off switch (role=switch): a pill with a knob plus
		 * an explicit state word, so the current value never depends on reading
		 * a tiny checkbox.
		 */
		function Switch(props) {
			const on = props.checked;
			const disabled = Boolean(props.disabled);
			return h('button', {
				type: 'button',
				role: 'switch',
				'aria-checked': on ? 'true' : 'false',
				disabled,
				onClick: () => { if (!disabled) props.onChange(!on); },
				style: {
					display: 'inline-flex', alignItems: 'center', gap: '8px',
					border: '1px solid rgba(128,128,128,0.35)', borderRadius: '999px',
					background: on ? 'color-mix(in srgb, #16a34a 18%, transparent)' : 'transparent',
					padding: '4px 12px 4px 6px', cursor: disabled ? 'default' : 'pointer',
					fontSize: '12.5px', color: 'inherit', opacity: disabled ? 0.5 : 1,
				},
			},
				h('span', {
					style: {
						width: '26px', height: '15px', borderRadius: '999px', position: 'relative', flex: '0 0 auto',
						background: on ? '#16a34a' : 'rgba(128,128,128,0.4)', transition: 'background 120ms',
					},
				}, h('span', {
					style: {
						position: 'absolute', top: '1.5px', left: on ? '12.5px' : '1.5px',
						width: '12px', height: '12px', borderRadius: '50%', background: '#fff', transition: 'left 120ms',
					},
				})),
				h('span', null, on ? props.onLabel : props.offLabel),
			);
		}

		function OverrideBadge(props) {
			if (!props.overridden) return null;
			return h('button', { type: 'button', style: badgeStyle, title: props.t('reset'), onClick: props.onClick }, props.t('overridden'));
		}

		/** Label with a hover tooltip (title attribute) stating the field's
		 *  dependencies — “独立项” or which switch gates it. */
		function TipLabel(props) {
			return h('label', {
				style: Object.assign({}, labelStyle, { cursor: 'help' }),
				htmlFor: props.id,
				title: props.field.tipKey ? props.t(props.field.tipKey) : undefined,
			}, props.t(props.field.labelKey));
		}

		function FieldRow(props) {
			const t = props.t;
			const state = props.state || {};
			// A rescue-dependent row is inert (but keeps its value) while the
			// rescue master switch is off.
			const dimmed = Boolean(props.dimmed);
			const disabled = Boolean(props.disabled) || dimmed;
			const rowEl = Object.assign({}, rowStyle, dimmed ? { opacity: 0.45 } : {});
			if (props.field.bool) {
				return h('div', { style: rowEl },
					h(TipLabel, { id: props.id, t, field: props.field }),
					h('div', { style: controlStyle },
						h(Switch, {
							checked: state.text === 'true', disabled,
							onLabel: t('on'), offLabel: t('off'),
							onChange: (next) => props.onEdit(next ? 'true' : 'false'),
						}),
						h('span', { style: hintStyle }, t(props.field.hintKey)),
					),
				);
			}
			const control = props.field.enum ? h('select', {
				id: props.id, value: state.text || '', disabled,
				style: { width: '200px', maxWidth: '100%', padding: '4px 6px' },
				onChange: (e) => props.onEdit(e.target.value),
			}, props.field.enum.map((v) => h('option', { key: v || '__empty', value: v }, v === '' ? t('wireOmit') : v)))
				: h(Input, {
					id: props.id, value: state.text || '', disabled, 'aria-invalid': state.invalid || undefined,
					style: Object.assign({ width: '260px', maxWidth: '100%' }, state.invalid ? { borderColor: '#c0392b' } : {}),
					onChange: (e) => props.onEdit(e.target.value),
				});
			return h('div', { style: rowEl },
				h(TipLabel, { id: props.id, t, field: props.field }),
				h('div', { style: controlStyle },
					h('div', { style: inputRowStyle },
						control,
						h(OverrideBadge, { overridden: state.overridden, t, onClick: () => props.onReset() }),
					),
					props.field.hintKey ? h('span', { style: hintStyle }, t(props.field.hintKey)) : null,
				),
			);
		}

		function WindowRow(props) {
			const t = props.t;
			const state = props.state || {};
			const dimmed = Boolean(props.dimmed);
			const disabled = Boolean(props.disabled) || dimmed;
			return h('div', { style: Object.assign({}, rowStyle, dimmed ? { opacity: 0.45 } : {}) },
				h('label', {
					style: Object.assign({}, labelStyle, { cursor: 'help' }),
					htmlFor: props.id, title: t('tipWindows'),
				}, props.model),
				h('div', { style: controlStyle },
					h('div', { style: inputRowStyle },
						h(Input, {
							id: props.id, value: state.text || '', disabled, 'aria-invalid': state.invalid || undefined, placeholder: '—',
							style: Object.assign({ width: '200px', maxWidth: '100%' }, state.invalid ? { borderColor: '#c0392b' } : {}),
							onChange: (e) => props.onEdit(e.target.value),
						}),
						h(OverrideBadge, { overridden: state.overridden, t, onClick: () => props.onReset() }),
					),
				),
			);
		}

		// Card body: scope banner + manual-command hint + grouped fields + footer.
		function Fields(props) {
			const t = props.t;
			const s = props.useQwen38Card((x) => x);
			const disabled = !s.writable || s.saving;
			return h(React.Fragment, null,
				h('p', { style: scopeBannerStyle }, '⚠️ ', t('scopeNote')),
				h('p', { style: commandHintStyle }, t('commandHint')),
				s.status === 'unavailable' ? h('p', null, t('unavailable')) : null,
				h('h4', { style: sectionTitleStyle }, t('basicTitle')),
				FIELDS.map((f) => h(FieldRow, {
					key: f.id, id: props.idPrefix + '-' + f.id, t, field: f, state: s.fields[f.id],
					disabled,
					onEdit: (text) => props.edit(f.id, text),
					onReset: () => props.resetField(f.id),
				})),
				h('div', { style: rowStyle },
					h('label', {
						style: Object.assign({}, labelStyle, { cursor: 'help' }), title: t('tipWindows'),
					}, t('windowsTitle')),
					h('div', { style: controlStyle },
						s.models.length === 0 ? h('span', { style: hintStyle }, '—') : s.models.map((model) => h(WindowRow, {
							key: model, id: props.idPrefix + '-win-' + model.replace(/[^a-zA-Z0-9_-]/g, '_'), t,
							model, state: s.windows[model], disabled, dimmed: !s.rescueOn,
							onEdit: (text) => props.editWindow(model, text),
							onReset: () => props.resetWindow(model),
						})),
						h('span', { style: hintStyle }, t('windowsHint')),
						!s.rescueOn ? h('span', { style: Object.assign({}, hintStyle, { color: '#b45309' }) }, '⚠️ ' + t('rescueOffNote')) : null,
					),
				),
				h('details', null,
					h('summary', { style: Object.assign({ display: 'block' }, sectionTitleStyle, { cursor: 'pointer' }) }, t('advancedTitle')),
					ADVANCED_FIELDS.map((f) => h(FieldRow, {
						key: f.id, id: props.idPrefix + '-' + f.id, t, field: f, state: s.fields[f.id],
						disabled, dimmed: (f.rescueDependent && !s.rescueOn) || (f.autoDependent && !s.autoOn),
						onEdit: (text) => props.edit(f.id, text),
						onReset: () => props.resetField(f.id),
					})),
				),
				h('details', { style: { margin: '4px 0' } },
					h('summary', { style: Object.assign({ display: 'block' }, sectionTitleStyle, { cursor: 'pointer' }) }, t('promptTitle')),
					h('p', { style: Object.assign({}, hintStyle, { margin: '6px 0' }) }, t('promptNote')),
					h('div', { style: promptSubTitleStyle }, t('mainPromptTitle')),
					h('pre', { style: promptPreStyle }, MAIN_PROMPT_TEXT),
					h('p', { style: hintStyle }, t('mainPromptNote')),
					h('div', { style: promptSubTitleStyle }, t('supplementTitle')),
					h('pre', { style: promptPreStyle }, SUPPLEMENT_TEXT),
					h('p', { style: hintStyle }, t('supplementNote')),
					h('div', { style: promptSubTitleStyle }, t('mergePromptTitle')),
					h('pre', { style: promptPreStyle }, MERGE_PREAMBLE_TEXT),
					h('p', { style: Object.assign({}, hintStyle, { marginBottom: '8px' }) }, t('mergePromptNote')),
				),
				h('footer', { style: { display: 'flex', gap: '8px', alignItems: 'center', padding: '12px 0 0' } },
					s.dirty && s.writable ? h(Button, { variant: 'primary', size: 'sm', disabled: s.saving || Object.values(s.fields).some((x) => x.invalid) || Object.values(s.windows).some((x) => x.invalid), onClick: () => props.save() }, s.saving ? t('saving') : t('save')) : null,
					s.dirty && s.writable ? h(Button, { variant: 'ghost', size: 'sm', disabled: s.saving, onClick: () => props.discard() }, t('discard')) : null,
					!s.writable && s.status === 'ready' ? h('span', { style: hintStyle }, t('readOnly')) : null,
					s.failed ? h('span', { style: Object.assign({ fontSize: '12px' }, hintStyle) }, t('saveFailed')) : null,
				),
			);
		}

		function Card(props) {
			const t = props.t;
			const s = props.useQwen38Card((x) => x);
			const open = Boolean(s.open);
			return h('li', { style: open ? cardOpenStyle : cardStyle },
				h('button', {
					type: 'button',
					style: cardHeaderStyle,
					'aria-expanded': open ? 'true' : 'false',
					'aria-label': t(open ? 'collapse' : 'expand') + ': ' + t('title'),
					onClick: () => props.toggleOpen(),
				},
					h('span', { style: headTextStyle },
						h('span', { style: cardNameStyle }, t('title')),
						h('span', { style: cardDescStyle }, t('description')),
					),
					s.dirty ? h(Tag, { tone: 'neutral' }, t('unsaved')) : null,
					h(IconChevronDownOutline14, {
						style: open ? Object.assign({}, chevronStyle, { transform: 'rotate(180deg)' }) : chevronStyle,
					}),
				),
				open
					? h('div', { style: cardBodyStyle },
						h(Fields, Object.assign({ idPrefix: 'plugin-config-gateway' }, props)),
					)
					: null,
			);
		}

		/**
		 * The same form on the dsh ≥ 0.1.6 Plugins page (ui-plugin-manager): the
		 * page draws the title, crumb and section frame itself and asks the
		 * `plugins.bundle.config` entry for `view: 'page'` only, so render the
		 * fields directly — no card chrome, no disclosure (the page IS open).
		 */
		function BundleConfig(props) {
			if (props.view !== 'page') return null;
			return h(Fields, Object.assign({ idPrefix: 'plugin-config-gateway-plugins' }, props));
		}

		// ------------------------------------------------------------------
		// Cordis client plugin surface.
		// ------------------------------------------------------------------
		exports.name = NS;
		exports.inject = ['slots', 'locale', 'configForms'];

		/**
		 * Register the locale dictionaries and the settings views.
		 * @param ctx - the browser Cordis context.
		 */
		exports.apply = function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, LOCALES), NS + ': client dictionaries');
			const t = typeof ctx.locale?.bind === 'function' ? ctx.locale.bind(NS) : (key) => String(key);
			// 0.1.7 原生设置面：configForms（@deepseek-ai/dsh-client-ui-settings 提供）；
			// 旧版 settings binder 服务已随 0.1.7 移除。服务缺失时 scope=null，卡片降级只读。
			let scope = null;
			try {
				const forms = typeof ctx.get === 'function' ? ctx.get('configForms') : (ctx.configForms ?? null);
				if (forms && typeof forms.get === 'function') scope = forms.get(NS) ?? null;
			} catch { scope = null; }
			const controller = new Qwen38CardController(scope);
			// 插件页该 bundle 的配置区：`plugins.bundle.config`（keyed；**key 必须是包名**，
			// 上游按 `ledger.bundles.has(pkg.name)` 决定是否渲染该区块）。
			// 注：旧槽 `settings.plugin.item` 已被上游 0.1.7-rc.1（commit 90af3110b7，
			// 2026-09-16）**退役**，取代它的是 `plugins.item`（官方设置页专用）/
			// `plugins.bundle.config`（bundle 表单）/ `plugins.row.config`（单个 row）。
			// 注册到退役槽位不报错——`slots.inject` 只等声明，等不到即永不触发——
			// 故此处不再保留指向退役槽位的注册（它只会白等，永不渲染）。
			ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
				name: 'plugins.bundle.config',
				key: 'dsh-gateway-compaction',
				locale: NS,
				inject: () => controller.inject(),
			}, BundleConfig));
		};

		return module.exports;
	}
});
