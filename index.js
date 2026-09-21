/**
 * qwen3.8-27b local-gateway (llama.cpp AND NInfer) compaction thinking fix:
 * auxiliary LLM calls (compaction summarization AND session-title generation)
 * run with thinking OFF and a `max_tokens` floor — but ONLY for the models in
 * the `models` allow-list (`Qwen3.8-27B-GGUF` by default). Every other model
 * passes through byte-identical with its route defaults. In addition, when the
 * conversation to be compacted is LARGER than the target model's context
 * window (the classic "chatted on a 1M-context model, then switched to a
 * 250k-context local model" case), the single-shot summarization call cannot
 * fit and dsh reports it as un-compactable; this plugin rescues exactly that
 * case with a chunked map-reduce summarization at the wire level.
 *
 * Supported gateways (the wire fields differ per engine):
 *   - llama.cpp (e.g. Unsloth Studio): `chat_template_kwargs.enable_thinking`
 *     + `reasoning_effort` + sampling + `max_tokens` floor.
 *   - NInfer (`ninfer-serve`): `reasoning_effort` + sampling + `max_tokens`
 *     floor. NInfer rejects `chat_template_kwargs` with a 400
 *     (`chat_template_option_not_supported`), so models served by NInfer must
 *     be listed in `ninModels`; the llama.cpp-specific merge is skipped for
 *     them automatically.
 *
 * Why feature 1 exists: local qwen3.8-27b deployments served by llama.cpp (here
 * via Unsloth Studio's OpenAI-compatible endpoint) think at their default
 * level on every call that does not explicitly disable thinking. The two
 * auxiliary calls DSH issues on the conversation's own route — compaction
 * summarization and session-title generation — carry small output budgets; the
 * model spends that entire budget on reasoning tokens, finishes `length` with
 * empty or truncated content, and the summarizer reports "truncated at the
 * token cap" while every generated title fails back to the first-prompt
 * fallback. This plugin turns thinking off for exactly those calls, applies
 * non-thinking-appropriate sampling settings, and restores the collapsed
 * `max_tokens` budget — gated to a model allow-list so nothing else is touched.
 *
 * Why feature 2 exists: dsh-compaction-basic summarizes with ONE llm/stream
 * call that replays the whole selected range as input. When the conversation
 * grew under a large-window model (e.g. 1M) and the route then switches to a
 * small-window model (e.g. 250k), even the retained-tail-free range exceeds
 * the new window: the summarization request itself overflows, every retry does
 * the same, and the session is stuck with "cannot compact" plus repeated
 * context-overflow errors on every turn. This plugin detects that situation at
 * the wire level (estimated prompt tokens of the compaction body exceed a
 * fraction of the model's configured window) and, instead of forwarding an
 * unforwardable request, runs the summarization itself: it splits the message
 * range into consecutive slices that fit, summarizes each slice with thinking
 * off, merges the partial checkpoints in one final call, and returns the merged
 * checkpoint to dsh as if the single-shot call had succeeded. The original
 * request is never sent when the rescue commits; every guard fails open, so a
 * miss or a mid-flight failure degrades to today's behavior, never worse.
 *
 * Wire fields for feature 1 (verified against llama.cpp build 10798 served
 * through Unsloth Studio; both mechanisms independently suppress thinking):
 *   - `chat_template_kwargs: { "enable_thinking": false }` — the Qwen3 chat
 *     template variable; the primary, documented switch for Qwen3 GGUF models
 *     on llama.cpp.
 *   - `reasoning_effort: "none"` — newer llama.cpp builds map this onto the
 *     chat template as well; sent as a second, independent belt-and-braces
 *     field.
 *
 * Layer 1: the `llm/stream` waterfall stamps `reasoningEffort: "off"` on calls
 * whose `purpose` is in `purposes` (default: `["compaction"]`, the compaction
 * engine's own tag) AND whose `options.model` is in `models`. This only fires
 * when the model's settings.yaml declaration offers expressible reasoning
 * efforts; for undeclared models it stays silent and layers 2+4 do the work at
 * the wire level.
 *
 * Layer 2 (HTTP compaction body): compaction summarization needs thinking off
 * AND sampling settings that the LLM options surface does not carry (`top_p`,
 * `top_k`, `min_p`, `presence_penalty`, `repetition_penalty`; `temperature` is
 * carried, but is applied here too so the whole parameter set lands in one
 * place). The OpenAI-compatible request body is built and stringified
 * downstream of the waterfall, so this plugin wraps the process-global
 * `fetch`: for chat-completion bodies that ARE the compaction summarization
 * call AND whose `model` field is in `models`, it merges
 * `chat_template_kwargs.enable_thinking = false` (preserving any other
 * template kwargs), writes the configured `reasoning_effort` wire value,
 * applies the configured `sampling` entries, raises the output cap to the
 * floor, and — when `supplementOn` is enabled (default) — appends this
 * plugin's `SUMMARY_SUPPLEMENT` after the official main instruction. That
 * single append point is what the chunked rescue reuses: its slice and merge
 * calls inherit the supplemented final user message verbatim.
 *
 * Layer 3 (HTTP max_tokens floor): pi-ai clamps every request's `max_tokens`
 * client-side (`clampMaxTokensToContext`): it estimates the context size from
 * the messages and requests at most `contextWindow − estimate − 4096` output
 * tokens, floored at 1. The estimator only uses real (server-reported) token
 * counts when a replayed assistant message carries usage — dsh-llm-pi-ai
 * rebuilds replayed assistant messages with zeroed usage, so for any large
 * conversation the estimator falls back to a chars/4 heuristic that
 * overestimates dense content severalfold. When the heuristic estimate
 * approaches the context window, the clamp collapses `max_tokens` to 1: the
 * model emits a single token, finishes `output_limit`, and dsh-compaction-
 * basic reports "summarization truncated at the token cap (incomplete
 * checkpoint)" even though the server (which knows the real prompt size) had
 * ample room. This layer restores the intended output budget on compaction
 * bodies only: it RAISES `max_tokens` to the configured floor, never lowers
 * it, and only on bodies carrying the compaction signature for an allowed
 * model. When headroom is genuinely scarce the server clamps to its real
 * capacity and finishes with an honest `context_capacity` stop — never worse
 * than today's 1-token result.
 *
 * Layer 4 (HTTP session-title thinking off): the session-title provider
 * (dsh-session-title-llm) issues its auxiliary call with a tiny output budget
 * (`maxTokens: 64` by composition default). On a gateway whose model thinks by
 * default, the model spends the entire 64-token budget on reasoning tokens,
 * finishes `length` with EMPTY content, and every generated title fails back
 * to the deterministic first-prompt fallback. The title plugin also deep-
 * freezes its LLM options BEFORE the `llm/stream` waterfall, so layer 1's
 * in-place stamp cannot reach it (the try/catch around the stamp exists for
 * exactly that case). This layer reaches the call where the frozen object no
 * longer matters — the wire body: when the chat-completion body carries the
 * title system prompt (see `TITLE_SIGNATURE`) AND its `model` field is in
 * `models`, it writes the same thinking-off wire fields as layer 2, so the
 * title model emits plain text within the 64-token budget. The title plugin's
 * own `max_tokens` is left exactly as set (the floor is compaction-only).
 *
 * Layer 5 (HTTP oversized-compaction rescue, feature 2): after layer 2 has
 * rewritten a compaction body, this layer estimates the prompt's size. When
 * it exceeds the per-call budget for the request's model — the window set on
 * the settings page, or auto-resolved (feature 2b: live gateway probe, then
 * the model's declaration in the dsh model config) — the wrapper does NOT
 * forward the original request. Instead it:
 *   - splits the message range into consecutive slices whose estimated input
 *     fits under the per-call budget (leading system/developer messages are
 *     re-sent with every slice; a `tool`-role message is never left orphaned
 *     at a slice start; a single message that alone exceeds the budget is
 *     head/tail-truncated for the internal call only — the durable surface is
 *     untouched);
 *   - summarizes each slice sequentially with `stream: false`, thinking off,
 *     the configured sampling, and `max_tokens = chunkMaxTokens` (each slice
 *     call receives the conversation's own final compaction instruction —
 *     including this plugin's supplement when enabled — verbatim as its last
 *     user message);
 *   - merges the partial checkpoints in one final call (`MERGE_PREAMBLE`
 *     consolidation rules, partials wrapped in `<compacted-summary>` tags,
 *     same final instruction) with
 *     `max_tokens = mergeMaxTokens`;
 *   - returns the merged checkpoint to dsh as a standard OpenAI response — an
     SSE stream with periodic keep-alive pings when the original request was
     streaming (pi-ai's 300s stream-idle timeout would otherwise kill a
     multi-minute rescue), or plain JSON otherwise.
 * `tools` schemas are dropped from the internal calls (the checkpoint does not
 * need them and they would be re-paid on every slice). When the rescue commits,
 * keep-alive pings hold the synthetic stream open while slices run; if any
 * slice or the merge ultimately fails (after one retry each), the stream ends
 * with EMPTY content, which dsh-compaction-basic rejects as "summarization
 * produced no text summary content" — the exact same safe outcome as today's
 * overflow failure: the conversation surface is preserved and the attempt is
 * logged. Pre-commit guards (unknown model window, more slices than
 * `maxChunks`, unparseable body) fail open by forwarding the original request
 * untouched.
 *
 * Feature 5 (automatic overflow rescue, this release): presets whose agent
 * composition ships no active dsh-compaction-basic engine (the minimal preset,
 * or any user preset without the compaction group) have NO built-in recovery
 * for a context-overflow 400 — the request error surfaces to the user as-is.
 * This plugin closes that gap by driving its own dsh-compaction-basic
 * instance (constructed with `auto: false`, so it registers none of the
 * official event listeners and is never registered as the `compaction`
 * service — the exact detached-context trick the manual commands use) from
 * two agent-loop waterfalls:
 *   - `agent/pre-step`: pressure pre-compaction at thresholdRatio of the
 *     model's context window (the plugin's `contextWindows` map refines the
 *     discovery value, so the 80% warning fires on the window the gateway
 *     really runs, not the larger n_ctx it declares);
 *   - `agent/request-error`: canonical context-overflow recovery
 *     (`failure.code === 'CONTEXT_WINDOW_EXCEEDED'`, the normalized form of
 *     the 400 a llama.cpp/NInfer gateway raises when the request exceeds
 *     the window): compact, then return `{ kind: 'retry' }` so the agent
 *     loop re-issues the request against the reduced surface. The retry
 *     budget per agent is `autoCompaction.maxOverflowRetries` (default 1)
 *     and resets on agent idle or the next assistant message — the same
 *     bookkeeping the official engine uses for its own recovery.
 * Sessions whose preset DOES mount an active dsh-compaction-basic are left
 * to that engine: the plugin detects the built-in through the app-level
 * `compaction` service or the agent preset's composition inventory and then
 * acts only as a fail-open fallback (at most one extra, budgeted recovery
 * per failure). The rescue engine's summarization calls flow through this
 * plugin's wire layers (1–5), so thinking-off, sampling, the max_tokens
 * floor and the oversized chunked rescue all apply to its summaries too.
 *
 * Identity for layers 2+3+5 is the compaction engine's own instruction:
 * dsh-compaction-basic appends it as the FINAL user message of every
 * compaction call, so its first line is a stable signature in the body. (If a
 * future dsh release changes that instruction, the HTTP gate silently stops
 * matching and the body keeps its wire defaults; the effort layer is
 * unaffected.)
 *
 * Per-call semantics (waterfall layer):
 *   - only calls whose `purpose` is in `purposes` AND whose `options.model`
 *     is in `models` are touched;
 *   - a call that already carries an explicit `reasoningEffort` wins —
 *     per-call beats the plugin default;
 *   - effort preference order: configured, then `off`, then `low`; a model
 *     offering none of them is left at its own default (one-time warning, and
 *     only when the wire-level thinking-off gates are also disabled);
 *   - `effort: ""` disables the effort policy.
 *
 * Configuration precedence (re-projected on every LLM call, so settings.yaml
 * edits apply without a restart):
 *   1. `qwen38-gateway-compaction:` section of `$DSH_HOME/settings.yaml`
 *   2. the `config:` block of this plugin's row in the profile's
 *      `cordis.patch.yml`
 *   3. built-in defaults (effort `"off"`, purposes `["compaction"]`,
 *      models `["Qwen3.8-27B-GGUF"]`)
 */
import z from "@deepseek-ai/schemastery";

// dsh-settings has two API generations, and which one this module resolves to
// depends on the host (npm releases vs source builds):
//   - 0.1.1-rc.x: free functions `installSettingsSection` / `settingsNamespace`
//     exported from the package;
//   - >= 0.1.3:   no free functions; the settings SERVICE exposes
//     `ctx.settings.installSection(owner, ns, schema, entry, hooks)` and
//     consumers reach it through the optional `ctx.inject(["settings"], cb)`.
// Import dynamically so one plugin source works with both; when neither
// surface is available (or no settings service is mounted), the composition
// entry — resolved against the schema below — remains the policy source.
const settingsApi = await import("@deepseek-ai/dsh-settings").catch(() => null);

/** Cordis plugin name used by loader diagnostics. */
const name = "qwen38-gateway-compaction";
/** Hard dependency: the LLM service owns the `llm/stream` waterfall. */
const inject = ["llm"];

