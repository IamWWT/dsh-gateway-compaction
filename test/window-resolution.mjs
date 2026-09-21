/**
 * Window auto-resolution tests (feature 2b): the rescue plans slices against
 * the gateway window of the compaction call's target model. An explicit
 * settings value always wins; otherwise the plugin probes the gateway's
 * /v1/models endpoint, then falls back to the model's declaration in the dsh
 * model config (settings.yaml, via the llm service). Nothing resolvable →
 * the rescue stays disabled and logs ONE actionable warning.
 *
 * Run: node test/window-resolution.mjs
 */
import assert from "node:assert/strict"

const { chunkedCompactionRescue, COMPACTION_SIGNATURE } = await import("../index.js")

let passed = 0
let failed = 0
function check(label, cond, detail = "") {
  if (cond) { passed += 1; console.log(`  ok    ${label}`) }
  else { failed += 1; console.log(`  FAIL  ${label} ${detail}`) }
}

const BASE = "http://127.0.0.1:18880"
const MODELS_URL = `${BASE}/v1/models`
const CHAT_URL = `${BASE}/v1/chat/completions`

/** A compaction prompt far larger than any budget used in these tests. */
function bigBody(model) {
  const messages = [{ role: "system", content: "You are a coding assistant." }]
  for (let i = 0; i < 50; i++) {
    messages.push({ role: "user", content: `u${i}: ` + "u".repeat(20000) })
    messages.push({ role: "assistant", content: `a${i}: ` + "a".repeat(20000) })
  }
  messages.push({ role: "user", content: `${COMPACTION_SIGNATURE}\nCondense the conversation above.` })
  return { model, stream: false, messages, max_tokens: 4096 }
}

function makeCtx(llm, warnings = []) {
  return {
    llm,
    logger: { info: () => {}, warn: (m) => warnings.push(m), error: () => {} },
  }
}

/** Fake llm service: providers → models → {contextWindow, maxTokens}. */
function fakeLlm(declared) {
  return {
    listProviders: () => Object.keys(declared).map((id) => ({ id })),
    async resolveModelInfo(provider, model) {
      const spec = declared[provider]?.[model]
      if (!spec) throw new Error(`model ${model} unknown to provider ${provider}`)
      const info = { provider, id: model, name: model }
      if (spec.contextWindow !== undefined) info.context = { contextWindow: spec.contextWindow }
      if (spec.maxTokens !== undefined) info.defaultMaxTokens = spec.maxTokens
      return info
    },
  }
}

function policy(windows, ratio = 0.7) {
  return {
    entries: [], floor: 0, wireReasoning: "", enableThinkingOff: false,
    models: ["M"], ninModels: new Set(),
    chunking: { contextWindows: windows, ratio, chunkMaxTokens: 512, mergeMaxTokens: 1024, maxChunks: 8 },
  }
}

/**
 * A fetch stub. `modelsPayload` is what /v1/models returns (or null = 404).
 * Every other URL gets a successful one-sentence completion. Records every
 * call in `log`.
 */
function stubFetch(models, log) {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input?.url
    log.push(url)
    if (url === MODELS_URL) {
      if (models === null) return new Response("not found", { status: 404, headers: { "content-type": "application/json" } })
      return new Response(JSON.stringify({ object: "list", data: models }), { status: 200, headers: { "content-type": "application/json" } })
    }
    return new Response(JSON.stringify({
      id: "x", object: "chat.completion", created: 1, model: "M",
      choices: [{ index: 0, message: { role: "assistant", content: "## Summary" }, finish_reason: "stop" }],
    }), { status: 200, headers: { "content-type": "application/json" } })
  }
}

const probeCount = (log) => log.filter((u) => u === MODELS_URL).length

// ---------------------------------------------------------------------------
// 1. Explicit settings value wins: the probe never runs, the rescue slices.
// ---------------------------------------------------------------------------
{
  const log = []
  const fetch = stubFetch([{ id: "M", context_length: 999999 }], log)
  const res = await chunkedCompactionRescue(makeCtx(null), fetch, CHAT_URL, { method: "POST", body: JSON.stringify(bigBody("M")), headers: {} }, policy({ M: 100000 }))
  check("explicit window: rescue slices without probing the gateway", res !== undefined && probeCount(log) === 0)
}

