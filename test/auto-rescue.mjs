/**
 * Feature 5 (automatic overflow/pressure rescue) — pure-function tests:
 *   - decideBuiltInCompaction: which side owns overflow recovery (app-level
 *     engine, preset composition, or this plugin's rescue engine);
 *   - patchModelInfoWindows: refining discovery context windows with the
 *     operator's declared windows without mutating the discovery object;
 *   - autoCompactionEngineConfig: mapping the settings section onto the
 *     engine constructor args (fallbacks, retainTokens/retainRatio rules).
 *
 * Run: node test/auto-rescue.mjs
 */
import assert from "node:assert/strict"

const { autoCompactionEngineConfig, decideBuiltInCompaction, patchModelInfoWindows } = await import("../index.js")

let passed = 0
let failed = 0
function check(label, cond, detail = "") {
  if (cond) { passed += 1; console.log(`  ok    ${label}`) }
  else { failed += 1; console.log(`  FAIL  ${label} ${detail}`) }
}

// ---------------------------------------------------------------------------
// decideBuiltInCompaction
// ---------------------------------------------------------------------------
console.log("decideBuiltInCompaction:")

// App-level service present with auto enabled (default) → active, no matter
// what the preset says (the realm-isolated preset engine is invisible, but the
// app engine already owns recovery for its agents).
check("app-level engine (auto default) wins → active",
  decideBuiltInCompaction({ config: {} }, "minimal", { byId: new Map(), defaultId: null, error: false }) === "active")
check("app-level engine without config → active",
  decideBuiltInCompaction({}, "minimal", null) === "active")
check("app-level engine with explicit auto:true → active",
  decideBuiltInCompaction({ config: { auto: true } }, null, null) === "active")

// App-level engine disabled → fall through to the preset composition.
const inventoryWith = (map, defaultId = null) => ({ byId: new Map(map), defaultId, error: false })
check("app disabled, preset mounts compaction-basic → active",
  decideBuiltInCompaction({ config: { auto: false } }, "standard",
    inventoryWith([["standard", true]], "standard")) === "active")
check("app disabled, preset without compaction → absent",
  decideBuiltInCompaction({ config: { auto: false } }, "minimal",
    inventoryWith([["minimal", false]], "minimal")) === "absent")

// No preset identity resolvable → unknown (treated like active).
check("app disabled, inventory error → unknown",
  decideBuiltInCompaction({ config: { auto: false } }, "minimal", { byId: new Map(), defaultId: null, error: true }) === "unknown")
check("app disabled, preset id missing from inventory → unknown",
  decideBuiltInCompaction({ config: { auto: false } }, "ghost-preset",
    inventoryWith([["standard", true]], "standard")) === "unknown")
check("app disabled, empty preset id and no default → unknown",
  decideBuiltInCompaction({ config: { auto: false } }, "",
    inventoryWith([["standard", true]], null)) === "unknown")

// Empty preset id → the profile's default preset decides.
check("empty preset id falls back to default (has engine) → active",
  decideBuiltInCompaction({ config: { auto: false } }, "",
    inventoryWith([["standard", true]], "standard")) === "active")
check("empty preset id falls back to default (no engine) → absent",
  decideBuiltInCompaction({ config: { auto: false } }, "",
    inventoryWith([["minimal", false]], "minimal")) === "absent")

// No profile-level preset service at all → no built-in anywhere.
check("no app engine, no preset service → absent",
  decideBuiltInCompaction(undefined, "minimal", null) === "absent")
check("no app engine, preset service null → absent",
  decideBuiltInCompaction(null, undefined, undefined) === "absent")

// ---------------------------------------------------------------------------
// patchModelInfoWindows
// ---------------------------------------------------------------------------
console.log("patchModelInfoWindows:")

const discovery = { provider: "llama", id: "qwen3.8", context: { contextWindow: 378144, maxOutput: 32768 } }
const WINDOWS = { "qwen3.8": 167236 }

// Declared window is already below the operator value: keep discovery as-is
// (the same object reference — the discovery cache must stay untouched).
const kept = patchModelInfoWindows("qwen3.8", discovery, { "qwen3.8": 378144 })
check("declared == configured → same reference, unchanged", kept === discovery)
check("declared < configured → same reference, unchanged",
  patchModelInfoWindows("qwen3.8", { context: { contextWindow: 100000 } }, { "qwen3.8": 378144 })
    .context.contextWindow === 100000)