/** Default summarization effort: thinking off, not the conversation's default. */
const DEFAULT_EFFORT = "off";
/** Primary fallback: the whole point is no thinking. */
const OFF_EFFORT = "off";
/** Secondary fallback when `off` is not expressible. */
const FALLBACK_EFFORT = "low";
/** LLM call purposes this policy applies to by default. */
const DEFAULT_PURPOSES = ["compaction"];
/**
 * Default model allow-list: the llama.cpp deployment this plugin was tuned
 * for (Unsloth Studio serves the loaded Qwen3.8-27B GGUF under this id, as
 * reported by its `/v1/models`). Exact id match against `settings.yaml`'s
 * `llm-pi-ai.providers.<provider>.models[].id`. An empty list disables the
 * policy.
 */
const DEFAULT_MODELS = ["Qwen3.8-27B-GGUF"];
/**
 * Default `reasoning_effort` wire value written into matched request bodies
 * (layers 2 and 4). Verified accepted by llama.cpp build 10798, where it maps
 * onto the Qwen3 chat template; `""` disables that field write entirely.
 */
const DEFAULT_WIRE_REASONING = "none";
/**
 * Default `max_tokens` floor for compaction bodies. dsh-compaction-basic's
 * own budget defaults to 8192; 16384 gives the summary headroom while staying
 * far below the headroom a 250k-token window leaves a large prompt. `0` (or
 * `null`) disables the floor.
 */
const DEFAULT_MAX_TOKENS_FLOOR = 16384;
/** Default: the oversized-compaction rescue is on. */
const DEFAULT_CHUNKING_ENABLED = true;
/**
 * Default per-slice input budget as a fraction of the model's context window.
 * The remainder covers the instruction, estimation error, and the slice's own
 * output cap.
 */
const DEFAULT_CHUNK_RATIO = 0.7;
/** Default output cap for one partial (per-slice) summary. */
const DEFAULT_CHUNK_MAX_TOKENS = 8192;
/** Default output cap for the final merged checkpoint. */
const DEFAULT_MERGE_MAX_TOKENS = 16384;
/** Default safety cap on the number of partial summaries per rescue. */
const DEFAULT_MAX_CHUNKS = 8;
/** Extra headroom (tokens) subtracted from the per-slice budget for estimation error. */
const CHUNK_MARGIN_TOKENS = 1024;
/** Interval between keep-alive pings on a synthetic stream while slices run. */
const KEEPALIVE_MS = 15000;
/** First keep-alive poll after the head chunk (short, so fast rescues stay snappy). */
const FIRST_KEEPALIVE_MS = 2000;
/** Wire field names of the supported sampling settings. Keys are written verbatim into the OpenAI-compatible chat-completion body; llama.cpp's server accepts all of them. */
const SAMPLING_KEYS = [
  "temperature",
  "top_p",
  "top_k",
  "min_p",
  "presence_penalty",
  "repetition_penalty"
];
/** Wire field names of the output cap, in the order the OpenAI-compatible surface may spell it. */
const MAX_TOKEN_KEYS = ["max_tokens", "max_completion_tokens"];
/** Body fields that internal (slice/merge) calls rebuild explicitly. */
const INTERNAL_CALL_REBUILT_FIELDS = ["messages", "tools", "stream", "max_tokens", "max_completion_tokens"];

/**
 * Sampling settings object; every field optional (a plain schemastery field
 * is nullable: absent keys stay absent), wire-named.
 */
const SamplingParams = z.object({
  /** Sample temperature for the summarization call. */
  temperature: z.number(),
  /** Nucleus sampling probability mass. */
  top_p: z.number(),
  /** Keep the top-K candidate tokens. */
  top_k: z.number(),
  /** Minimum token probability relative to the best token. */
  min_p: z.number(),
  /** Bias against already-present tokens. */
  presence_penalty: z.number(),
  /** Multiplicative penalty for repeated tokens (1.0 = neutral). */
  repetition_penalty: z.number()
});

/**
 * Oversized-compaction rescue config (feature 2). Every field optional;
 * defaults applied by the schema.
 */
const ChunkingConfig = z.object({
  /** Master switch for the chunked map-reduce rescue. Default `true`. */
  enabled: z.boolean().default(DEFAULT_CHUNKING_ENABLED),
  /**
   * Exact model id → context window (tokens) used to decide when a compaction
   * prompt is too large for one call. An explicit entry is used AS-IS and
   * outranks every auto source. Models absent from this map are resolved
   * automatically (feature 2b): live `GET {gateway}/v1/models` probe, then the
   * model's declaration in the dsh model config (settings.yaml, via the llm
   * service) — so a mid-task switch to a smaller-window model works without
   * touching this map. Default `{}`.
   */
  contextWindows: z.dict(z.number()).default({}),
  /** Per-slice input budget as a fraction of the model window, in (0, 1]. Default `0.7`. */
  chunkRatio: z.number().default(DEFAULT_CHUNK_RATIO),
  /** Output cap (`max_tokens`) for one partial per-slice summary. Default `8192`. */
  chunkMaxTokens: z.number().default(DEFAULT_CHUNK_MAX_TOKENS),
  /** Output cap (`max_tokens`) for the final merged checkpoint. Default `16384`. */
  mergeMaxTokens: z.number().default(DEFAULT_MERGE_MAX_TOKENS),
  /** Safety cap on partial summaries per rescue; a larger range fails open. Default `8`. */
  maxChunks: z.number().default(DEFAULT_MAX_CHUNKS)
});

/**
 * Manual compaction command config (feature 3). The `/qwen38-compact` slash
 * command runs the official dsh-compaction-basic manual transaction on the
 * receiving session — including sessions whose agent preset ships no
 * compaction engine at all (e.g. the minimal preset), where neither automatic
 * compaction nor the built-in `/compact` exist.
 *
 * The optional `/clear-context` command (feature 4, after Codex's
 * token-budget hard-rollover direction) does the same transaction with a
 * TEMPLATE summarizer: no LLM call, instant, zero token cost — the surface is
 * replaced by a fixed marker and the model continues from environment state.
 */
const CommandConfig = z.object({
  /** Master switch for the `/qwen38-compact` command. Default `true`. */
  enabled: z.boolean().default(true),
  /** The `/clear-context` hard-reset command. Default `{ enabled: true }`. */
  newContext: z.object({
    enabled: z.boolean().default(true)
  }).default({})
});

/**
 * Automatic overflow/pressure rescue config (feature 5). The plugin drives its
 * own dsh-compaction-basic instance (auto: false) for agents whose preset
 * ships no active built-in compaction engine. All keys mirror the engine's
 * own config keys (thresholdRatio/retainRatio/retainTokens/...), so a
 * settings.yaml author can port a preset's compaction block over verbatim.
 * `retainRatio` and `retainTokens` are mutually exclusive exactly as in the
 * engine (pass at most one; `retainTokens` wins if both are set).
 */
const AutoCompactionConfig = z.object({
  /** Master switch for the automatic rescue. Default `true`. */
  enabled: z.boolean().default(true),
  /** Pressure threshold as a fraction of the model context window. Default `0.8`. */
  thresholdRatio: z.number().default(0.8),
  /** Verbatim-tail fraction (mutually exclusive with `retainTokens`). */
  retainRatio: z.number(),
  /** Verbatim-tail budget in tokens (mutually exclusive with `retainRatio`). */
  retainTokens: z.number().step(1).min(0),
  /** Summarization route; empty pair = inherit the conversation's own model. */
  summarizationProvider: z.string().default(""),
  /** Summarization model; empty = inherit the conversation's own model. */
  summarizationModel: z.string().default(""),
  /** Output budget for the summary call. Default `8192`. */
  maxTokens: z.number().default(8192),
  /** Summary re-attempts while still over the pressure threshold. Default `1`. */
  compactionRetries: z.number().default(1),
  /** Overflow-retry budget per agent before the 400 is surfaced. Default `1`. */
  maxOverflowRetries: z.number().default(1)
});

/** Plugin config (all keys optional; defaults applied by the schema). */
const Config = z.object({
  /** Reasoning effort stamped onto matched calls. `""` disables the effort policy. Default `"off"`. */
  effort: z.string().default(DEFAULT_EFFORT),
  /** `purpose` tags of LLM calls the policy applies to. Default `["compaction"]`. */
  purposes: z.array(z.string()).default(DEFAULT_PURPOSES),
  /**
   * Exact model ids the policy applies to (case-sensitive, as declared in
   * settings.yaml). A call/body whose model is not in this list passes
   * through untouched. Empty list disables the policy entirely.
   * Default `["Qwen3.8-27B-GGUF"]`.
   */
  models: z.array(z.string()).default(DEFAULT_MODELS),
  /**
   * Exact model ids served by an **NInfer** gateway (case-sensitive, as
   * declared in settings.yaml). For these models the llama.cpp-specific
   * `chat_template_kwargs.enable_thinking` merge is skipped (NInfer rejects
   * the field with a 400); thinking is switched off via `reasoning_effort`
   * only. Models in `models` but not here are treated as llama.cpp.
   * Default `[]`.
   */
  ninModels: z.array(z.string()).default([]),
  /** Sampling settings applied to compaction request bodies; `{}` leaves sampling untouched. */
  sampling: SamplingParams.default({}),
  /**
   * `max_tokens` floor applied to compaction request bodies: the wire value
   * is raised to at least this number so the summarizer gets its output
   * budget back when pi-ai's client-side context clamp collapsed it (the
   * clamp estimates context from a chars/4 heuristic for replayed history,
   * which overestimates dense conversations and can drive `max_tokens` to 1).
   * Never lowers the value. `0` or `null` disables the floor. Default 16384.
   */
  maxTokensFloor: z.number().default(DEFAULT_MAX_TOKENS_FLOOR),
  /**
   * `reasoning_effort` wire value written into matched request bodies (layers
   * 2 and 4). llama.cpp maps it onto the Qwen3 chat template; `""` disables
   * this field write (the `chat_template_kwargs` gate still applies). Default
   * `"none"`.
   */
  wireReasoning: z.string().default(DEFAULT_WIRE_REASONING),
  /**
   * When true, layers 2 and 4 merge `enable_thinking: false` into the body's
   * `chat_template_kwargs` (the Qwen3 template variable; other template
   * kwargs are preserved). When false, `chat_template_kwargs` is never
   * touched. Default `true`.
   */
  enableThinkingOff: z.boolean().default(true),
  /**
   * When true, the plugin appends its supplementary requirements
   * (`SUMMARY_SUPPLEMENT`) after the official dsh-compaction-basic main
   * instruction on every matched compaction call — the single-shot call
   * (layer 2) and, via the rewritten final user message, each per-slice
   * call and the final merge of the chunked rescue. Design references:
   * agentscope-harness ConversationCompactor / MemoryConsolidator (recency
   * weighting, verbatim fidelity, latest-wins conflict rule, conversation
   * language output). When false, the official instruction is used
   * untouched. Default `true`.
   */
  supplementOn: z.boolean().default(true),
  /** Oversized-compaction rescue policy (feature 2); see ChunkingConfig. */
  chunking: ChunkingConfig.default({}),
  /** Manual commands (`/qwen38-compact`, `/clear-context`); see CommandConfig. */
  command: CommandConfig.default({}),
  /**
   * Automatic overflow/pressure rescue for presets without a built-in
   * compaction engine (feature 5); see AutoCompactionConfig.
   */
  autoCompaction: AutoCompactionConfig.default({})
});

/** Settings namespace carrying this plugin's policy (plain string; both dsh-settings generations validate the same kebab-case pattern). */
const COMPACT_EFFORT_SETTINGS_NAMESPACE = "qwen38-gateway-compaction";

/**
 * First line of the dsh-compaction-basic summarization instruction, which the
 * engine appends as the final user message of every compaction call. Used to
 * identify those requests at the HTTP layer. (If a future dsh release changes
 * that instruction, the HTTP layers silently stop matching — the effort layer
 * is unaffected — and the body keeps its wire defaults.)
 */
export const COMPACTION_SIGNATURE = "You are now acting as a compaction engine for this AI coding assistant";

/**
 * First line of the dsh-session-title-llm system prompt, which the title
 * provider sends verbatim on every session-title call. Used to identify those
 * requests at the HTTP layer (layer 4): the title plugin's LLM options are
 * deep-frozen before the waterfall, so only the wire body is reachable.
 */
export const TITLE_SIGNATURE = "Create a concise title for an AI coding-assistant session from the supplied human messages";

/**
 * First line of the supplementary block below; used as the idempotency
 * marker so a body that already carries the supplement (retries, the L5
 * internal calls reusing the rewritten final message) is never double-appended.
 */
export const SUPPLEMENT_MARKER =
  "Additional compaction requirements (appended by dsh-qwen38-gateway-compaction";

/**
 * Supplementary compaction requirements appended by this plugin AFTER the
 * official dsh-compaction-basic main instruction (feature: prompt
 * optimization, design informed by agentscope-harness's ConversationCompactor
 * / MemoryConsolidator prompts). Targets the measured weaknesses of the
 * stock instruction on long, multi-day coding sessions:
 *   - no recency weighting (oldest and newest material compressed equally),
 *   - no explicit "latest statement wins" conflict rule (chunked merges
 *     otherwise blend contradictory states),
 *   - the English-only output rule hurts Chinese-conversation checkpoints,
 *   - no hard rule against inventing content in empty sections.
 * Applied when `supplementOn` is true: layer 2 appends it to the final user
 * message of the single-shot compaction call, and the chunked path inherits
 * it on every per-slice call and the final merge (they reuse the rewritten
 * final user message verbatim). The main instruction is never replaced —
 * only extended — so the harness's structure contract (eight sections)
 * stays in force.
 */
