# Local Gateway Compaction & Context Management (dsh-gateway-compaction)

`dsh-gateway-compaction` is a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin for local model gateways (**llama.cpp / Unsloth Studio** and **NInfer**), targeting **Qwen3.8-27B GGUF** gateways by default.

GitHub renders the Chinese [`README.md`](./README.md) by default. This English file is `README.en.md`.

## Applicable models

This plugin targets **local Qwen3.8 gateways** (served by llama.cpp / Unsloth Studio or an NInfer gateway) by default:

| Item | Notes |
|---|---|
| Default scope | `Qwen3.8-27B-GGUF` (llama.cpp / Unsloth model id) and `qwen3.8-27b` (NInfer gateway id — also list it under `ninModels`) |
| Qwen3-specific parts | the thinking-off wire fields (`chat_template_kwargs.enable_thinking` / `reasoning_effort`) rely on Qwen3 chat templates; the bundled sampling values are Qwen3's recommended non-thinking settings |
| The compaction machinery itself | chunked map-reduce rescue, automatic overflow rescue, `/gateway-compact`, `/clear-context` are model-agnostic |
| Extending to other models | add the model id to `models` (and to `ninModels` when served by an NInfer gateway); the wire fields must be supported by the gateway |
| Not applicable | non-OpenAI-compatible gateways, or model families with different thinking switches (adjust the wire fields yourself) |

> Naming history: the plugin was formerly `dsh-qwen38-gateway-compaction`; it was renamed to `dsh-gateway-compaction` on 2026-09-19 (same capabilities, same applicable models). The `settings.yaml` section is now `gateway-compaction` — rename the old `qwen38-gateway-compaction:` section manually when upgrading.

## Capability matrix

| Capability | Status | Scope |
|---|---|---|
| Thinking-off for compaction calls | Implemented | Only matched models; normal conversation untouched |
| Thinking-off for session-title calls | Implemented | Prevents short title budgets being consumed by reasoning |
| llama.cpp / NInfer wire-field split | Implemented | NInfer never receives the unsupported `chat_template_kwargs` |
| Compaction sampling + `max_tokens` floor | Implemented | Prevents client-side clamp from collapsing the summary budget |
| Oversized-conversation chunked map-reduce rescue | Implemented | Handles compaction overflow after switching to a smaller-window model |
| `/gateway-compact` | Implemented | Manual model-summarized checkpoint |
| `/clear-context` | Implemented | Manual zero-LLM hard reset to a fresh context window |
| Compaction prompts visible on the settings page (read-only) | Implemented | Main instruction (dsh-compaction-basic), supplement rules, and the chunked-merge preamble are shown in the UI |
| Compaction prompt optimization (supplement rules) | Implemented | Six supplement rules appended after the main instruction (recency weighting / verbatim fidelity / in-flight work / newest-wins conflicts / conversation-language output / no invention); toggleable; merge preamble rewritten with explicit consolidation rules |
| Automatic overflow/pressure rescue (no built-in engine) | Implemented | Presets without a built-in compaction engine (e.g. `minimal`): proactive compaction at `thresholdRatio × window` (default 0.8), plus automatic compact-and-retry when the gateway answers with a context overflow (400). Presets that mount `dsh-compaction-basic` (e.g. standard) are never touched; an undetectable deployment is treated as "has engine" — no double compaction, ever |
| minimal-preset 80% warning / 98% auto-compact | Implemented (folded into the row above) | 80% warning = `thresholdRatio 0.8 × window` (133788 at the 167236 window); the 98% zone is covered by the overflow "compact-then-retry" path — see "Feature 6" |

## Server-side hard limit

The plugin's context budget must agree with the NInfer server's hard limit. The target server is configured as:

```text
contextWindow:      378144 tokens
defaultMaxOutput:   192000 tokens
safety margin:      ceil(378144 × 5%) = 18908 tokens
max input:          378144 - 192000 - 18908 = 167236 tokens
```

Requests whose input exceeds `167236` tokens are rejected by NInfer immediately:

```text
context_length_exceeded
```

The request never enters GPU prefill and never reaches generation. The client therefore cannot wait for a server error; it must compute context pressure against the same budget before sending a request.

## minimal-preset context policy

The `minimal` preset does not assemble DSH's official `compaction-basic` auto-compaction engine. The plugin adds a fallback without modifying DSH source — since 2026-09-19 this has shipped as the general "automatic compaction rescue" (Feature 6 below): it applies to **any** preset without a built-in compaction engine, not just `minimal`. The original budget design is kept below for reference:

```text
usableInputBudget = contextWindow
                   - maxOutputTokens
                   - ceil(contextWindow × safetyMarginRatio)

warningTokens      = floor(usableInputBudget × warningRatio)
autoCompactTokens  = ceil(usableInputBudget × autoCompactRatio)
```

Defaults:

