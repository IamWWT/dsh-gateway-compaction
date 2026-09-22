/**
 * Code-level verification of the preset-applicability matrix documented in
 * docs/preset-applicability.md.
 *
 * Claims under test:
 *   1. The plugin is host/profile-level: it loads with NO compaction service
 *      present (the `minimal` preset shape) and registers no hook besides the
 *      `llm/stream` waterfall — it never adds an automatic compaction engine.
 *   2. The wire layer is process-global: `apply()` wraps `globalThis.fetch`,
 *      and every OpenAI-compatible request in the process resolves that
 *      wrapper (pi-ai builds a fresh client per stream; openai's
 *      `getDefaultFetch()` returns the global fetch).
 *   3. Preset-independent rewriting: an allowed-model compaction body is
 *      rewritten (engine-appropriate thinking-off + sampling + max_tokens
 *      floor) with no compaction engine composed at all; a disallowed model
 *      passes byte-identical.
 *   4. Manual commands register through host services
 *      (`commands`/`tokenMeter`/`sessions`) with no compaction engine — which
 *      is why they work in `minimal`.
 *   5. The waterfall effort stamp fires only for compaction-purpose calls on a
 *      model that declares an `off` effort, and leaves other purposes alone.
 *
 * Run: node test/preset-applicability.mjs
 */
import assert from 'node:assert/strict'
import { apply, COMPACTION_SIGNATURE } from '../index.js'

let passed = 0
const ok = (label) => { passed += 1; console.log(`  ok    ${label}`) }
const NIN = 'qwen3.8-27b'
const originalFetch = globalThis.fetch

/** A host ctx in the `minimal` shape: llm + host services, NO compaction. */
function makeHostCtx({ declareOffEffort = true } = {}) {
  const listeners = {}
  const injected = []
  const commands = []
  // The real runtime unwinds generator effects; the registration body lives
  // inside such a generator, so the test drains it to completion.
  const runEffect = (fn) => {
    if (typeof fn !== 'function') return () => {}
    const result = fn()
    if (result && typeof result.next === 'function') {
      let step = result.next()
      while (!step.done) step = result.next()
    }
    return () => {}
  }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on: (ev, fn) => { listeners[ev] = fn },
    effect: runEffect,
    llm: {
      resolveModelInfo: async () => declareOffEffort
        ? ({ reasoning: { efforts: [{ id: 'off' }, { id: 'xhigh' }] } })
        : ({})
    },
    // Host services the plugin injects for its manual commands. No
    // `compaction` service is offered anywhere — the minimal-preset shape.
    inject: (deps, cb) => {
      injected.push([...deps])
      if (deps.includes('commands')) {
        cb({
          commands: { register: (def) => { commands.push(def); return () => {} } },
          effect: runEffect,
          reflect: { provide() {} },
          logger: ctx.logger,
          tokenMeter: {},
          sessions: {}
        })
      }
      // `settings` is optional; not offered → entry-only fallback.
    }
  }
  return { ctx, listeners, injected, commands }
}

/** Install the plugin over a recording fetch and return the recorded calls. */
function applyWithRecordingFetch(hostCtx, config) {
  const calls = []
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input && input.url ? input.url : input), body: init?.body })
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  apply(hostCtx, config)
  return calls
}

const compactionBody = (model) => JSON.stringify({
  model,
  stream: true,
  max_tokens: 1,
  messages: [
    { role: 'system', content: 'You are a coding assistant.' },
    { role: 'user', content: 'do the thing' },
    { role: 'assistant', content: 'done' },
    { role: 'user', content: `${COMPACTION_SIGNATURE}\nCondense the conversation above.` }
  ]
})

const CONFIG = {
  models: ['Qwen3.8-27B-GGUF', NIN],
  ninModels: [NIN],
  maxTokensFloor: 16384,
  // The sampling set the shipped cordis.patch.yml base layer carries (the schema
  // default is `{}`, so a bare apply() carries no sampling of its own).
  sampling: {
    temperature: 0.7, top_p: 0.8, top_k: 20,
    min_p: 0.0, presence_penalty: 1.5, repetition_penalty: 1.0
  }
}

console.log('preset shape: minimal (no compaction service composed):')
const host = makeHostCtx()
const calls = applyWithRecordingFetch(host.ctx, CONFIG)