export const SUMMARY_SUPPLEMENT = [
  SUPPLEMENT_MARKER + " plugin; where these conflict with the instruction above, THESE RULES WIN):",
  "",
  "1. Recency weighting: weight the most recent exchanges most heavily. Compress older material more aggressively, but never drop a decision, constraint, correction, or open question that still applies.",
  "2. Verbatim fidelity: preserve exact file paths, commands, ports and numeric values, identifiers, and error strings; quote the user's own words for instructions and corrections.",
  "3. In-flight work: for every task still in progress, state exactly what is done, what remains, and the single concrete next action.",
  "4. Conflict resolution: when facts conflict, the most recent statement wins; keep a superseded value only when the change itself matters.",
  "5. Language (OVERRIDES the 'concise English prose' rule above): write the checkpoint in the conversation's dominant language; keep code, paths, commands, and identifiers verbatim.",
  "6. Never invent facts that are not present in the conversation; if a section has no content, write \"(none)\"."
].join("\n");

/**
 * Preamble of the map-reduce MERGE call (feature 2). Replaces the old one-line
 * "split into N parts" framing: the partial checkpoints are lossy and may
 * disagree, so the merge step needs explicit consolidation rules (recency
 * wins, dedupe, union of facts, end-state for Current Work/Next Step) on top
 * of the main instruction that follows the partials.
 */
export const MERGE_PREAMBLE = [
  "The original conversation was too large to summarize in a single pass, so it was split into consecutive parts and each part was summarized separately. The partial checkpoints below are in chronological order. Merge them into the single final checkpoint.",
  "",
  "Merging rules:",
  "- Later parts are MORE recent: on any conflict, the most recent partial wins.",
  "- Deduplicate: state each fact once, in its most complete form.",
  "- Union of facts: a fact from any part survives unless a later partial supersedes it.",
  "- \"Current Work\" and \"Next Step\" must describe the state at the END of the conversation (the last partial), not an earlier point.",
  "- Keep every section of the required structure; never drop a section."
].join("\n");

/** Marks the wrapped global fetch so `apply` never double-wraps. */
const FETCH_WRAPPER_MARK = Symbol.for("qwen38-gateway-compaction.fetch-wrapper");

/**
 * Current policy config source, rebound by every `apply` so a re-apply
 * (in-process profile reload) never leaves the installed wrapper pointing at
 * a stale config.
 */
let policySource = () => ({
  entries: [], floor: 0, wireReasoning: "", enableThinkingOff: false, supplementOn: true,
  models: [], ninModels: new Set(), chunking: null,
  autoCompaction: autoCompactionEngineConfig({})
});

/**
 * Numeric sampling entries from one resolved config, in wire-key order.
 * @returns `[]` when nothing finite is configured.
 */
function samplingEntries(sampling) {
  if (sampling === null || typeof sampling !== "object") return [];
  const entries = [];
  for (const key of SAMPLING_KEYS) {
    const value = sampling[key];
    if (typeof value === "number" && Number.isFinite(value)) entries.push([key, value]);
  }
  return entries;
}

/** Coerce a config number to a finite positive integer, or `fallback`. */
function positiveInt(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** Coerce a config number to a finite non-negative integer, or `fallback`. */
function nonNegativeInt(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/**
 * Map the resolved `autoCompaction` section (feature 5) onto the engine
 * constructor arguments. Pure: settings object in, engine config out.
 * `auto` is ALWAYS false — the plugin drives the instance imperatively from
 * its own event listeners (see `registerAutoRescue`), never the engine's
 * built-in auto registration. `retainTokens` outranks `retainRatio` (the
 * engine rejects both at once). All invalid/missing scalars fall back to the
 * engine's own defaults so a partial settings.yaml section never breaks the
 * rescue.
 * @param raw - the `autoCompaction` section (or a partial one).
 * @returns `{ enabled: false }` or `{ enabled: true, engineConfig }`.
 */
export function autoCompactionEngineConfig(raw) {
  const source = raw !== null && typeof raw === "object" ? raw : {};
  if (source.enabled === false) return { enabled: false };
  const engineConfig = {
    auto: false,
    thresholdRatio: typeof source.thresholdRatio === "number" && Number.isFinite(source.thresholdRatio) && source.thresholdRatio > 0
    ? source.thresholdRatio
    : 0.8,
    summarizationProvider: typeof source.summarizationProvider === "string" ? source.summarizationProvider : "",
    summarizationModel: typeof source.summarizationModel === "string" ? source.summarizationModel : "",
    maxTokens: positiveInt(source.maxTokens, 8192),
    compactionRetries: nonNegativeInt(source.compactionRetries, 1),
    maxOverflowRetries: nonNegativeInt(source.maxOverflowRetries, 1)
  };
  if (typeof source.retainTokens === "number" && Number.isFinite(source.retainTokens) && source.retainTokens >= 0) {
    engineConfig.retainTokens = Math.floor(source.retainTokens);
  } else if (typeof source.retainRatio === "number" && Number.isFinite(source.retainRatio) && source.retainRatio > 0) {
    engineConfig.retainRatio = source.retainRatio;
  }
  return { enabled: true, engineConfig };
}

/**
 * The active HTTP-layer policy from one resolved config: the sampling
 * entries, an enabled max_tokens floor (0 = disabled), the `reasoning_effort`
 * wire value written into matched bodies ("" = field write disabled), whether
 * the `chat_template_kwargs.enable_thinking=false` merge is enabled, the model
 * allow-list ([] = policy disabled), and the normalized chunking policy (null
 * = rescue disabled).
 */
function policyOf(config) {
  const floorRaw = config?.maxTokensFloor;
  const floor = typeof floorRaw === "number" && Number.isFinite(floorRaw) && floorRaw > 0 ? Math.floor(floorRaw) : 0;
  const wireReasoning = typeof config?.wireReasoning === "string" ? config.wireReasoning : "";
  const enableThinkingOff = config?.enableThinkingOff === true;
  const supplementOn = config?.supplementOn !== false; // default true
  const models = Array.isArray(config?.models)
    ? config.models.filter((m) => typeof m === "string" && m.length > 0)
    : [];
  // NInfer-gateway models: served by an NInfer gateway whose OpenAI-compatible
  // endpoint rejects `chat_template_kwargs` (a llama.cpp-only option). For
  // these models the `enable_thinking` chat_template_kwargs merge is skipped
  // and thinking is switched off via `reasoning_effort` alone.
  const ninModels = new Set(
    Array.isArray(config?.ninModels)
      ? config.ninModels.filter((m) => typeof m === "string" && m.length > 0)
      : []
  );
  const raw = config?.chunking;
  let chunking = null;
  if (raw !== null && typeof raw === "object" && raw.enabled === true) {
    const ratio = typeof raw.chunkRatio === "number" && Number.isFinite(raw.chunkRatio) ? raw.chunkRatio : DEFAULT_CHUNK_RATIO;
    if (ratio > 0 && ratio <= 1) {
      chunking = {
        contextWindows: raw.contextWindows !== null && typeof raw.contextWindows === "object" ? raw.contextWindows : {},
        ratio,
        chunkMaxTokens: positiveInt(raw.chunkMaxTokens, DEFAULT_CHUNK_MAX_TOKENS),
        mergeMaxTokens: positiveInt(raw.mergeMaxTokens, DEFAULT_MERGE_MAX_TOKENS),
        maxChunks: positiveInt(raw.maxChunks, DEFAULT_MAX_CHUNKS)
      };
    }
  }
  return {
    entries: samplingEntries(config?.sampling), floor, wireReasoning, enableThinkingOff,
    supplementOn, models, ninModels, chunking,
    autoCompaction: autoCompactionEngineConfig(config?.autoCompaction)
  };
}

/**
 * Whether the policy's wire-level thinking-off gates are active at all (the
 * `chat_template_kwargs` merge and/or the `reasoning_effort` write).
 */
function thinkingOffActive(policy) {
  return policy?.enableThinkingOff === true || (typeof policy?.wireReasoning === "string" && policy.wireReasoning.length > 0);
}

/**
 * Extract the plain text of a chat-completion message content, whatever its
 * wire shape: a plain string, or an array of content blocks (the `text` fields
 * of the text-bearing blocks, joined). Anything else yields "".
 * @param content - the message's `content` field as parsed from the body.
 * @returns the concatenated text content.
 */
function messageText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block !== null && typeof block === "object" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}

/**
 * Whether the parsed body's `model` field is in the allow-list. Conservative:
 * a missing or non-string `model` never matches (no rewrite).
 * @param body - the parsed JSON chat-completion body.
 * @param models - the allow-list of exact model ids.
 * @returns true when the body targets an allowed model.
 */
function modelAllowed(body, models) {
  return Array.isArray(models) && typeof body?.model === "string" && models.includes(body.model);
}

/**
 * Write the thinking-off wire fields into a parsed chat-completion body:
 * merge `enable_thinking: false` into `chat_template_kwargs` (preserving any
 * other template kwargs already present) when enabled AND the body targets a
 * non-NInfer model (NInfer gateways reject `chat_template_kwargs` with a
 * 400; for `ninModels` entries thinking-off relies on `reasoning_effort`
 * alone), and set `reasoning_effort` to the configured value when configured.
 * Never touches any other field.
 * @param body - the parsed JSON chat-completion body (mutated in place).
 * @param policy - `{wireReasoning, enableThinkingOff, ninModels}` from the current config.
 * @returns true when at least one wire field was written.
 */
export function applyThinkingOff(body, policy) {
  if (body === null || typeof body !== "object") return false;
  let changed = false;
  // NInfer gateways reject `chat_template_kwargs` outright (400
  // chat_template_option_not_supported) — it is a llama.cpp-only option. For
  // NInfer models thinking is switched off via `reasoning_effort` below; the
  // chat_template_kwargs merge is llama.cpp-only.
  const ninSet = policy?.ninModels;
  const isNinModel =
    typeof ninSet === "object" && ninSet !== null && ninSet.has !== undefined
      ? ninSet.has(body.model)
      : false;
  if (policy?.enableThinkingOff === true && !isNinModel) {
    const existing = body.chat_template_kwargs;
    const target = existing !== null && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
    if (target.enable_thinking !== false) {
      target.enable_thinking = false;
      body.chat_template_kwargs = target;
      changed = true;
    }
  }
  const wire = typeof policy?.wireReasoning === "string" ? policy.wireReasoning : "";
  if (wire.length > 0 && body.reasoning_effort !== wire) {
    body.reasoning_effort = wire;
    changed = true;
  }
  return changed;
}

/**
 * Rewrite `init.body` in place when `init` carries the JSON chat-completion
 * body of a compaction summarization call FOR AN ALLOWED MODEL: write the
 * thinking-off wire fields, apply the sampling entries, raise the output
 * cap to the floor, and — when `supplementOn` is enabled — append this
 * plugin's supplementary requirements after the official main instruction
 * (which the chunked rescue then reuses on every slice and the merge). Every guard is conservative: any shape mismatch, parse
 * failure, missing signature, or disallowed model leaves the request
 * untouched.
 * @param init - the fetch init holding the stringified JSON body.
 * @param policy - `{entries, floor, wireReasoning, enableThinkingOff, models}` from the current config.
 * @returns true when the body was rewritten.
 */
export function rewriteCompactionBody(init, policy) {
  if (policy === null || typeof policy !== "object") return false;
  const entries = Array.isArray(policy.entries) ? policy.entries : [];
  const floor = typeof policy.floor === "number" && Number.isFinite(policy.floor) && policy.floor > 0 ? policy.floor : 0;
  const models = Array.isArray(policy.models) ? policy.models : [];
  if (entries.length === 0 && floor === 0 && !thinkingOffActive(policy) && policy.supplementOn !== true) return false;
  if (models.length === 0) return false;
  if (init === null || typeof init !== "object") return false;
  if (typeof init.body !== "string" || init.body.length === 0) return false;
  // Cheap pre-filter before parsing a potentially large body.
  if (!init.body.includes(COMPACTION_SIGNATURE)) return false;
  let body;
  try {
    body = JSON.parse(init.body);
  } catch {
    return false;
  }
  if (body === null || typeof body !== "object") return false;
  // Model gate: only rewrite bodies targeting an allowed model.
  if (!modelAllowed(body, models)) return false;
  if (!Array.isArray(body.messages) || body.messages.length === 0) return false;
  const last = body.messages[body.messages.length - 1];
  if (last === null || typeof last !== "object" || last.role !== "user") return false;
  // The compaction engine appends its instruction as the FINAL user message,
  // verbatim and unmodified — so a real compaction call's final user text
  // STARTS with the signature. Requiring the prefix (instead of searching
  // anywhere in the body) keeps this gate from matching conversation turns
  // that merely quote the signature inside tool results or history.
  const text = messageText(last.content);
  if (!text.startsWith(COMPACTION_SIGNATURE)) return false;
  let changed = applyThinkingOff(body, policy);
  for (const [key, value] of entries) {
    if (typeof key === "string" && typeof value === "number") {
      body[key] = value;
      changed = true;
    }
  }
  if (floor > 0) {
    for (const key of MAX_TOKEN_KEYS) {
      // RAISE ONLY: a cap the pipeline already set (larger or equal) is never
      // reduced; a collapsed cap (pi-ai's clamp) is restored.
      if (typeof body[key] === "number" && body[key] < floor) {
        body[key] = floor;
        changed = true;
      }
    }
  }
  // Strip tool schemas: the summarization prompt is self-contained text, and
  // Qwen3 on llama.cpp answers a tools-bearing thinking-off request with a
  // TOOL CALL (empty content) instead of the Markdown checkpoint — which dsh
  // then rejects as "no text summary content". Measured on build 10798:
  // tools + thinking off → finish_reason tool_calls, content ""; the same
  // body without tools → a proper checkpoint. (The engine keeps the tools in
  // the prompt only for KV-cache prefix affinity; correctness wins.)
  if ("tools" in body || "tool_choice" in body) {
    delete body.tools;
    delete body.tool_choice;
    changed = true;
  }
  // Prompt optimization (feature: 提示词优化): append this plugin's
  // supplementary requirements after the official main instruction. The
  // chunked rescue reuses this rewritten final user message for every
  // per-slice call and the final merge, so one append point covers all
  // internal calls. Idempotent via the marker first line: a body that
  // already carries the supplement (retry of the same logical request) is
  // left untouched. Content may be a plain string or a block array; both
  // are normalized to a string (the compaction instruction is always
  // plain text in practice).
  if (policy.supplementOn === true && !text.includes(SUPPLEMENT_MARKER)) {
    last.content = `${text}\n\n${SUMMARY_SUPPLEMENT}`;
    changed = true;
  }
  if (!changed) return false;
  init.body = JSON.stringify(body);
  return true;
}

/**
 * Rewrite `init.body` in place when `init` carries the JSON chat-completion
 * body of a session-title call FOR AN ALLOWED MODEL: write the thinking-off
 * wire fields so the gateway does not spend the 64-token title budget on
 * thinking. The compaction engine's own wire `max_tokens`/
 * `max_completion_tokens` is left exactly as the title plugin set it (the
 * floor and sampling are compaction-only). Every guard is conservative: any
 * shape mismatch, parse failure, missing signature, or disallowed model leaves
 * the request untouched.
 * @param init - the fetch init holding the stringified JSON body.
 * @param policy - `{wireReasoning, enableThinkingOff, models}` from the current config.
 * @returns true when the body was rewritten.
 */
export function rewriteTitleBody(init, policy) {
  if (policy === null || typeof policy !== "object") return false;
  const models = Array.isArray(policy.models) ? policy.models : [];
  if (!thinkingOffActive(policy)) return false;
  if (models.length === 0) return false;
  if (init === null || typeof init !== "object") return false;
  if (typeof init.body !== "string" || init.body.length === 0) return false;
  // Cheap pre-filter before parsing the body.
  if (!init.body.includes(TITLE_SIGNATURE)) return false;
  let body;
  try {
    body = JSON.parse(init.body);
  } catch {
    return false;
  }
  if (body === null || typeof body !== "object") return false;
  // Model gate: only rewrite bodies targeting an allowed model.
  if (!modelAllowed(body, models)) return false;
  if (!Array.isArray(body.messages) || body.messages.length === 0) return false;
  // Confirm the signature actually sits in the TITLE PROMPT itself: the title
  // provider sends it as the system prompt (adapter-mapped role, e.g.
  // `developer` or `system`), verbatim and unmodified — so a real title call's
  // system text STARTS with the signature. Requiring a system/developer role
  // plus a prefix match keeps this gate from matching conversation turns that
  // merely quote the signature inside tool results or history (e.g. while
  // debugging this very plugin).
  let matched = false;
  for (const message of body.messages) {
    if (message === null || typeof message !== "object") continue;
    if (message.role !== "system" && message.role !== "developer") continue;
    if (messageText(message.content).startsWith(TITLE_SIGNATURE)) { matched = true; break; }
  }
  if (!matched) return false;
  let changed = applyThinkingOff(body, policy);
  // Same tool-call trap as the compaction call: a thinking-off request that
  // carries tool schemas can come back as a tool call with no title text.
  if ("tools" in body || "tool_choice" in body) {
    delete body.tools;
    delete body.tool_choice;
    changed = true;
  }
  if (!changed) return false;
  init.body = JSON.stringify(body);
  return true;
}

// ---------------------------------------------------------------------------
// Feature 2: oversized-compaction rescue (chunked map-reduce at the wire level)
// ---------------------------------------------------------------------------

/** Count CJK-weighted characters in a string (conservative token estimation). */
function countCjk(text) {
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (
      (c >= 0x4e00 && c <= 0x9fff) || // CJK unified ideographs
      (c >= 0x3400 && c <= 0x4dbf) || // extension A
      (c >= 0xf900 && c <= 0xfaff) || // compatibility ideographs
      (c >= 0x3000 && c <= 0x303f) || // CJK punctuation
      (c >= 0xff00 && c <= 0xffef) // fullwidth forms
    ) {
      cjk += 1;
    }
  }
  return cjk;
}