// ---------------------------------------------------------------------------
// 2. No explicit value: the LIVE GATEWAY PROBE supplies the window
//    (context_length 300000, no output reservation) → budget
//    0.7 × (300000 − 15000) = 199500 < ~500k prompt → chunked rescue runs.
// ---------------------------------------------------------------------------
{
  const log = []
  const fetch = stubFetch([{ id: "M", context_length: 300000 }], log)
  const res = await chunkedCompactionRescue(makeCtx(null), fetch, CHAT_URL, { method: "POST", body: JSON.stringify(bigBody("M")), headers: {} }, policy({}))
  check("live probe: /v1/models consulted for the window", probeCount(log) === 1)
  check("live probe: rescue slices with the probed window", res !== undefined)
}

// ---------------------------------------------------------------------------
// 3. Declaration 托底: the probe discloses nothing (empty listing), but the
//    dsh model config declares M (300000 window, 32000 output reservation).
//    Budget 0.7 × (300000 − 32000 − 15000) = 177100 → still slices.
// ---------------------------------------------------------------------------
{
  const log = []
  const fetch = stubFetch([], log) // gateway listing exists but has no such model
  const llm = fakeLlm({ nin: { M: { contextWindow: 300000, maxTokens: 32000 } } })
  const warnings = []
  const res = await chunkedCompactionRescue(makeCtx(llm, warnings), fetch, CHAT_URL, { method: "POST", body: JSON.stringify(bigBody("M")), headers: {} }, policy({}))
  check("settings.yaml fallback: declaration resolves the window", res !== undefined)
  check("settings.yaml fallback: no warning once a source resolved", warnings.length === 0)
}

// ---------------------------------------------------------------------------
// 4. Nothing resolvable (no probe disclosure, no declaration): the rescue
//    stays disabled (fail open) and logs ONE actionable warning naming the
//    model; later rescues do not re-warn.
// ---------------------------------------------------------------------------
{
  const log = []
  const fetch = stubFetch(null, log) // 404 from the gateway
  const llm = fakeLlm({ other: { unrelated: { contextWindow: 1000 } } })
  const warnings = []
  // Model "U" is declared nowhere and the probe 404s: genuinely unresolvable.
  // (Distinct from "M" above so earlier test resolutions cannot leak in via
  // the process-wide caches.)
  const res = await chunkedCompactionRescue(makeCtx(llm, warnings), fetch, CHAT_URL, { method: "POST", body: JSON.stringify(bigBody("U")), headers: {} }, policy({}))
  check("unresolvable: rescue disabled (forwards the original request)", res === undefined)
  check("unresolvable: warning names the model", warnings.length === 1 && warnings[0].includes('"U"'))
  const warnings2 = []
  await chunkedCompactionRescue(makeCtx(llm, warnings2), fetch, CHAT_URL, { method: "POST", body: JSON.stringify(bigBody("U")), headers: {} }, policy({}))
  check("unresolvable: warning is one-shot per process+model", warnings2.length === 0)
}

// ---------------------------------------------------------------------------
// 5. Probe cache: a second rescue within the TTL does not re-probe.
// ---------------------------------------------------------------------------
{
  const log = []
  const fetch = stubFetch([{ id: "C", context_length: 300000 }], log)
  const ctx = makeCtx(null)
  // Model "C" is fresh for this process: the first rescue must probe exactly
  // once; the second (within the TTL) must reuse the cached window.
  await chunkedCompactionRescue(ctx, fetch, CHAT_URL, { method: "POST", body: JSON.stringify(bigBody("C")), headers: {} }, policy({}))
  const afterFirst = probeCount(log)
  await chunkedCompactionRescue(ctx, fetch, CHAT_URL, { method: "POST", body: JSON.stringify(bigBody("C")), headers: {} }, policy({}))
  check("probe cache: first rescue probes once", afterFirst === 1)
  check("probe cache: second rescue reuses the cached window", probeCount(log) === afterFirst)
}

console.log(`window-resolution: ${passed} passed, ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0