```text
contextWindow      = 378144
maxOutputTokens    = 192000
safetyMarginRatio  = 0.05
usableInputBudget  = 167236
warningRatio       = 0.80
autoCompactRatio   = 0.98
```

Result:

```text
80% warning     = floor(167236 × 0.80) = 133788 tokens
98% auto-compact = ceil(167236 × 0.98)  = 163892 tokens
```

These ratios apply to the **usable input budget**, not to the full 378144-token window.

### Automatic vs. manual operations

| Operation | Trigger | Scope | Uses LLM | Effect | Prerequisite |
|---|---|---:|---|---|---|
| 80% warning | Auto check before each `minimal` step | minimal only | No | Logs current input tokens, budget, and remaining headroom; no session change | Trusted token meter and model window |
| 98% auto summary compaction | Auto check before each `minimal` step | minimal only | Yes | Summarizes old history into a checkpoint, retains recent context; chunked for oversized input | Compaction engine loadable; agent maintainable |
| `/gateway-compact` | User types the command | All presets incl. minimal | Yes | Lossy but information-preserving summary compaction | Command enabled; agent idle; `dsh-compaction-basic` resolvable |
| `/clear-context` | User types the command | All presets incl. minimal | No | Instant fresh model-visible window; old visible history dropped, raw event log kept | Agent idle; resetable history exists |

The automatic policy never performs a hard reset by itself. Hard reset drops model-visible history and is reserved for explicit manual confirmation.

> Note: since 2026-09-19 the "80% warning" and "98% auto-compact" rows above have been implemented by "Feature 6: automatic compaction rescue" — the 80% line is `thresholdRatio (0.8) × window`, and the 98% zone is covered by the overflow "compact → retry" path. The scope extends from `minimal` to any preset without a built-in compaction engine.

### Budget source priority

1. Plugin setting override matching the server's actual limit;
2. DSH `resolveModelInfo()` → `context.contextWindow` and `defaultMaxTokens`;
3. Model-level manual configuration;
4. If no trusted window/output limit can be obtained, auto-compaction is skipped with a logged reason.

For the current NInfer model, configure `378144` and `192000` explicitly; do not keep the old `369144` window value.

## Implemented features

### 1. Compaction request fixing

For allow-listed models, the plugin can, on compaction and title auxiliary requests:

- disable thinking;
- write `reasoning_effort`;
- write non-thinking sampling parameters;
- raise the compaction request's output cap to the configured floor;
- leave out-of-allow-list requests byte-identical.

Gateway differences:

| Gateway | Thinking-off mechanism |
|---|---|
| llama.cpp / Unsloth Studio | `chat_template_kwargs.enable_thinking: false` + `reasoning_effort` |
| NInfer | `reasoning_effort` only; `chat_template_kwargs` never sent |

### 2. Oversized-conversation chunked rescue

When a conversation grew under a large-window model and the route switched to a smaller-window model, a single summarization request may not fit the history. The plugin, when safe conditions hold:

1. splits history into consecutive slices;
2. summarizes each slice;
3. merges the partial checkpoints;
4. returns the merged result to DSH as the summary checkpoint.

If the body cannot be parsed safely, the model window is unknown, the slice count exceeds the cap, or a mid-flight failure occurs, the plugin fails open — it never fabricates a success.

### 3. `/gateway-compact`

Model summarization compaction. It replaces the compactable history with a summary checkpoint, preserving as much task information as possible, but summaries remain lossy and local 27B runs can be slow.

### 4. `/clear-context`

A local manual counterpart of the Codex hard-rollover direction: no LLM call, a fixed short marker replaces the current model-visible surface. The raw session event log stays on disk; files, git, running services, and external state are untouched.

Use it when task state already lives in code, files, git, or databases. Do not use it for Q&A that depends on the full conversation.

### 5. Compaction prompts on the settings page (read-only)

Summary quality is determined by the prompt text sent to the model. Until now that text lived only in the harness source and in this plugin's code. The settings page (both the settings plugin card and the 0.1.6+ sidebar plugins page) now has a read-only "Compaction prompts" disclosure with three blocks:

- **Main compaction instruction** — from the official `dsh-compaction-basic` engine (harness source); the page shows a reference copy (source and harness version labeled). The plugin re-verifies its first line on every compaction and warns if the running harness no longer matches.
- **Supplement rules** — six plugin-provided rules appended after the main instruction (on by default, toggleable). They target measured weaknesses of the stock instruction on long sessions: (1) recency weighting, (2) verbatim fidelity for paths/commands/ports/values, (3) in-flight task state (done / remaining / next action), (4) newest statement wins on conflicts, (5) output in the conversation's dominant language (overrides the stock "English prose" rule; code/paths/identifiers stay verbatim), (6) never invent content. They are sent on the single-shot call, every chunked slice, and the final merge. Design informed by agentscope-style compaction/consolidation prompts.
- **Chunked-merge preamble** — the fixed preamble this plugin adds when chunked rescue fires, now with explicit consolidation rules (later slices win on conflict, dedupe, union of facts, Current Work/Next Step from the last slice, never drop a section), shown verbatim.