/**
 * Conservative token estimate for one text: CJK characters count ~1 token each
 * (the dsh token-meter's chars/4 heuristic underprices CJK badly, and this
 * gate prefers to chunk early rather than overflow late); everything else
 * counts ~4 chars per token.
 * @param text - the text to estimate.
 * @returns the estimated token count (0 for non-strings).
 */
export function estimateTextTokens(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  const cjk = countCjk(text);
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

/** Conservative token estimate for one chat-completion message. */
export function estimateMessageTokens(message) {
  if (message === null || typeof message !== "object") return 0;
  let tokens = 6; // role + structural overhead
  tokens += estimateTextTokens(messageText(message.content));
  const toolCalls = message.tool_calls;
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    try {
      tokens += Math.ceil(JSON.stringify(toolCalls).length / 4);
    } catch {
      tokens += 256;
    }
  }
  // Image blocks: priced flat and conservatively (vision token counts vary by
  // resolution and are not visible on the wire).
  if (Array.isArray(message.content)) {
    const images = message.content.filter((block) => block !== null && typeof block === "object" && (block.type === "image_url" || block.image_url !== undefined)).length;
    tokens += images * 1024;
  }
  return tokens;
}

/**
 * Conservative token estimate for a whole chat-completion body's prompt: all
 * messages plus the `tools` schemas (when present). This is deliberately an
 * OVER-estimate for CJK-dense content: a false "oversized" verdict costs one
 * chunked rescue; a false "fits" verdict costs an overflow failure.
 * @param body - the parsed JSON chat-completion body.
 * @returns the estimated prompt token count.
 */
export function estimateBodyTokens(body) {
  if (body === null || typeof body !== "object") return 0;
  let tokens = 0;
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) tokens += estimateMessageTokens(message);
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    try {
      tokens += Math.ceil(JSON.stringify(body.tools).length / 4);
    } catch {
      tokens += 1024;
    }
  }
  return tokens;
}

/** Observed token density of a text (tokens per char), from the same heuristic as the estimator. */
function textDensity(text) {
  if (typeof text !== "string" || text.length === 0) return 0.25;
  const cjk = countCjk(text);
  return Math.max((cjk + (text.length - cjk) / 4) / text.length, 0.25);
}

/**
 * Head/tail-truncate a text to roughly `targetLen` characters (70% head, 25%
 * tail, marker in the middle).
 */
function shrinkText(text, targetLen) {
  if (text.length <= targetLen) return text;
  const headLen = Math.floor(targetLen * 0.7);
  const tailLen = Math.floor(targetLen * 0.25);
  return `${text.slice(0, headLen)}\n[... dsh-qwen38-gateway-compaction: truncated ${text.length - headLen - tailLen} chars to fit the chunk budget ...]\n${text.slice(text.length - tailLen)}`;
}

/**
 * Truncate one message's text content until its estimate fits `budget` — for
 * INTERNAL chunk calls only; the durable conversation surface is never
 * touched. The target length adapts to the text's own token density (a pure-
 * CJK text needs ~4x fewer chars than an ASCII one for the same budget), and
 * each round halves the allowance if the marker overhead still overflows.
 * Non-text shapes pass through unchanged.
 * @param message - the message to shrink.
 * @param budget - the target token budget.
 * @returns a (possibly new) message object that fits, or the original when it already does.
 */
export function truncateMessageToBudget(message, budget) {
  if (message === null || typeof message !== "object") return message;
  let current = message;
  for (let round = 0; round < 6 && estimateMessageTokens(current) > budget; round++) {
    const content = current.content;
    const allowance = Math.max(budget / 2 ** round, 1);
    if (typeof content === "string" && content.length > 64) {
      const targetLen = Math.max(32, Math.floor(allowance / textDensity(content)));
      current = { ...current, content: shrinkText(content, targetLen) };
      continue;
    }
    if (Array.isArray(content)) {
      // Shrink the largest text-bearing block.
      let bestIndex = -1;
      let bestLen = 0;
      for (let i = 0; i < content.length; i++) {
        const block = content[i];
        if (block !== null && typeof block === "object" && typeof block.text === "string" && block.text.length > bestLen) {
          bestIndex = i;
          bestLen = block.text.length;
        }
      }
      if (bestIndex < 0 || bestLen <= 64) return current; // nothing text-shaped left to shrink
      const text = content[bestIndex].text;
      const targetLen = Math.max(32, Math.floor(allowance / textDensity(text)));
      const next = content.slice();
      next[bestIndex] = { ...content[bestIndex], text: shrinkText(text, targetLen) };
      current = { ...current, content: next };
    } else {
      return current; // no text to truncate
    }
  }
  return current;
}

/**
 * Split a compaction body's message range into consecutive slices whose
 * estimated input fits `sliceBudget`:
 *   - leading system/developer messages are peeled off and returned as
 *     `prefix` (re-sent with every internal call);
 *   - a `tool`-role message is never the first message of a slice (it would be
 *     orphaned from its assistant `tool_calls`);
 *   - a single message that alone exceeds the budget is truncated in place
 *     (internal-call copy only).
 * @param messages - the body's full message array (instruction included; the caller strips it).
 * @param sliceBudget - per-slice input token budget.
 * @returns `{ prefix, slices }` with `slices` an array of message arrays in order, or null when nothing usable remains.
 */
export function sliceMessages(messages, sliceBudget) {
  if (!Array.isArray(messages) || messages.length === 0 || !(sliceBudget > 0)) return null;
  let start = 0;
  const prefix = [];
  while (start < messages.length) {
    const m = messages[start];
    if (m !== null && typeof m === "object" && (m.role === "system" || m.role === "developer")) {
      prefix.push(m);
      start += 1;
    } else break;
  }
  const rest = messages.slice(start);
  const slices = [];
  let cur = [];
  let curTokens = 0;
  for (let i = 0; i < rest.length; i++) {
    const raw = rest[i];
    if (raw === null || typeof raw !== "object") continue; // malformed entries cannot be priced or sent usefully
    let msg = raw;
    let tokens = estimateMessageTokens(msg);
    if (tokens > sliceBudget) {
      msg = truncateMessageToBudget(msg, sliceBudget);
      tokens = estimateMessageTokens(msg);
    }
    const startsNewSlice = cur.length > 0 && curTokens + tokens > sliceBudget;
    if (startsNewSlice && msg.role === "tool") {
      // Orphan guard: a tool result must stay with its assistant tool_calls.
      // The previous slice overflows its budget; that is the lesser evil.
    } else if (startsNewSlice) {
      slices.push(cur);
      cur = [];
      curTokens = 0;
    }
    cur.push(msg);
    curTokens += tokens;
  }
  if (cur.length > 0) slices.push(cur);
  if (slices.length === 0) return null;
  return { prefix, slices };
}

/**
 * Build one internal (slice or merge) request body from the rewritten
 * compaction body: keeps model + sampling + thinking-off fields, drops
 * `tools`/`stream`/output caps, and installs the given messages.
 * @param body - the rewritten compaction body.
 * @param messages - the internal call's message array.
 * @param maxTokens - the output cap for this internal call.
 * @returns a fresh plain object safe to stringify.
 */
export function buildInternalBody(body, messages, maxTokens) {
  const out = {};
  for (const [key, value] of Object.entries(body)) {
    if (INTERNAL_CALL_REBUILT_FIELDS.includes(key)) continue;
    out[key] = value;
  }
  out.stream = false;
  out.max_tokens = maxTokens;
  out.messages = messages;
  return out;
}