assert.deepEqual(Object.keys(host.listeners), ['llm/stream'], 'only llm/stream is registered')
ok('applies with no compaction service; registers only the llm/stream waterfall (no auto-compaction added)')

assert.ok(host.commands.some((d) => d.name === 'gateway-compact'), 'compact command registered')
assert.ok(host.commands.some((d) => d.name === 'clear-context'), 'new-context command registered')
ok('manual commands register through host services with no compaction engine (minimal works)')

assert.ok(host.injected.some((d) => d.includes('commands') && d.includes('tokenMeter') && d.includes('sessions')),
  'host service injection declares commands/tokenMeter/sessions')
ok('command registration is gated on host services, not on the preset composition')

assert.notEqual(globalThis.fetch, originalFetch, 'globalThis.fetch is wrapped by apply')
ok('globalThis.fetch is wrapped process-wide (preset-independent)')

// Allowed model → rewritten by the wire layer, with no engine present.
await globalThis.fetch('http://127.0.0.1:8881/v1/chat/completions', { method: 'POST', body: compactionBody(NIN) })
{
  const sent = JSON.parse(calls.at(-1).body)
  assert.equal(sent.reasoning_effort, 'none', 'NInfer body gets reasoning_effort none')
  assert.equal('chat_template_kwargs' in sent, false, 'NInfer body never gets chat_template_kwargs')
  assert.equal(sent.max_tokens, 16384, 'max_tokens raised to the floor')
  assert.equal(sent.temperature, 0.7, 'sampling written')
  ok('wire layer rewrites an allowed-model compaction body with no compaction engine composed')
}

// Disallowed model → byte-identical.
{
  const other = { method: 'POST', body: compactionBody('some-other-model') }
  const before = other.body
  await globalThis.fetch('http://x/v1/chat/completions', other)
  assert.equal(calls.at(-1).body, before, 'disallowed model body untouched')
  ok('disallowed model passes byte-identical')
}

// llama.cpp model → engine-appropriate fields (chat_template_kwargs + reasoning_effort).
await globalThis.fetch('http://192.168.0.127:8880/v1/chat/completions', { method: 'POST', body: compactionBody('Qwen3.8-27B-GGUF') })
{
  const sent = JSON.parse(calls.at(-1).body)
  assert.equal(sent.chat_template_kwargs?.enable_thinking, false, 'llama.cpp body gets enable_thinking=false')
  assert.equal(sent.reasoning_effort, 'none', 'llama.cpp body also gets reasoning_effort')
  ok('llama.cpp model keeps its own wire fields (engine gate, not preset gate)')
}

console.log('waterfall layer (the three presets that do have a compaction engine):')
{
  const options = { provider: 'qwen-ninfer', model: NIN, purpose: 'compaction' }
  let forwarded = 0
  const gen = host.listeners['llm/stream'](options, () => { forwarded += 1; return (async function* () { yield 'x' })() })
  for await (const _ of gen) { /* drain */ }
  assert.equal(options.reasoningEffort, 'off', 'compaction call stamped off')
  assert.equal(forwarded, 1, 'call still forwarded exactly once')
  ok('compaction-purpose call on a model declaring `off` is stamped reasoningEffort=off')

  const chat = { provider: 'qwen-ninfer', model: NIN, purpose: 'chat' }
  let chatForwarded = 0
  const gen2 = host.listeners['llm/stream'](chat, () => { chatForwarded += 1; return 'sync' })
  assert.equal(chatForwarded, 1, 'non-compaction call forwarded synchronously')
  assert.equal(chat.reasoningEffort, undefined, 'non-compaction call untouched')
  ok('non-compaction calls pass through untouched (no global thinking-off)')

  const mini = makeHostCtx({ declareOffEffort: false })
  applyWithRecordingFetch(mini.ctx, CONFIG)
  const noEffort = { provider: 'qwen-ninfer', model: NIN, purpose: 'compaction' }
  const gen3 = mini.listeners['llm/stream'](noEffort, () => (async function* () { yield 'y' })())
  for await (const _ of gen3) { /* drain */ }
  assert.equal(noEffort.reasoningEffort, undefined, 'no declared effort → left to the model default')
  ok('models without an expressible effort keep their default (wire layer still rewrites)')
}

globalThis.fetch = originalFetch
console.log(`\npreset-applicability: ${passed} assertions passed`)