The display is read-only: editing prompt text requires a harness / plugin code change. The plugin-side texts are guarded by `test/prompt-sync.mjs`, which asserts they stay byte-identical to what the host actually sends.

### 6. Automatic compaction rescue (no built-in engine)

Some presets (e.g. `minimal`) do not mount DSH's official `dsh-compaction-basic` engine: nobody then watches the context pressure, and once the gateway answers `context_length_exceeded` (400), the whole turn fails. This feature gives those presets a recovery path, while **never interfering with presets that have a built-in engine** (presets such as `standard` that mount `dsh-compaction-basic` behave exactly as before — that is the acceptance criterion):

- **Pressure warning** — before each step, the plugin drives its own `auto: false` engine instance (driven imperatively, never self-registered) and compacts proactively when context reaches `thresholdRatio × window` (default 0.8; the window comes from your "context window" settings, or is resolved automatically), defusing pressure before the gateway can complain.
- **Overflow recovery** — when the gateway reports a context-window overflow (400), the session is compacted and the request retried; per-session retries are capped by `maxOverflowRetries` (default 1) so a 400 cannot loop.
- **Ownership detection (never double-compact)** — rescue only fires when the preset demonstrably lacks a built-in engine: the app-level `compaction` service is checked first, then the preset's composition inventory is scanned for a `@deepseek-ai/dsh-compaction-basic` row. Any undecidable case is treated as "has engine" — a missed rescue leaves the original 400 on the surface, a false one would burn GPU on double compaction.
- **Fail-open everywhere** — every guard passes the event through unchanged on error; rescue summaries go through this plugin's wire layers (thinking-off + sampling apply), and a rescue call that still overflows falls back to chunked rescue.

Configuration (all optional; the defaults are exactly the values below, editable on the settings page under "Automatic overflow rescue" and in Advanced):

```yaml
gateway-compaction:
  autoCompaction:
    enabled: true        # default true; false disables the whole feature
    thresholdRatio: 0.8  # pressure threshold, as a fraction of the effective window
    # retainRatio: 0.16      # recent share to keep (mutually exclusive with retainTokens)
    # retainTokens: 2000     # or a fixed number of recent tokens (takes precedence)
    # summarizationProvider: ""  # empty = inherit the session's model
    # summarizationModel: ""
    # maxTokens: 8192
    # compactionRetries: 1
    # maxOverflowRetries: 1
```

## Configuration

Settings file: `$DSH_HOME/settings.yaml`; for the dev profile, usually `~/.dsh-dev/settings.yaml`.

```yaml
gateway-compaction:
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

  # Design placeholder (not implemented): the minimal-only budget policy.
  # The actual fallback is provided by autoCompaction below (Feature 6).
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

  # Automatic compaction rescue (on by default; this whole block may be
  # omitted — every value below is a default).
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

`warningRatio`, `autoCompactRatio`, `safetyMarginRatio`, and the per-model window/max-output settings should be editable in the settings page. Constraints:

```text
0 < warningRatio < autoCompactRatio <= 1
0 <= safetyMarginRatio < 1
contextWindow - maxOutputTokens - ceil(contextWindow × safetyMarginRatio) > 0
```

## Installation

```sh
dsh-dev plugin --profile web add \
  /home/wwt/Downloads/aigc/proj/deepseek/dsh-plugins/dsh-gateway-compaction
```

> Upgrading from the old name `dsh-qwen38-gateway-compaction`: remove the old plugin, `add` the new path (above), and rename the `qwen38-gateway-compaction:` section in `$DSH_HOME/settings.yaml` to `gateway-compaction:` (the section body is unchanged). Without this the new plugin runs on defaults and ignores your old settings.

Restart the dev service after install or upgrade:

```sh
systemctl --user restart dsh-dev-web
```

Remove:

```sh
dsh-dev plugin --profile web rm dsh-gateway-compaction
# still on the old name? remove it first:
dsh-dev plugin --profile web rm dsh-qwen38-gateway-compaction
```

## Codex token-budget takeaways

Codex's token-budget compaction is not a plain model API parameter; it is a client/backend coordination feature that opens a fresh context window instead of asking the model to summarize all old history.

Plugin-side (achievable here):

- budget computation;
- proactive warning;
- minimal-only automatic summary;
- manual hard reset;
- raw event log retention.

Model/server-side (still required):

- exact tokenizer counts;
- real context window and max-output limits;
- input/output/cache token usage;
- KV/prefix cache capabilities.

Therefore the robust split is: **budget and lifecycle orchestrated by the plugin; capacity and exact token data provided by the server/API.** Injecting "remaining budget" into every ordinary conversation request is not recommended for the first version.

## Tests

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

MIT, see [`LICENSE`](./LICENSE).