// Declared window exceeds the operator value: the operator value wins, and
// the result is a copy (other fields and sibling context keys preserved).
const patched = patchModelInfoWindows("qwen3.8", discovery, WINDOWS)
check("declared > configured → operator value written", patched.context.contextWindow === 167236)
check("result is a new object (discovery untouched)", patched !== discovery && discovery.context.contextWindow === 378144)
check("sibling context keys survive the patch", patched.context.maxOutput === 32768)
check("sibling info fields survive the patch", patched.provider === "llama" && patched.id === "qwen3.8")

// No declared window at all → the operator value fills the gap.
check("missing declared window → configured value written",
  patchModelInfoWindows("qwen3.8", { context: {} }, WINDOWS).context.contextWindow === 167236)
check("no context slot at all → created with the configured value",
  patchModelInfoWindows("qwen3.8", { provider: "llama" }, WINDOWS).context.contextWindow === 167236)

// Non-matching model / empty map / invalid configured value → untouched.
check("model not in the map → same reference", patchModelInfoWindows("other", discovery, WINDOWS) === discovery)
check("empty window map → same reference", patchModelInfoWindows("qwen3.8", discovery, {}) === discovery)
check("zero configured value → same reference", patchModelInfoWindows("qwen3.8", discovery, { "qwen3.8": 0 }) === discovery)
check("negative configured value → same reference", patchModelInfoWindows("qwen3.8", discovery, { "qwen3.8": -5 }) === discovery)
check("null discovery info passes through", patchModelInfoWindows("qwen3.8", null, WINDOWS) === null)
check("non-object discovery info passes through", patchModelInfoWindows("x", undefined, WINDOWS) === undefined)

// ---------------------------------------------------------------------------
// autoCompactionEngineConfig
// ---------------------------------------------------------------------------
console.log("autoCompactionEngineConfig:")

check("enabled:false short-circuits everything",
  JSON.stringify(autoCompactionEngineConfig({ enabled: false, thresholdRatio: -1 })) === JSON.stringify({ enabled: false }))
check("empty section → defaults (auto:false, 0.8, no retain keys)", (() => {
  const got = autoCompactionEngineConfig({})
  return got.enabled === true && got.engineConfig.auto === false
    && got.engineConfig.thresholdRatio === 0.8
    && got.engineConfig.maxTokens === 8192
    && got.engineConfig.compactionRetries === 1
    && got.engineConfig.maxOverflowRetries === 1
    && !("retainRatio" in got.engineConfig)
    && !("retainTokens" in got.engineConfig)
})())

const full = autoCompactionEngineConfig({
  enabled: true, thresholdRatio: 0.75, summarizationProvider: "openai",
  summarizationModel: "sum", maxTokens: 4096, retainTokens: 2048,
  retainRatio: 0.1, compactionRetries: 2, maxOverflowRetries: 3
})
check("explicit values pass through", full.engineConfig.thresholdRatio === 0.75
  && full.engineConfig.summarizationProvider === "openai"
  && full.engineConfig.summarizationModel === "sum"
  && full.engineConfig.maxTokens === 4096
  && full.engineConfig.compactionRetries === 2
  && full.engineConfig.maxOverflowRetries === 3)
check("retainTokens outranks retainRatio (engine rejects both)",
  full.engineConfig.retainTokens === 2048 && !("retainRatio" in full.engineConfig))
check("retainRatio alone is honored",
  autoCompactionEngineConfig({ retainRatio: 0.16 }).engineConfig.retainRatio === 0.16)
check("invalid retainTokens falls back to retainRatio",
  autoCompactionEngineConfig({ retainTokens: -5, retainRatio: 0.2 }).engineConfig.retainRatio === 0.2)
check("both retain values invalid → engine defaults apply (no retain key)",
  !("retainTokens" in autoCompactionEngineConfig({ retainTokens: "x", retainRatio: 0 }).engineConfig)
  && !("retainRatio" in autoCompactionEngineConfig({ retainTokens: "x", retainRatio: 0 }).engineConfig))
check("invalid thresholdRatio falls back to 0.8",
  autoCompactionEngineConfig({ thresholdRatio: -1 }).engineConfig.thresholdRatio === 0.8)
check("invalid scalars fall back to engine defaults", (() => {
  const got = autoCompactionEngineConfig({ maxTokens: -1, compactionRetries: -3, maxOverflowRetries: 1.5 })
  return got.engineConfig.maxTokens === 8192 && got.engineConfig.compactionRetries === 1 && got.engineConfig.maxOverflowRetries === 1
})())
check("non-object raw is treated as the default section",
  autoCompactionEngineConfig(null).enabled === true)

console.log(`\nauto-rescue: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)