/** One SSE `data:` line for a chat.completion.chunk. */
function sseChunk(id, created, model, delta, finishReason) {
  const obj = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason === undefined ? null : finishReason }]
  };
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/** A complete non-stream chat.completion JSON response. */
function jsonResponse(id, created, model, content) {
  return new Response(
    JSON.stringify({
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

/**
 * Run one internal non-streaming chat-completion call through the ORIGINAL
 * fetch (bypassing this wrapper), and return its assistant text.
 * @param originalFetch - the unwrapped global fetch.
 * @param baseReq - a Request carrying url/headers/signal of the original call.
 * @param body - the internal request body.
 * @returns `{ content, finishReason }`; throws on HTTP or shape failure.
 */
async function internalCall(originalFetch, baseReq, body) {
  const req = new Request(baseReq, { body: JSON.stringify(body), signal: baseReq.signal });
  const res = await originalFetch(req);
  if (!res.ok) throw new Error(`internal call failed: HTTP ${res.status}`);
  const data = await res.json();
  const choice = Array.isArray(data?.choices) ? data.choices[0] : undefined;
  const content = choice !== null && typeof choice === "object" && typeof choice.message?.content === "string" ? choice.message.content : "";
  return { content, finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null };
}

/** Run an async fn with one retry; returns the value or throws the last error. */
async function withRetry(fn) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Window auto-resolution (feature 2b): the chunked rescue plans each slice
// against the gateway window the compaction call actually targets. The user
// may pin that number explicitly on the settings page (`contextWindows`);
// when they have not, the plugin resolves it instead of giving up — the
// classic case is switching a session to a SMALLER-window model mid-task
// (e.g. a 1M-window model after 400k of history → a 300k-window model):
// the switch does not re-configure this plugin, so the rescue must discover
// the new model's budget on its own.
//
// Resolution chain for a model without an explicit setting (first hit wins):
//   1. LIVE PROBE — `GET {gateway}/v1/models` on the gateway the compaction
//      request is addressed to; reads `context_length` / `context_window`
//      (llama.cpp discloses `context_length`; NInfer-style listings are
//      accepted too). 5-minute cache, 4s probe timeout; a probe that fails
//      or discloses nothing is remembered briefly and falls through.
//   2. DECLARATION — the dsh model config file (settings.yaml
//      `llm-pi-ai.providers.<p>.models[]`): the llm service's
//      `resolveModelInfo` exposes the user's declared `contextWindow` (+
//      `maxTokens`) for the model, no network needed. This is the 托底 the
//      user asked for: whatever their model config says is the last word.
// When neither source yields a window, the rescue stays disabled for that
// model (fail open, as before) and logs ONE actionable warning naming the
// exact gaps, instead of letting the request 400 silently.
//
// Declared/probed numbers are TOTAL windows (input + output share them on
// gateways that reserve the output cap up front, like NInfer). A total
// window therefore becomes an input budget by subtracting the model's
// output reservation (its configured max tokens, when known) plus a 5%
// headroom margin — e.g. 378144 − 192000 − 5% ≈ 167236, the NInfer Qwen3.8
// input ceiling this plugin previously hard-coded. Explicit settings-page
// values are used AS-IS: the user stated the window the gateway runs with.
// ---------------------------------------------------------------------------

/** Headroom kept from a declared TOTAL window when deriving an input budget. */
const WINDOW_MARGIN_RATIO = 0.05;
/** Cache TTL for a live gateway model-listing probe (hit or miss). */
const PROBE_TTL_MS = 5 * 60 * 1000;
/** Cache TTL for a model declaration lookup (settings.yaml edits are rare). */
const DECLARED_TTL_MS = 5 * 60 * 1000;
/** A model-listing probe is an optimization; never let it stall a rescue. */
const PROBE_TIMEOUT_MS = 4000;

const liveProbeCache = new Map(); // `${origin}|${model}` -> {value, expiresAt}
const declaredCache = new Map(); // model -> {value, expiresAt}
const missingWindowWarnings = new Set();

/**
 * Convert a declared TOTAL window into a safe per-call input budget.
 * @param totalWindow - the window the gateway runs with (tokens).
 * @param maxTokens - the output reservation the gateway enforces, or 0/unknown.
 * @returns the input budget in tokens (never negative).
 */
function deriveInputBudget(totalWindow, maxTokens) {
  if (typeof totalWindow !== "number" || !Number.isFinite(totalWindow) || totalWindow <= 0) return 0;
  const reserved = typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : 0;
  return Math.floor(totalWindow) - reserved - Math.floor(totalWindow * WINDOW_MARGIN_RATIO);
}

/**
 * The http(s) origin of the request the rescue is intercepting — the gateway
 * to probe. Empty string for anything that is not an http(s) URL.
 * @param input - the original fetch input (url string or Request-like).
 */
function requestOrigin(input) {
  try {
    let url = "";
    if (typeof input === "string") url = input;
    else if (input !== null && typeof input === "object") url = typeof input.url === "string" ? input.url : typeof input.href === "string" ? input.href : "";
    if (url === "") return "";
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : "";
  } catch {
    return "";
  }
}

function probeCacheGet(origin, model) {
  const hit = liveProbeCache.get(origin + "|" + model);
  if (!hit || hit.expiresAt <= Date.now()) return undefined; // absent or stale → re-probe
  return hit.value; // number (budget) | null (a remembered "no disclosure")
}

function probeCacheSet(origin, model, value) {
  liveProbeCache.set(origin + "|" + model, { value, expiresAt: Date.now() + PROBE_TTL_MS });
}

/**
 * One `GET {gateway}/v1/models` probe for the model's disclosed window.
 * @returns `{totalWindow, maxTokens}` or `null` (unreachable, no disclosure).
 */
async function probeGatewayWindow(originalFetch, origin, model) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await originalFetch(origin.replace(/\/+$/, "") + "/v1/models", {
      method: "GET",
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const payload = await res.json().catch(() => null);
    const entries = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : Array.isArray(payload) ? payload : null;
    if (!Array.isArray(entries)) return null;
    let entry = entries.find((m) => m !== null && typeof m === "object" && m.id === model);
    if (!entry) entry = entries.find((m) => m !== null && typeof m === "object" && typeof m.id === "string" && m.id.toLowerCase() === model.toLowerCase());
    if (entry === undefined || entry === null) return null;
    const totalWindow = Number(entry.context_length ?? entry.context_window ?? entry.contextWindow);
    if (!Number.isFinite(totalWindow) || totalWindow <= 0) return null;
    const maxTokensRaw = Number(entry.max_output_tokens ?? entry.maxOutputTokens ?? entry.max_tokens);
    return { totalWindow: Math.floor(totalWindow), maxTokens: Number.isFinite(maxTokensRaw) && maxTokensRaw > 0 ? Math.floor(maxTokensRaw) : 0 };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The dsh model config (settings.yaml declarations) as seen by the llm
 * service: the last-resort fallback, no network involved.
 * @returns the derived input budget, or `null` when the model is declared
 *   nowhere (or the llm service is unavailable).
 */
async function declaredWindowFor(llmService, model) {
  if (llmService === null || typeof llmService?.listProviders !== "function" || typeof llmService?.resolveModelInfo !== "function") return null;
  try {
    for (const provider of llmService.listProviders()) {
      const pid = provider !== null && typeof provider === "object" && typeof provider.id === "string" ? provider.id : null;
      if (!pid) continue;
      let info;
      try {
        info = await llmService.resolveModelInfo(pid, model);
      } catch {
        continue; // model is not owned by this provider
      }
      const window = info?.context?.contextWindow;
      if (typeof window === "number" && Number.isFinite(window) && window > 0) {
        return deriveInputBudget(window, info?.defaultMaxTokens);
      }
    }
  } catch {
    /* service shape changed: treat as undeclared */
  }
  return null;
}

/**
 * Resolve the input budget the rescue should plan against for `body`'s target
 * model: explicit settings value → live gateway probe → the dsh model config
 * declaration.
 * @returns `{window, source: "config"|"gateway"|"settings"}`, or `undefined`
 *   when nothing resolved (a one-shot actionable warning is logged naming the
 *   model and what to configure).
 */
async function resolveChunkWindow(policy, body, input, originalFetch, ctx) {
  const model = typeof body?.model === "string" && body.model !== "" ? body.model : "";
  if (model === "") return undefined;
  const explicit = policy?.chunking?.contextWindows?.[model];
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
    return { window: explicit, source: "config" };
  }
  const origin = requestOrigin(input);
  if (origin !== "") {
    const cached = probeCacheGet(origin, model);
    if (typeof cached === "number" && cached > 0) return { window: cached, source: "gateway" };
    if (cached === undefined) {
      // Not probed yet (or the probe cache expired): ask the gateway.
      const probed = await probeGatewayWindow(originalFetch, origin, model).catch(() => null);
      if (probed !== null) {
        const value = deriveInputBudget(probed.totalWindow, probed.maxTokens);
        probeCacheSet(origin, model, value);
        return { window: value, source: "gateway" };
      }
      probeCacheSet(origin, model, null); // remember the miss, briefly
    }
    // cached miss (null), or a probe that found nothing: fall through to the
    // dsh model-config declaration.
  }
  const cachedDeclared = declaredCache.get(model);
  if (cachedDeclared && cachedDeclared.expiresAt > Date.now()) {
    if (typeof cachedDeclared.value === "number") return { window: cachedDeclared.value, source: "settings" };
  } else {
    const value = await declaredWindowFor(ctx?.llm, model).catch(() => null);
    declaredCache.set(model, { value: value ?? null, expiresAt: Date.now() + DECLARED_TTL_MS });
    if (typeof value === "number") return { window: value, source: "settings" };
  }
  if (!missingWindowWarnings.has(model)) {
    missingWindowWarnings.add(model);
    ctx?.logger?.warn?.(
      `qwen38-gateway-compaction: model "${model}" has no resolvable context window (not set on the plugin settings page, no ${"/v1/models"} disclosure, no dsh model-config declaration); oversized compaction for it stays disabled. Set its context window on the plugin settings page, or declare contextWindow for "${model}" under its llm-pi-ai provider.`
    );
  }
  return undefined;
}

/**
 * The oversized-compaction rescue (layer 5 / feature 2). Called ONLY after
 * layer 2 has confirmed `init` is a compaction body for an allowed model.
 * Estimates the prompt; when it fits under the per-call budget, or chunking is
 * disabled/unknown for this model, returns undefined and the original request
 * is forwarded untouched. Otherwise commits to the map-reduce and returns a
 * synthetic Response (SSE stream or JSON) that dsh consumes as the summary.
 * Every guard fails open; a mid-flight failure ends the stream with EMPTY
 * content, which dsh-compaction-basic rejects cleanly ("summarization produced
 * no text summary content") — the same safe outcome as today's overflow.
 * @param ctx - plugin context (logger).
 * @param originalFetch - the unwrapped global fetch.
 * @param input - the original fetch input (url string or Request).
 * @param init - the (already rewritten) fetch init with the compaction body.
 * @param policy - the current policy including `chunking`.
 * @returns a synthetic Response, or undefined to forward the original request.
 */
export async function chunkedCompactionRescue(ctx, originalFetch, input, init, policy) {
  const cfg = policy?.chunking;
  if (cfg === null || typeof cfg !== "object") return undefined;
  if (typeof init?.body !== "string" || init.body.length === 0) return undefined;
  let body;
  try {
    body = JSON.parse(init.body);
  } catch {
    return undefined;
  }
  if (body === null || typeof body !== "object" || !Array.isArray(body.messages)) return undefined;
  const windowResult = await resolveChunkWindow(policy, body, input, originalFetch, ctx);
  if (windowResult === undefined) return undefined; // no resolvable window: the resolver logged an actionable warning
  const window = windowResult.window;
  const estimated = estimateBodyTokens(body);
  const callBudget = Math.floor(window * cfg.ratio);
  if (estimated <= callBudget) return undefined; // fits in one call: normal path
  // The final user message is the compaction instruction (layer 2 verified the
  // prefix); internal calls reuse it verbatim.
  const last = body.messages[body.messages.length - 1];
  const instructionText = messageText(last?.content);
  if (!instructionText.startsWith(COMPACTION_SIGNATURE)) return undefined;
  const rangeMessages = body.messages.slice(0, -1);
  // Leading system/developer messages are re-sent with EVERY internal call
  // (sliceMessages peels them into the prefix), so their cost comes out of
  // the per-slice budget too — otherwise every slice overflows by exactly the
  // size of the system prompt.
  let prefixEnd = 0;
  while (prefixEnd < rangeMessages.length) {
    const m = rangeMessages[prefixEnd];
    if (m !== null && typeof m === "object" && (m.role === "system" || m.role === "developer")) prefixEnd += 1;
    else break;
  }
  const prefixTokens = rangeMessages.slice(0, prefixEnd).reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  const sliceBudget = Math.max(callBudget - estimateTextTokens(instructionText) - prefixTokens - CHUNK_MARGIN_TOKENS, 4096);
  const sliced = sliceMessages(rangeMessages, sliceBudget);
  if (sliced === null || sliced.slices.length > cfg.maxChunks) {
    ctx.logger.warn(
      `qwen38-gateway-compaction: compaction prompt (~${estimated} tokens) exceeds the chunk budget for "${body.model}" and cannot be split within maxChunks=${cfg.maxChunks}; forwarding the original request (it will likely overflow)`
    );
    return undefined;
  }
  const { prefix, slices } = sliced;
  const sliceTokens = slices.map((slice) => slice.reduce((sum, m) => sum + estimateMessageTokens(m), 0));
  ctx.logger.info(
    `qwen38-gateway-compaction: compaction prompt (~${estimated} tokens) exceeds one call for "${body.model}" (window ${window}, budget ${callBudget}); running chunked map-reduce with ${slices.length} slices + merge`
  );
  const model = typeof body.model === "string" ? body.model : "unknown";
  const id = `chatcmpl-dshfix-${Math.random().toString(16).slice(2, 18)}`;
  const created = Math.floor(Date.now() / 1000);
  // Force POST: a bare url-string input would otherwise default to GET, and a
  // GET cannot carry the JSON bodies the internal calls send.
  const baseReq = new Request(input, { ...init, method: "POST" });

  const buildMergeMessages = (partials) => {
    const n = partials.length;
    return [
      // Consolidation rules (recency wins, dedupe, union of facts, end-state
      // for Current Work/Next Step) live in MERGE_PREAMBLE so the merge model
      // is told HOW to merge, not just that a merge is happening.
      { role: "user", content: MERGE_PREAMBLE },
      ...partials.map((partial, i) => ({
        role: "user",
        content: `Partial checkpoint ${i + 1} of ${n}:\n<compacted-summary>\n${partial}\n</compacted-summary>`
      })),
      { role: "user", content: instructionText }
    ];
  };
  const estimateMergeInput = (partials) => buildMergeMessages(partials).reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  async function runMerge(messages) {
    const merged = await withRetry(() => internalCall(originalFetch, baseReq, buildInternalBody(body, messages, cfg.mergeMaxTokens)));
    if (merged.content.length === 0) throw new Error("merge produced no summary text");
    return merged.content;
  }
  async function mergePartials(partials, depth) {
    // Normally one flat merge fits. When the partials themselves would not fit
    // (small windows + many large partials), merge hierarchically: halves
    // first, then the two results. Bounded depth; a final overflow throws and
    // degrades to the safe empty-summary outcome.
    if (estimateMergeInput(partials) <= callBudget || depth >= 2) return runMerge(buildMergeMessages(partials));
    ctx.logger.info(`qwen38-gateway-compaction: merge input (~${estimateMergeInput(partials)} tokens) exceeds one call; merging ${partials.length} partials hierarchically`);
    const mid = Math.ceil(partials.length / 2);
    const left = await mergePartials(partials.slice(0, mid), depth + 1);
    const right = await mergePartials(partials.slice(mid), depth + 2);
    return runMerge(buildMergeMessages([left, right]));
  }

  const work = (async () => {
    const partials = [];
    for (let i = 0; i < slices.length; i++) {
      ctx.logger.info(`qwen38-gateway-compaction: summarizing slice ${i + 1}/${slices.length} (~${sliceTokens[i]} tokens)`);
      const chunkBody = buildInternalBody(body, [...prefix, ...slices[i], { role: "user", content: instructionText }], cfg.chunkMaxTokens);
      const result = await withRetry(() => internalCall(originalFetch, baseReq, chunkBody));
      if (result.content.length === 0) throw new Error(`slice ${i + 1}/${slices.length} produced no summary text`);
      partials.push(result.content);
    }
    ctx.logger.info(`qwen38-gateway-compaction: merging ${partials.length} partial checkpoints into the final checkpoint`);
    return mergePartials(partials, 0);
  })();

  if (body.stream !== true) {
    // Non-streaming original: await the work and answer with plain JSON.
    try {
      const content = await work;
      ctx.logger.info(`qwen38-gateway-compaction: chunked compaction complete (${content.length} chars)`);
      return jsonResponse(id, created, model, content);
    } catch (error) {
      // Fail to the same safe outcome as today's overflow: an empty summary,
      // which dsh-compaction-basic rejects and the surface is preserved.
      ctx.logger.error(`qwen38-gateway-compaction: chunked compaction failed (${error?.message ?? error}); returning an empty summary so the harness keeps the conversation surface`);
      return jsonResponse(id, created, model, "");
    }
  }

  // Streaming original: synthetic SSE stream with keep-alive pings while the
  // slices run (pi-ai's stream idle timeout is 300s; a multi-minute rescue
  // must keep emitting).
  const state = { done: false, value: undefined, error: undefined };
  void work.then(
    (value) => {
      state.value = value;
      state.done = true;
    },
    (error) => {
      state.error = error;
      state.done = true;
    }
  );
  const generator = (async function* () {
    yield sseChunk(id, created, model, { role: "assistant", content: "" });
    let delay = FIRST_KEEPALIVE_MS;
    while (!state.done) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (!state.done) {
        yield ": keep-alive\n\n"; // SSE comment: valid, ignored by parsers
        delay = KEEPALIVE_MS;
      }
    }
    if (state.error !== undefined) {
      ctx.logger.error(`qwen38-gateway-compaction: chunked compaction failed (${state.error?.message ?? state.error}); ending the stream with an empty summary so the harness keeps the conversation surface`);
      yield sseChunk(id, created, model, { content: "" }, "stop");
    } else {
      ctx.logger.info(`qwen38-gateway-compaction: chunked compaction complete (${state.value.length} chars)`);
      yield sseChunk(id, created, model, { content: state.value });
      yield sseChunk(id, created, model, {}, "stop");
    }
    yield "data: [DONE]\n\n";
  })();
  return new Response(generator, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/**
 * Wrap the process-global `fetch` so compaction and session-title request
 * bodies receive the thinking-off wire fields (and, for compaction, the
 * sampling settings, the max_tokens floor, and — when the prompt no longer
 * fits one call — the chunked map-reduce rescue) at send time; only for bodies
 * whose `model` field is in the allow-list. The OpenAI SDK (pi-ai's transport)
 * resolves `fetch` from the global at client construction, and pi-ai builds a
 * fresh client per request, so wrapping here reaches every future LLM request
 * in this process. Non-matching requests pass through unmodified, and any
 * failure inside the gate leaves the request untouched. The wrapper is
 * installed once per process; a re-`apply` (profile reload in-process) only
 * rebinds the current policy source.
 */
function installSamplingFetch(ctx, readPolicy) {
  const g = globalThis;
  if (typeof g.fetch !== "function" || g.fetch[FETCH_WRAPPER_MARK] === true) {
    // Already wrapped (re-apply): just rebind the policy source.
    policySource = readPolicy;
    return;
  }
  const originalFetch = g.fetch;
  let applied = 0;
  let titleApplied = 0;
  const wrapper = async function llamacppCompactionSamplingFetch(input, init) {
    let policy;
    try {
      policy = policySource();
    } catch {
      policy = null;
    }
    if (policy !== null && typeof policy === "object") {
      let rewritten = false;
      try {
        rewritten = rewriteCompactionBody(init, policy);
      } catch {
        /* Never break LLM traffic: proceed with the untouched request. */
      }
      if (rewritten) {
        if (applied === 0) {
          const keys = (Array.isArray(policy.entries) ? policy.entries : []).map(([key]) => key).join(", ");
          const floorNote = policy.floor > 0 ? `; max_tokens floor ${policy.floor}` : "";
          ctx.logger.info(
            `qwen38-gateway-compaction: rewriting compaction request bodies (thinking off${keys.length > 0 ? `, sampling: ${keys}` : ""}${floorNote})`
          );
        }
        applied += 1;
        // Layer 5: when the rewritten prompt no longer fits one call for this
        // model, rescue it with a chunked map-reduce instead of forwarding an
        // unforwardable request. Any throw fails open to the original path.
        try {
          const rescued = await chunkedCompactionRescue(ctx, originalFetch, input, init, policy);
          if (rescued !== undefined) return rescued;
        } catch {
          /* fail open: forward the original request */
        }
      } else {
        let titleRewritten = false;
        try {
          // The title gate is independent of the compaction gate: a body is
          // either the compaction call or a title call, never both.
          titleRewritten = rewriteTitleBody(init, policy);
        } catch {
          /* Never break LLM traffic: proceed with the untouched request. */
        }
        if (titleRewritten && titleApplied === 0) {
          ctx.logger.info(`qwen38-gateway-compaction: rewriting session-title request bodies (thinking off)`);
        }
        if (titleRewritten) titleApplied += 1;
      }
    }
    return originalFetch.call(this, input, init);
  };
  wrapper[FETCH_WRAPPER_MARK] = true;
  g.fetch = wrapper;
  policySource = readPolicy;
}

/**
 * Pick the first level the model can express, in preference order: the
 * configured level, then `off`, then `low`.
 * @param configured - the configured (non-empty) effort.
 * @param offeredIds - effort ids the target model's reasoning metadata offers.
 * @returns the chosen effort id, or undefined when the model offers none.
 */
function chooseEffort(configured, offeredIds) {
  const seen = new Set();
  for (const candidate of [configured, OFF_EFFORT, FALLBACK_EFFORT]) {
    if (candidate.length === 0 || seen.has(candidate)) continue;
    seen.add(candidate);
    if (offeredIds.includes(candidate)) return candidate;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Feature 3 — manual compaction command (/qwen38-compact)
// ---------------------------------------------------------------------------

/** Command names users type in the composer. */
const MANUAL_COMPACT_COMMAND = "qwen38-compact";
const MANUAL_NEW_CONTEXT_COMMAND = "clear-context";

/**
 * Resolve (building on first use) the dsh-compaction-basic engine class.
 * The import is dynamic and fail-soft: when the package cannot be resolved
 * from this deployment the command reports that instead of crashing plugin
 * load. Cached per process; the class is stateless, instances are not.
 * @returns a promise for `{ Engine }` or `{ error }`.
 */
let engineClassPromise = null;
function manualEngineClass() {
  if (engineClassPromise === null) {
    engineClassPromise = (async () => {
      let mod;
      try {
        mod = await import("@deepseek-ai/dsh-compaction-basic");
      } catch (error) {
        return { error: `dsh-compaction-basic is not resolvable from this deployment (${error?.message ?? error})` };
      }
      const Engine = mod.BasicCompactionEngine ?? mod.default;
      if (typeof Engine !== "function") {
        return { error: "dsh-compaction-basic did not export a BasicCompactionEngine class" };
      }
      return { Engine };
    })();
  }
  return engineClassPromise;
}

/**
 * Fixed marker text installed by `/clear-context`. Kept short on purpose:
 * the engine refuses any summary that is not smaller than the shadowed
 * content, so the marker doubles as a minimum-size gate (a few lines of
 * history are not worth resetting). The engine wraps it in its standard
 * checkpoint framing.
 */
function hardResetMarkerText() {
  return [
    "## 上下文硬重置 (manual hard reset)",
    `- 本次由 /${MANUAL_NEW_CONTEXT_COMMAND} 于 ${new Date().toISOString()} 手动执行:此前对话历史已从模型可见上下文中丢弃。`,
    "- 原始事件日志仍在磁盘(会话日志可回查);环境状态(文件、git、运行中的服务)不受影响。",
    "- 请从当前环境状态继续任务,不要重述已完成的工作。"
  ].join("\n");
}

/**
 * Build the hard-reset engine class on top of the official one: the entire
 * manual transaction (idle check, range selection, stability assertion,
 * commit protocol, flush, rollback) stays official; only the summarizer is
 * swapped for a template that makes NO LLM call. The returned result uses
 * the "unmarked summarizer" SummaryResult variant (no `llmStreamCall`),
 * which dsh-compaction-basic explicitly supports for template/remote
 * backends.
 * @param Engine - the resolved BasicCompactionEngine class.
 */
function makeHardResetEngine(Engine) {
  return class Qwen38HardResetEngine extends Engine {
    // `summarize` is the engine's sole subclass hook; TS marks it protected,
    // which is convention-only at runtime — plain JS overrides freely.
    async summarize() {
      return {
        summary: [{ type: "text", text: hardResetMarkerText() }],
        provider: name,
        model: "hard-reset-template"
      };
    }
  };
}

/**
 * Friendly text for compaction failures. ManualCompactionError carries a
 * `code`; the engine's plain validation errors (e.g. "summary is not smaller
 * than the shadowed content") are matched by message pattern.
 */
function manualCompactFailureText(error, { hardReset = false } = {}) {
  const code = error && typeof error === "object" && typeof error.code === "string" ? error.code : "";
  switch (code) {
    case "busy": return "Agent 正忙(有进行中的轮次或排队任务),等它空闲后再试。";
    case "cancelled": return hardReset ? "硬重置已取消,会话未改动。" : "压缩已取消,会话未改动。";
    case "changed": return "历史在操作完成前发生了变化,本次未生效;会话未改动,可重试。";
    case "summary": return "模型没有产出可用的摘要,本次未生效;会话未改动,可重试。";
    case "commit": return "操作未能干净收尾,部分历史可能已变化;请检查会话状态后再试。";
    case "persistence": return "操作完成但会话保存失败;请检查存储后重试。";
    default: break;
  }
  const message = error && typeof error.message === "string" ? error.message : "";
  if (message.includes("not smaller than the shadowed")) {
    return hardReset
      ? "可重置的历史太短(丢弃后标记反而更大),本次未生效;会话未改动。"
      : "可压缩的历史太短(摘要不会比原文小),本次未生效;会话未改动。";
  }
  return undefined;
}

/**
 * Register the global manual commands (`/qwen38-compact` and, when enabled,
 * `/clear-context`). The engines and the commands live inside an
 * injected child context that declares exactly the services the manual
 * transaction needs (`commands`, `tokenMeter`, `sessions`; `llm` is inherited
 * from this plugin's own inject list). Global (not agent-scoped) registration
 * makes the commands visible to every session — including minimal-preset
 * sessions, whose agents mount no command plugins at all.
 *
 * Both engines are constructed with `auto: false`: NO automatic hooks (no
 * pre-step pressure checks, no overflow-retry listeners); they exist purely
 * to execute manual transactions. The compact engine's summarization call
 * goes through `ctx.llm.stream({ purpose: "compaction" })`, so this plugin's
 * wire layers (thinking-off, sampling, max_tokens floor) and the oversized-
 * compaction chunked rescue apply exactly as they do to the built-in engine.
 * The new-context engine swaps the summarizer for a fixed template — no LLM
 * call at all (see makeHardResetEngine).
 *
 * When any of the required services is absent from the deployment, cordis
 * never runs the callback: the plugin loads fine and simply has no command.
 * @param ctx - this plugin's context (must expose `inject`).
 * @param flags - which commands to register (live-reload re-runs apply;
 *   duplicate registration is a no-op).
 */

/**
 * A pass-through view of the injected child context that swallows service
 * registration. `CompactionEngine` hard-codes `super(ctx, "compaction")`, so
 * every engine instance registers itself as the `compaction` service — which
 * collides with the built-in engine in standard-preset sessions (and would
 * shadow it). The manual engines are used exclusively through their instances
 * (`compactNow`), never looked up by name, so detaching them from the service
 * registry is safe and makes both session types behave identically.
 * @param sctx - the injected child context.
 * @returns a proxy that no-ops `reflect.provide` and passes everything else through.
 */
function detachedEngineCtx(sctx) {
  return new Proxy(sctx, {
    get(target, prop, receiver) {
      if (prop === "reflect") {
        const reflect = Reflect.get(target, prop, receiver);
        if (reflect && typeof reflect === "object") {
          return new Proxy(reflect, {
            get(rTarget, rProp) {
              if (rProp === "provide") return () => {};
              return Reflect.get(rTarget, rProp);
            }
          });
        }
      }
      return Reflect.get(target, prop, receiver);
    }
  });
}

function registerManualCommands(ctx, flags) {
  if (typeof ctx?.inject !== "function") return;
  const { compactEnabled = true, newContextEnabled = false } = flags ?? {};
  try {
    ctx.inject(["commands", "tokenMeter", "sessions"], function qwen38ManualCommands(sctx) {
      const boot = (async () => {
        const resolved = await manualEngineClass();
        if (resolved.error !== undefined) return { error: resolved.error };
        try {
          const engines = {};
          // Detached contexts: the manual engines must not register (or
          // shadow) the `compaction` service — see detachedEngineCtx.
          if (compactEnabled) {
            engines.compact = new resolved.Engine(detachedEngineCtx(sctx), { auto: false });
          }
          if (newContextEnabled) {
            // Parens are load-bearing: `new f(x)(y)` parses as `new (f(x)(y))`,
            // which would invoke the returned class without `new`.
            const HardReset = makeHardResetEngine(resolved.Engine);
            engines.newContext = new HardReset(detachedEngineCtx(sctx), { auto: false });
          }
          return { engines };
        } catch (error) {
          return { error: `manual command engine construction failed (${error?.message ?? error})` };
        }
      })();

      const definitions = [];
      if (compactEnabled) {
        definitions.push({
          name: MANUAL_COMPACT_COMMAND,
          description: "手动把当前会话历史压缩成摘要检查点(调用模型总结,保信息;极简模式等无内置压缩引擎的会话也可用;超窗输入自动分片)",
          handler: async (invocation) => runManualTransaction({
            boot, kind: "compact", invocation, hardReset: false,
            noHistoryText: "当前会话还没有可压缩的历史。",
            successText: (result) => `已压缩 ${result.shadowedSeqs.length} 条历史(约 ${result.shadowedTokenCount} tokens)为摘要检查点。`
          })
        });
      }
      if (newContextEnabled) {
        definitions.push({
          name: MANUAL_NEW_CONTEXT_COMMAND,
          description: "硬重置当前会话上下文:不调用模型、秒级完成,历史直接丢弃(环境状态不变);适合任务状态都在文件/git 里的场景",
          handler: async (invocation) => runManualTransaction({
            boot, kind: "newContext", invocation, hardReset: true,
            noHistoryText: "当前会话还没有可重置的历史。",
            successText: (result) => `已硬重置上下文:${result.shadowedSeqs.length} 条历史(约 ${result.shadowedTokenCount} tokens)已丢弃,新窗口标记已写入;环境状态不变。`
          })
        });
      }

      for (const definition of definitions) {
        try {
          sctx.effect(function* () {
            yield sctx.commands.register(definition);
          }, `${name}: manual ${definition.name} command`);
        } catch {
          /* duplicate registration (in-process re-apply): keep the first */
        }
      }
    });
  } catch {
    /* inject unavailable or services missing: no command, plugin still loads */
  }
}

/**
 * Shared handler body for both manual commands: resolve the engine, run the
 * official transaction on the invocation's agent, and map failures to
 * friendly text (the transaction itself rolls back on any failure).
 * @param opts - boot promise + kind + invocation + presentation texts.
 */
async function runManualTransaction({ boot, kind, invocation, hardReset, noHistoryText, successText }) {
  const ready = await boot;
  if (ready.error !== undefined) {
    return { kind: "error", text: `无法执行手动操作:${ready.error}` };
  }
  const engine = ready.engines?.[kind];
  if (!engine) {
    return { kind: "error", text: "该命令已被配置禁用,请检查 settings.yaml 的 command 段。" };
  }
  try {
    const result = await engine.compactNow(invocation.agent, invocation.signal, invocation.commandId);
    if (result === null) {
      return { kind: "success", text: noHistoryText };
    }
    return {
      kind: "success",
      text: successText(result),
      sourceEventSeq: result.summarySeq
    };
  } catch (error) {
    if (invocation.signal?.aborted === true) {
      return { kind: "error", text: hardReset ? "硬重置已取消,会话未改动。" : "压缩已取消,会话未改动。" };
    }
    const friendly = manualCompactFailureText(error, { hardReset });
    if (friendly !== undefined) return { kind: "error", text: friendly };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Feature 5 — automatic overflow/pressure rescue for engine-less presets
// ---------------------------------------------------------------------------

/** npm name of the official engine (also the composition row key in preset inventories). */
const COMPACTION_BASIC_MODULE = "@deepseek-ai/dsh-compaction-basic";

/** Normalized failure code of a context-window overflow (dsh-llm `LlmFailure.code`). */
const CONTEXT_WINDOW_EXCEEDED_FALLBACK = "CONTEXT_WINDOW_EXCEEDED";

/** How long a preset-inventory snapshot stays fresh before a re-read. */
const INVENTORY_TTL_MS = 30_000;

/**
 * Lazy-resolve the dsh-llm overflow failure code so the plugin tracks harness
 * renames; falls back to the known literal when the package is unresolvable.
 * @returns a promise for the failure-code string.
 */
let overflowCodePromise = null;
function overflowCode() {
  if (overflowCodePromise === null) {
    overflowCodePromise = (async () => {
      try {
        const mod = await import("@deepseek-ai/dsh-llm");
        if (typeof mod?.CONTEXT_WINDOW_EXCEEDED_CODE === "string" && mod.CONTEXT_WINDOW_EXCEEDED_CODE.length > 0) {
          return mod.CONTEXT_WINDOW_EXCEEDED_CODE;
        }
      } catch {
        /* dsh-llm unresolvable: the literal below is the stable wire value */
      }
      return CONTEXT_WINDOW_EXCEEDED_FALLBACK;
    })();
  }
  return overflowCodePromise;
}

/**
 * Pure decision: does this agent's deployment already run an ACTIVE built-in
 * compaction engine that owns pressure/overflow recovery?
 *   - `"active"`: an engine owns it (app-level service with auto not disabled,
 *     or the agent's preset mounts dsh-compaction-basic) — the plugin must
 *     not double-act.
 *   - `"absent"`: no built-in anywhere; the plugin's rescue engine owns
 *     pressure + overflow recovery for this agent.
 *   - `"unknown"`: detection failed or the preset is unidentifiable — callers
 *     treat it like `"active"` (no rescue), the conservative side: a missed
 *     rescue surfaces the 400 (today's behavior), a false rescue risks
 *     double compaction on GPU.
 * @param appCompaction - value of `ctx.get("compaction")` (the app-level
 *   service, when the profile mounts one; realm-isolated preset engines are
 *   invisible here by design).
 * @param presetId - the session's `agentPreset` projection (string or null).
 * @param inventory - `{ byId: Map<string, boolean>, defaultId, error }` from
 *   `indexCompositionInventory` (or a failure marker), or null/undefined when
 *   no preset service exists in the profile.
 * @returns `"active"` | `"absent"` | `"unknown"`.
 */
export function decideBuiltInCompaction(appCompaction, presetId, inventory) {
  if (appCompaction !== undefined && appCompaction !== null) {
    const auto = appCompaction?.config?.auto;
    if (auto !== false) return "active";
  }
  if (inventory === undefined || inventory === null) return "absent";
  if (inventory.error) return "unknown";
  const id = typeof presetId === "string" && presetId.length > 0 ? presetId : inventory.defaultId;
  if (id === null || id === undefined || !inventory.byId.has(id)) return "unknown";
  return inventory.byId.get(id) ? "active" : "absent";
}

/**
 * Flatten a preset `compositionInventory()` list into per-preset flags: does
 * this preset's composition mount dsh-compaction-basic with effective
 * enablement (a `conditional` `!!js` row counts as enabled — the expression
 * is not evaluable from here, and deferring is the safe side)?
 * @param list - the `AgentPresetComposition[]` rows (id, rows, isDefault…).
 * @returns `{ byId, defaultId, error?: false }`.
 */
function indexCompositionInventory(list) {
  const byId = new Map();
  let defaultId = null;
  if (!Array.isArray(list)) return { byId, defaultId, error: true };
  for (const preset of list) {
    if (preset === null || typeof preset !== "object" || typeof preset.id !== "string") continue;
    if (byId.has(preset.id)) continue;
    const rows = Array.isArray(preset.rows) ? preset.rows : [];
    let has = false;
    for (const row of rows) {
      if (row && row.moduleName === COMPACTION_BASIC_MODULE && row.enabled !== false) {
        has = true;
        break;
      }
    }
    if (preset.broken !== undefined) has = false;
    byId.set(preset.id, has);
    if (defaultId === null && preset.isDefault === true) defaultId = preset.id;
  }
  return { byId, defaultId, error: false };
}

/**
 * Refine a model's discovery-reported context window with the operator's
 * declared window (this plugin's `contextWindows` map): the gateway may
 * declare a larger n_ctx than it actually runs, and the operator knows the
 * real one. A declared value smaller than the discovery value is kept
 * (hardware can't exceed it); otherwise the operator value wins. Pure: the
 * discovery object is never mutated (the llm service caches it).
 * @param model - the model id the call targets.
 * @param info - the discovery result object (or null).
 * @param windows - model id → declared window map (may be empty).
 * @returns the same object when nothing changes, else a shallow copy with a
 *   patched `context` slot.
 */
export function patchModelInfoWindows(model, info, windows) {
  if (info === null || typeof info !== "object") return info;
  const configured = typeof model === "string" && windows !== null && typeof windows === "object"
    ? windows[model]
    : undefined;
  if (typeof configured !== "number" || !Number.isFinite(configured) || configured <= 0) return info;
  const declared = info?.context?.contextWindow;
  if (typeof declared === "number" && Number.isFinite(declared) && declared <= configured) return info;
  const context = { ...(info.context ?? {}) };
  context.contextWindow = configured;
  return { ...info, context };
}

/**
 * Wrap an llm service so the engine's `resolveModelInfo` sees the operator's
 * declared context window for models in `windows` (see
 * patchModelInfoWindows). Every other member is passed through (functions
 * rebound to the service), so `llm.stream` — the summarization call this
 * plugin's wire layers inspect — is untouched.
 * @param llm - the llm service the engine resolves against.
 * @param windows - model id → declared context window map.
 */
function makeWindowedLlm(llm, windows) {
  if (llm === null || typeof llm !== "object") return llm;
  if (Object.keys(windows ?? {}).length === 0) return llm;
  return new Proxy(llm, {
    get(target, prop) {
      if (prop === "resolveModelInfo") {
        return (provider, model, signal) => {
          const call = typeof target.resolveModelInfo === "function"
            ? target.resolveModelInfo(provider, model, signal)
            : undefined;
          if (call === undefined || typeof call.then !== "function") return call;
          return call.then((info) => {
            try {
              return patchModelInfoWindows(model, info, windows);
            } catch {
              return info;
            }
          });
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

/**
 * Read the session's durably routed target of its latest request — the same
 * lookup the official engine performs before any recovery decision.
 * @param session - the agent's session.
 * @returns `{ provider, model }` or undefined.
 */
function routedTargetOf(session) {
  try {
    const config = session?.requestHeader?.()?.config;
    if (config
      && typeof config.provider === "string" && config.provider.length > 0
      && typeof config.model === "string" && config.model.length > 0) {
      return { provider: config.provider, model: config.model };
    }
  } catch {
    /* header unavailable (e.g. session not yet hydrated): no routable target */
  }
  return undefined;
}

/**
 * Feature 5 wiring: drive a detached dsh-compaction-basic instance (auto
 * off, never service-registered) from the agent-loop waterfalls for agents
 * whose preset ships no active built-in compaction engine.
 *
 * Safety invariants (all fail open — the original 400 always still surfaces):
 *   - an agent with an ACTIVE built-in engine (app-level service or the
 *     preset's composition) is never touched: the built-in owns recovery;
 *   - the overflow-retry budget is per agent (autoCompaction.maxOverflowRetries,
 *     default 1) and resets on agent idle or the next assistant message,
 *     mirroring the official engine's bookkeeping;
 *   - a recovery that does not advance the session surface (replaceGeneration
 *     unchanged) never triggers a retry;
 *   - every lookup (preset inventory, engine import, engine construction)
 *     degrades to pass-through with a one-time warning.
 *
 * The engine's summarization call runs through the plugin context's llm
 * service — with the operator's `contextWindows` map refined over the
 * discovery values — so the plugin's wire layers (thinking-off, sampling,
 * max_tokens floor, oversized chunked rescue) apply to the rescue's own
 * summaries exactly as to the built-in engine's.
 * @param ctx - the plugin context (provides events, llm, inject, logger).
 * @param readPolicy - () => the live policy object (see policyOf).
 */
function registerAutoRescue(ctx, readPolicy) {
  if (typeof ctx.get !== "function") {
    try {
      ctx.logger?.warn?.(
        "qwen38-gateway-compaction: ctx.get is unavailable on this harness; the automatic overflow rescue is disabled (built-in detection is impossible); the manual commands still work"
      );
    } catch { /* logging unavailable: stay silent */ }
    return;
  }
  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`qwen38-gateway-compaction: ${message}`);
    } catch { /* logging unavailable */ }
  };
  const info = (message) => {
    try {
      ctx.logger?.info?.(`qwen38-gateway-compaction: ${message}`);
    } catch { /* logging unavailable */ }
  };

  const overflowRetries = new WeakMap(); // Agent -> consecutive overflow retries
  const overflowAgents = new WeakMap(); // Session -> Agent (for the reset below)
  const warned = new Set();
  const engineCache = new Map(); // config key -> promise for {engine|error|disabled}
  const warnedErrors = new Set();

  // The engine is constructed in a child context that declares exactly the
  // services its transactions need; `llm` comes from this plugin's own
  // inject list (same arrangement as the manual commands).
  let childCtx = null;
  if (typeof ctx.inject === "function") {
    try {
      ctx.inject(["tokenMeter", "sessions"], (sctx) => {
        childCtx = sctx;
      });
    } catch {
      childCtx = null;
    }
  }

  const enginePolicy = () => readPolicy()?.autoCompaction ?? { enabled: false, engineConfig: null };

  const currentWindows = () => {
    const chunking = readPolicy()?.chunking;
    const map = chunking?.contextWindows;
    if (map === null || typeof map !== "object") return {};
    const out = {};
    for (const [key, value] of Object.entries(map)) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) out[key] = value;
    }
    return out;
  };

  function noteEngineError(error) {
    const key = `engine:${error}`;
    if (warnedErrors.has(key)) return;
    warnedErrors.add(key);
    warn(`the automatic overflow rescue is unavailable: ${error}`);
  }

  /**
   * Resolve (building on first use, per config key) the rescue engine bound
   * to the current policy. The engine never registers itself as the
   * `compaction` service (detached context), and its llm view carries the
   * operator's declared context windows over the discovery values.
   * @returns a promise for `{ engine }`, `{ error }`, or `{ disabled: true }`.
   */
  async function engineFor() {
    const policy = enginePolicy();
    if (policy.enabled !== true || policy.engineConfig === null) return { disabled: true };
    const windows = currentWindows();
    const key = JSON.stringify([policy.engineConfig, Object.entries(windows).sort()]);
    const cached = engineCache.get(key);
    if (cached !== undefined) return cached;
    const promise = (async () => {
      const resolved = await manualEngineClass();
      if (resolved.error !== undefined) return { error: resolved.error };
      if (childCtx === null) {
        return { error: "no child context (ctx.inject unavailable); the rescue engine cannot be hosted" };
      }
      try {
        const llm = makeWindowedLlm(Reflect.get(detachedEngineCtx(childCtx), "llm"), windows);
        const host = new Proxy(detachedEngineCtx(childCtx), {
        get(target, prop) {
          if (prop === "llm") return llm;
          return Reflect.get(target, prop);
        }
      });
        const engine = new resolved.Engine(host, policy.engineConfig);
        info(`automatic overflow rescue armed (thresholdRatio ${policy.engineConfig.thresholdRatio}, maxOverflowRetries ${policy.engineConfig.maxOverflowRetries})`);
        return { engine };
      } catch (error) {
        return { error: `rescue engine construction failed (${error?.message ?? error})` };
      }
    })();
    engineCache.set(key, promise);
    promise.then(
      (result) => {
        if (result.error !== undefined) noteEngineError(result.error);
      },
      () => { /* the cache entry settles on rejection as a plain rejection; engineFor rethrows via the handler's catch */ }
    );
    return promise;
  }

  /** TTL-cached preset inventory probe (see indexCompositionInventory). */
  let inventoryCache = null;
  let inventoryAt = 0;
  async function inventory() {
    if (inventoryCache !== null && Date.now() - inventoryAt < INVENTORY_TTL_MS) return inventoryCache;
    let result;
    try {
      const presets = ctx.get("agentPresets");
      if (presets && typeof presets.compositionInventory === "function") {
        result = indexCompositionInventory(await presets.compositionInventory());
      } else {
        result = { byId: new Map(), defaultId: null, error: false };
      }
    } catch {
      result = { byId: new Map(), defaultId: null, error: true };
    }
    inventoryCache = result;
    inventoryAt = Date.now();
    return result;
  }

  /** Which preset realm this agent runs (its `agentPreset` projection). */
  function presetIdOf(agent) {
    try {
      const projections = ctx.get("sessionProjections");
      if (projections && typeof projections.stateOf === "function" && agent?.session) {
        const id = projections.stateOf(agent.session, "agentPreset");
        if (typeof id === "string" && id.length > 0) return id;
      }
    } catch { /* projection service absent: fall back to the default preset */ }
    return null;
  }

  async function builtInVerdict(agent) {
    let appCompaction;
    try {
      appCompaction = ctx.get("compaction");
    } catch {
      appCompaction = undefined;
    }
    return decideBuiltInCompaction(appCompaction, presetIdOf(agent), await inventory());
  }

  // Pressure pre-compaction (agent/pre-step): when the session's routed model
  // approaches its context budget and no built-in engine will act, compact
  // BEFORE the next request overflows. All failures are non-fatal: the step
  // proceeds either way.
  ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
    try {
      const policy = enginePolicy();
      if (policy.enabled === true && signal?.aborted !== true && agent !== undefined) {
        if ((await builtInVerdict(agent)) === "absent") {
          const ready = await engineFor();
          if (ready.engine !== undefined) {
            try {
              const result = await ready.engine.compactIfNeeded(agent, "pressure", signal);
              if (result !== null) {
                info(`pressure compaction (rescue): shadowed ${result.shadowedSeqs.length} nodes (~${result.shadowedTokenCount} tokens)`);
              }
            } catch (error) {
              if (error?.name === "TargetPressureConfigError") {
                const key = `pressure:${error.targetKey ?? "unknown"}`;
                if (!warned.has(key)) {
                  warned.add(key);
                  warn(`${error.message ?? "target pressure config error"} — pressure pre-compaction is off for this model until a contextWindow is known for it (declare it in settings.yaml or in this plugin's contextWindows)`);
                }
              } else {
                warn(`pressure compaction failed: ${error?.message ?? error}; continuing the turn`);
              }
            }
          }
        }
      }
    } catch {
      /* the rescue must never break a step */
    }
    return next();
  });

  // Canonical context-overflow recovery (agent/request-error): when the
  // provider rejects the request because it exceeds the context window and
  // no built-in engine will recover it, compact the surface once and let the
  // agent loop re-issue the request.
  ctx.on("agent/request-error", async ({ agent, failure, signal }, next) => {
    const policy = enginePolicy();
    if (policy.enabled !== true) return next();
    if (failure?.code !== (await overflowCode())) return next();
    if (signal?.aborted === true || agent === undefined) return next();
    if ((await builtInVerdict(agent)) !== "absent") return next();
    const session = agent.session;
    if (session === undefined) return next();
    if (routedTargetOf(session) === undefined) return next();
    const maxRetries = policy.engineConfig?.maxOverflowRetries ?? 1;
    const retries = overflowRetries.get(agent) ?? 0;
    if (retries >= maxRetries) return next();
    overflowAgents.set(session, agent);
    const ready = await engineFor();
    if (ready.error !== undefined || ready.engine === undefined) {
      if (ready.error !== undefined) noteEngineError(ready.error);
      return next();
    }
    const generation = session.surface?.replaceGeneration;
    let result;
    try {
      result = await ready.engine.compactIfNeeded(agent, "context-overflow", signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A model-free prune can land before the summary fails (official
      // semantics): that durable progress is enough to retry.
      if (signal.aborted !== true
        && typeof generation === "number"
        && typeof session.surface?.replaceGeneration === "number"
        && session.surface.replaceGeneration > generation) {
        overflowRetries.set(agent, retries + 1);
        return { kind: "retry" };
      }
      warn(`overflow recovery compaction failed: ${message}; ${signal.aborted ? "cancellation prevents the retry" : "preserving the original request error"}`);
      return next();
    }
    if (signal.aborted === true) return next();
    if (typeof generation !== "number" || session.surface?.replaceGeneration <= generation) return next();
    if (result !== null) {
      info(`overflow recovery (rescue): shadowed ${result.shadowedSeqs.length} nodes (~${result.shadowedTokenCount} tokens); retrying the request`);
    }
    overflowRetries.set(agent, retries + 1);
    return { kind: "retry" };
  });

  // Budget resets: an idle agent starts the next episode fresh, and a
  // completed assistant message starts a fresh overflow-recovery sequence
  // even when tool calls continue the same turn (official semantics).
  ctx.on("agent/status", ({ agent, status }) => {
    if (status === "idle" && agent !== undefined) overflowRetries.delete(agent);
  });
  ctx.on("session/event", (session, event) => {
    if (event?.type !== "assistant/message" || session === undefined) return;
    const agent = overflowAgents.get(session);
    if (agent !== undefined) overflowRetries.delete(agent);
  });

  info("automatic overflow rescue: listeners registered");
}

/**
 * Install the compaction policy on the `llm/stream` waterfall.
 * @param ctx - plugin context owning the listener and the settings wiring.
 * @param config - composition entry config (base layer under settings.yaml).
 */
function apply(ctx, config = {}) {
  // Resolve the entry config through the schema so a PARTIAL config (e.g. a
  // cordis.patch.yml row that sets only `models`) still gets every default.
  // When the settings service is mounted it replaces this source with its own
  // resolved scope (settings.yaml live overrides); when it is not, this is the
  // complete policy.
  let resolved = config;
  try {
    const r = Config["~standard"].validate(config);
    if (r !== null && typeof r === "object" && "value" in r) resolved = r.value;
  } catch {
    /* malformed entry: keep the raw config; policyOf stays defensive */
  }
  let current = () => resolved;
  const hooks = {
    setSource: (source) => {
      current = source;
    },
    onChange: () => {}
  };
  // New API (dsh-settings >= 0.1.3, e.g. source builds): the settings service
  // owns section installation; `ctx.inject` is optional — when no settings
  // service is mounted the callback never runs and the entry stays the source.
  let installed = false;
  if (typeof ctx?.inject === "function") {
    try {
      ctx.inject(["settings"], (sctx) => {
        if (typeof sctx?.settings?.installSection === "function") {
          sctx.settings.installSection(ctx, COMPACT_EFFORT_SETTINGS_NAMESPACE, Config, resolved, hooks);
          installed = true;
        }
      });
    } catch {
      /* fall through to the legacy surface */
    }
  }
  // Legacy API (dsh-settings 0.1.1-rc.x): package-level free function.
  if (!installed && typeof settingsApi?.installSettingsSection === "function") {
    try {
      const ns = typeof settingsApi.settingsNamespace === "function" ? settingsApi.settingsNamespace(COMPACT_EFFORT_SETTINGS_NAMESPACE) : COMPACT_EFFORT_SETTINGS_NAMESPACE;
      settingsApi.installSettingsSection(ctx, ns, Config, config, hooks);
    } catch {
      /* entry-only fallback */
    }
  }
  const readPolicy = () => policyOf(current());
  installSamplingFetch(ctx, readPolicy);
  const warned = new Set();
  ctx.on("llm/stream", (options, next) => {
    const cfg = current();
    const configured = typeof cfg.effort === "string" ? cfg.effort : DEFAULT_EFFORT;
    if (configured.length === 0) return next();
    if (options === null || typeof options !== "object" || typeof options.purpose !== "string") return next();
    const purposes = Array.isArray(cfg.purposes) && cfg.purposes.length > 0 ? cfg.purposes : DEFAULT_PURPOSES;
    if (!purposes.includes(options.purpose)) return next();
    // Model gate: only stamp calls targeting an allowed model.
    const models = Array.isArray(cfg.models) ? cfg.models : DEFAULT_MODELS;
    if (!models.includes(options.model)) return next();
    // An explicit per-call effort always wins over the plugin default.
    if (options.reasoningEffort !== undefined) return next();
    // A lazy async generator (not a promise): every llm/stream stage and
    // consumer deals in iterables, and the capability lookup + stamp happen
    // when the stream is first pumped — before the adapter dispatch starts.
    return (async function* () {
      let info;
      try {
        info = await ctx.llm.resolveModelInfo(options.provider, options.model, options.signal);
      } catch {
        // Capability lookup failed: leave the call untouched; its own
        // dispatch reports the real error.
        yield* next();
        return;
      }
      const offered = ((info ?? {}).reasoning?.efforts ?? []).map((effort) => effort.id);
      const chosen = chooseEffort(configured, offered);
      if (chosen !== undefined) {
        // The compaction engine builds a plain (unfrozen) options object and
        // the llm/stream default dispatch closes over this exact object, so
        // the in-place stamp reaches the adapter's wire mapping.
        try {
          options.reasoningEffort = chosen;
        } catch {
          /* frozen options: leave the model default in place */
        }
      } else if (!thinkingOffActive(readPolicy())) {
        // Only warn when NO layer can turn thinking off for this model: when
        // the wire-level gates are active, the HTTP layers handle it and the
        // missing declaration is expected (llama.cpp models rarely declare
        // reasoning efforts in settings.yaml).
        const key = `${options.provider}/${options.model}`;
        if (!warned.has(key)) {
          warned.add(key);
          ctx.logger.warn(
            `qwen38-gateway-compaction: model "${key}" offers no expressible reasoning effort (configured "${configured}") and the wire thinking-off gates are disabled; compaction keeps the model default`
          );
        }
      }
      yield* next();
    })();
  });
  // Features 3/4: the manual commands. Gated by config (live-reloaded: a
  // settings.yaml edit re-runs apply; duplicate registration is a no-op).
  const commandConfig = resolved.command === null || typeof resolved.command !== "object"
    ? {}
    : resolved.command;
  const compactEnabled = commandConfig.enabled !== false;
  const newContextEnabled = !(commandConfig.newContext && commandConfig.newContext.enabled === false);
  if (compactEnabled || newContextEnabled) {
    registerManualCommands(ctx, { compactEnabled, newContextEnabled });
  }
  // Feature 5: automatic overflow/pressure rescue for presets without a
  // built-in compaction engine. Listeners are fail-open (every guard passes
  // the event through unchanged) and re-apply is idempotent per context.
  registerAutoRescue(ctx, readPolicy);
}

export {
  name, inject, Config, COMPACT_EFFORT_SETTINGS_NAMESPACE, apply,
  MANUAL_COMPACT_COMMAND, MANUAL_NEW_CONTEXT_COMMAND, makeHardResetEngine
};
