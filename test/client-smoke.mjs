/**
 * Client-half smoke test: loads client.js in a VM with a stubbed browser
 * module loader, drives the Cordis plugin surface (apply → slot registration),
 * renders the card with a minimal React renderer, and exercises edit/save/
 * reset/discard against a fake settings scope.
 *
 * Run: node test/client-smoke.mjs
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'

const ROOT = new URL('..', import.meta.url).pathname

// ---------------------------------------------------------------------------
// Minimal React stand-in (createElement + one-shot function-component render).
// The card uses no real hooks — useQwen38Card is a plain selector prop.
// ---------------------------------------------------------------------------
function createElement(type, props, ...children) {
  const flat = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
  return { type, props: { ...(props ?? {}), ...(flat.length > 0 ? { children: flat.length === 1 ? flat[0] : flat } : {}) } }
}

function render(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(render).join('')
  const { type, props } = node
  if (typeof type === 'function') return render(type(props))
  const SKIP = new Set(['children', 'style', 'onChange', 'onClick', 'disabled', 'aria-invalid'])
  const attrs = Object.entries(props ?? {})
    .filter(([k]) => !SKIP.has(k) && typeof props[k] !== 'function')
    .map(([k, v]) => ` ${k}="${String(v)}"`)
    .join('')
  return `<${type}${attrs}>${render(props.children)}</${type}>`
}

const ReactStub = { createElement }

// Themed-atom stand-ins (shape-compatible with the real primitives).
const PrimitivesStub = {
  Button: ({ children, ...rest }) => createElement('button', rest, children),
  Input: (props) => createElement('input', props),
  Tag: ({ children, ...rest }) => createElement('span', rest, children),
  IconChevronDownOutline14: (props) => createElement('svg', props),
}

// dsh-client-store stand-in: the three methods the controller uses.
function createSnapshotStore(init) {
  let state = init
  const listeners = new Set()
  return {
    getSnapshot: () => state,
    set: (next) => { state = next; for (const l of [...listeners]) l() },
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
  }
}

// ---------------------------------------------------------------------------
// Fake Cordis browser context + settings scope.
// ---------------------------------------------------------------------------
const BASE_VALUE = {
  effort: 'off',
  models: ['Qwen3.8-27B-GGUF'],
  sampling: { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0.0, presence_penalty: 1.5, repetition_penalty: 1.0 },
  maxTokensFloor: 16384,
  wireReasoning: 'none',
  enableThinkingOff: true,
  chunking: { enabled: true, contextWindows: { 'Qwen3.8-27B-GGUF': 262144 }, chunkRatio: 0.7, chunkMaxTokens: 8192, mergeMaxTokens: 16384, maxChunks: 8 },
  command: { enabled: true, newContext: { enabled: true } },
}

let userValue = { maxTokensFloor: 20000 } // a pre-existing user override
const mutateCalls = []

/** Deep-merge the user layer over the base (the real scope serves merged values). */
function merged() {
  const out = JSON.parse(JSON.stringify(BASE_VALUE))
  for (const [key, val] of Object.entries(userValue)) {
    if (val !== null && typeof val === 'object' && !Array.isArray(val) && typeof out[key] === 'object' && out[key] !== null) {
      Object.assign(out[key], JSON.parse(JSON.stringify(val)))
    } else {
      out[key] = JSON.parse(JSON.stringify(val))
    }
  }
  return out
}

const fakeScope = {
  getSnapshot: () => ({ status: 'ready', value: merged(), base: BASE_VALUE, user: userValue, revision: 3, writable: true, mode: 'host' }),
  subscribe: () => () => {},
  async mutate(ops, expectedRevision) {
    mutateCalls.push({ ops, expectedRevision })
    // Apply the ops to the user layer so a re-render reflects them.
    for (const op of ops) {
      const target = op.op === 'set' ? op.value : undefined
      let cur = userValue
      for (let i = 0; i < op.path.length - 1; i += 1) {
        if (typeof cur[op.path[i]] !== 'object' || cur[op.path[i]] === null) cur[op.path[i]] = {}
        cur = cur[op.path[i]]
      }
      const last = op.path[op.path.length - 1]
      if (op.op === 'set') cur[last] = target
      else delete cur[last]
    }
  },
}

const localeRegisters = []
const slotEntries = []
let effects = 0
const fakeCtx = {
  effect: (fn, _label) => { effects += 1; fn() },
  locale: {
    register: (ns, dict) => { localeRegisters.push({ ns, dict }) },
    bind: () => (key) => key,
  },
  settingsScope: {
    bind: (spec) => {
      assert.equal(spec.namespace, 'gateway-compaction')
      return fakeScope
    },
  },
  slots: {
    inject: (_slot, cb) => cb(),
    register: (options, component) => { slotEntries.push({ options, component }) },
  },
}

// ---------------------------------------------------------------------------
// Load client.js through the stubbed module loader.
// ---------------------------------------------------------------------------
const loaded = []
const sandbox = {
  window: { __ModuleLoader__: { load: (spec) => loaded.push(spec) } },
  console,
}
vm.createContext(sandbox)
vm.runInContext(readFileSync(`${ROOT}client.js`, 'utf8'), sandbox, { filename: 'client.js' })

assert.equal(loaded.length, 1, 'exactly one module registered')
assert.equal(loaded[0].id, 'dsh-gateway-compaction')

const plugin = loaded[0].factory((specifier) => {
  if (specifier === 'react') return ReactStub
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return PrimitivesStub
  if (specifier === '@deepseek-ai/dsh-client-store') return { createSnapshotStore }
  throw new Error(`unexpected require: ${specifier}`)
})

assert.equal(plugin.name, 'gateway-compaction')
assert.deepEqual([...plugin.inject].sort(), ['locale', 'settingsScope', 'slots'])

// ---------------------------------------------------------------------------
// apply(): locale + slot registration.
// ---------------------------------------------------------------------------
plugin.apply(fakeCtx)
assert.equal(effects, 1)
assert.equal(localeRegisters.length, 1)
assert.equal(localeRegisters[0].ns, 'gateway-compaction')
for (const lang of ['zh', 'en']) {
  const dict = localeRegisters[0].dict[lang]
  assert.ok(dict && typeof dict.title === 'string' && dict.title.length > 0, `locale ${lang} has title`)
  for (const key of ['scopeNote', 'commandHint', 'modelsLabel', 'windowsTitle', 'windowsHint', 'basicTitle', 'enableThinkingOffLabel', 'wireReasoningLabel', 'maxTokensFloorLabel', 'rescueLabel', 'advancedTitle', 'promptTitle', 'promptNote', 'mainPromptTitle', 'mainPromptNote', 'mergePromptTitle', 'mergePromptNote', 'on', 'off', 'collapse', 'expand', 'unsaved', 'save', 'discard', 'overridden', 'reset', 'invalidNumber', 'saveFailed']) {
    assert.ok(typeof dict[key] === 'string' && dict[key].length > 0, `locale ${lang} has ${key}`)
  }
}

// Two intentional surfaces: the legacy settings-page card AND the dsh ≥ 0.1.6
// plugin-manager bundle card. Both edit the same settings namespace through
// one shared controller. A third registration (e.g. a duplicate left-nav
// entry) is a bug.
assert.equal(slotEntries.length, 2, 'exactly two surfaces registered: settings-tab card + plugin-manager bundle card')
const entry = slotEntries.find((e) => e.options.name === 'settings.plugin.item')
assert.ok(entry, 'settings-tab card entry present')
assert.equal(entry.options.key, 'gateway-compaction')
assert.equal(entry.options.locale, 'gateway-compaction')
assert.equal(typeof entry.component, 'function')
const face = entry.options.inject()
assert.ok(face.hooks.gatewayCard, 'face exposes the card store hook')
for (const fn of ['edit', 'resetField', 'save', 'discard', 'toggleOpen']) assert.equal(typeof face[fn], 'function')

const bundleEntry = slotEntries.find((e) => e.options.name === 'plugins.bundle.config')
assert.ok(bundleEntry, 'plugin-manager bundle card entry present')
assert.equal(bundleEntry.options.key, 'dsh-gateway-compaction')
assert.equal(typeof bundleEntry.component, 'function')
const bundleFace = bundleEntry.options.inject()
assert.ok(bundleFace.hooks.gatewayCard, 'bundle face exposes the card store hook')
assert.equal(bundleFace.hooks.gatewayCard, face.hooks.gatewayCard, 'both surfaces share one controller')

// ---------------------------------------------------------------------------
// Render pass 1: base value + one user override.
// ---------------------------------------------------------------------------
const t = (key) => localeRegisters[0].dict.zh[key]
let props = { t, useQwen38Card: (sel) => sel(face.hooks.gatewayCard.getSnapshot()) }

// Collapsible card, same reading gesture as the built-in plugin cards: closed
// by default, the header is the disclosure button, and a settled save closes it
// again. Controls render only while open.
const closedHtml = render(entry.component(props))
assert.match(closedHtml, /aria-expanded="false"/, 'card starts collapsed')
assert.ok(!/maxTokensFloor/.test(closedHtml), 'collapsed card hides its controls')
assert.match(closedHtml, /本地网关压缩与上下文管理/, 'collapsed card still names the plugin')
face.toggleOpen()
assert.equal(face.hooks.gatewayCard.getSnapshot().open, true, 'toggleOpen opens the card')
const renderCard = () => {
  if (!face.hooks.gatewayCard.getSnapshot().open) face.toggleOpen()
  return render(entry.component(props))
}

let html = renderCard()
assert.match(html, /本地网关压缩与上下文管理/, 'card title renders')
assert.match(html, /Qwen3\.8-27B-GGUF/, 'model id renders')
assert.match(html, /262144/, 'context window renders')
assert.match(html, /20000/, 'user-overridden maxTokensFloor renders (not the base 16384)')
assert.match(html, /已覆盖默认值/, 'override badge on the overridden field')
assert.ok(!/maxTokensFloor" value="16384"/.test(html), 'base value hidden where user override exists')
assert.match(html, /作用域/, 'card carries the scope banner')

// The manual-command hint moved into the card body (the dedicated left-nav
// section is gone), so the plugins tab remains the single, complete home.
assert.match(html, /\/gateway-compact/, 'card body shows the manual command hint')

// The dsh ≥ 0.1.6 plugin page renders the identical fields without the card
// chrome (the page draws the title/frame itself); outside that surface the
// entry renders nothing.
const bundleHtml = render(bundleEntry.component({ ...props, view: 'page' }))
assert.match(bundleHtml, /\/clear-context/, 'bundle page renders the manual command hint')
assert.match(bundleHtml, /基础设置/, 'bundle page renders the field sections')
assert.equal(render(bundleEntry.component(props)), '', 'bundle entry renders nothing outside the plugin page')

// ---------------------------------------------------------------------------
// v0.4 UI: enum dropdown, hover tooltips, rescue-gated dimming.
// ---------------------------------------------------------------------------
assert.match(html, /<select[^>]*id="plugin-config-gateway-wireReasoning"/, 'wireReasoning renders as a select')
assert.match(html, /<option [^>]*value="none">none<\/option>/, 'select offers none')
assert.match(html, /<option [^>]*value="high">high<\/option>/, 'select offers high')
assert.match(html, /不写该字段/, 'select offers the omit option')
assert.match(html, /title="根开关/, 'models label carries a dependency tooltip (root switch)')
assert.match(html, /title="独立项/, 'independent fields state they are independent in the tooltip')
assert.match(html, /title="「分片救援」组的总开关/, 'rescue switch tooltip names its dependent group')
assert.equal(face.hooks.gatewayCard.getSnapshot().rescueOn, true, 'rescue on by default → chunking group live')

// Turn the rescue switch off: snapshot flips and the chunking rows dim.
face.edit('chunkingEnabled', 'false')
assert.equal(face.hooks.gatewayCard.getSnapshot().rescueOn, false, 'staged rescue-off flips the gate')
html = renderCard()
assert.match(html, /依赖「超大对话分片救援」开启——当前已停用/, 'rescue-off note appears in the chunking group')
face.discard()

// ---------------------------------------------------------------------------
// Edit + save: staged text becomes a set op with the nested path.
// ---------------------------------------------------------------------------
face.edit('maxTokensFloor', '32768')
props = { t, useQwen38Card: (sel) => sel(face.hooks.gatewayCard.getSnapshot()) }
html = renderCard()
assert.match(html, /32768/, 'edited value renders before save')
assert.match(html, /未保存/, 'dirty card carries the unsaved tag on its header')

face.edit('chunkRatio', '0.9')
await face.save()
// vm-realm objects have a foreign prototype; normalize before comparing.
const norm = (v) => JSON.parse(JSON.stringify(v))
assert.equal(mutateCalls.length, 1)
const ops = norm(mutateCalls[0].ops)
assert.deepEqual(ops, [
  { op: 'set', path: ['maxTokensFloor'], value: 32768 },
  { op: 'set', path: ['chunking', 'chunkRatio'], value: 0.9 },
], 'save emits one op per staged field with correct paths')
assert.equal(mutateCalls[0].expectedRevision, 3)

// ---------------------------------------------------------------------------
// Invalid number blocks the save.
// ---------------------------------------------------------------------------
face.edit('maxTokensFloor', 'abc')
props = { t, useQwen38Card: (sel) => sel(face.hooks.gatewayCard.getSnapshot()) }
html = renderCard()
assert.match(html, /<button[^>]*>保存<\/button>/, 'save button present while dirty')
await face.save()
assert.equal(mutateCalls.length, 1, 'invalid field blocks the save')

// resetField stages an unset (the built-in CardForm semantics): the field shows the
// base value, loses its override badge, and saving emits an unset op.
face.resetField('maxTokensFloor')
props = { t, useQwen38Card: (sel) => sel(face.hooks.gatewayCard.getSnapshot()) }
html = renderCard()
assert.match(html, /maxTokensFloor" value="16384"/, 'reset shows the base value')
assert.ok(/<button[^>]*>保存<\/button>/.test(html), 'reset stages a pending unset (save appears)')
await face.save()
assert.equal(face.hooks.gatewayCard.getSnapshot().open, false, 'a settled save collapses the card')
const resetOps = norm(mutateCalls.at(-1).ops)
assert.deepEqual(resetOps, [{ op: 'unset', path: ['maxTokensFloor'] }], 'reset save emits an unset op')
// The fake scope applied the unset: only the chunkRatio override badge remains.
props = { t, useQwen38Card: (sel) => sel(face.hooks.gatewayCard.getSnapshot()) }
html = renderCard()
assert.equal((html.match(/已覆盖默认值/g) || []).length, 1, 'override badge count drops after unset')

// discard drops all staged edits.
face.edit('chunkRatio', '0.5')
face.discard()
props = { t, useQwen38Card: (sel) => sel(face.hooks.gatewayCard.getSnapshot()) }
html = renderCard()
assert.ok(!/<button[^>]*>保存<\/button>/.test(html), 'no save button after discard')

// ---------------------------------------------------------------------------
// Hard-reset command switch (nested command.newContext.enabled path).
// ---------------------------------------------------------------------------
assert.match(html, /硬重置命令 \/clear-context/, 'new-context switch label renders')
face.edit('newContextEnabled', 'false')
await face.save()
assert.deepEqual(norm(mutateCalls.at(-1).ops), [
  { op: 'set', path: ['command', 'newContext', 'enabled'], value: false },
], 'new-context switch writes the nested command path')

// ---------------------------------------------------------------------------
// Boolean field + clear semantics.
// ---------------------------------------------------------------------------
face.edit('enableThinkingOff', 'false')
face.edit('wireReasoning', '')
await face.save()
const lastOps = norm(mutateCalls.at(-1).ops)
assert.deepEqual(lastOps, [
  { op: 'set', path: ['enableThinkingOff'], value: false },
  { op: 'unset', path: ['wireReasoning'] },
], 'checkbox writes a boolean; blank text unsets the field')

// ---------------------------------------------------------------------------
// Per-model context windows: edit + reset, and the models list change.
// ---------------------------------------------------------------------------
face.editWindow('Qwen3.8-27B-GGUF', '123000')
await face.save()
assert.deepEqual(norm(mutateCalls.at(-1).ops), [
  { op: 'set', path: ['chunking', 'contextWindows', 'Qwen3.8-27B-GGUF'], value: 123000 },
], 'window edit targets the per-model contextWindows path')
face.resetWindow('Qwen3.8-27B-GGUF')
await face.save()
assert.deepEqual(norm(mutateCalls.at(-1).ops), [
  { op: 'unset', path: ['chunking', 'contextWindows', 'Qwen3.8-27B-GGUF'] },
], 'window reset emits an unset op')
face.edit('models', 'NewModel-42, Other')
await face.save()
const modelOps = norm(mutateCalls.at(-1).ops)
assert.deepEqual(modelOps, [{ op: 'set', path: ['models'], value: ['NewModel-42', 'Other'] }])

// ---------------------------------------------------------------------------
// Read-only “压缩提示词” section: the prompt text that shapes summary quality
// must be visible on the page, and the displayed main prompt must stay a
// faithful reference copy of the harness instruction.
// ---------------------------------------------------------------------------
const promptHtml = renderCard()
assert.match(promptHtml, /压缩提示词\(只读展示\)/, 'prompt display section renders')
assert.match(promptHtml, /dsh-compaction-basic/, 'main prompt names its source')
assert.match(promptHtml, /You are now acting as a compaction engine/, 'main instruction text renders')
assert.match(promptHtml, /分片合并前言/, 'merge preamble block renders')
assert.match(promptHtml, /Partial checkpoint 1 of N/, 'merge preamble sample renders')

// Cross-check the displayed reference copy against the harness source when the
// checkout is present (workspace layout: ../../deepseek-harness). Skipped in
// standalone checkouts that do not carry the harness source.
import { existsSync } from 'node:fs'
const summarizerPath = new URL('../../../deepseek-harness/packages/compaction/compaction-basic/src/summarizer.ts', import.meta.url)
if (existsSync(summarizerPath)) {
  const harness = readFileSync(summarizerPath, 'utf8')
  const m = harness.match(/const COMPACTION_INSTRUCTION = \[([\s\S]*?)\]\.join/)
  assert.ok(m, 'harness exposes COMPACTION_INSTRUCTION')
  const harnessText = eval(`(function () { const SUMMARY_OPEN_TAG = '<compacted-summary>'; return [${m[1]}].join('\\n'); })()`)
  const clientSrc = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const cm = clientSrc.match(/const MAIN_PROMPT_TEXT = `([\s\S]*?)`;/)
  assert.ok(cm, 'client.js embeds MAIN_PROMPT_TEXT')
  assert.equal(cm[1], harnessText, 'displayed main prompt is an exact copy of the harness instruction')
} else {
  console.log('note: harness source not present; reference-copy guard skipped')
}

console.log('client-smoke: all assertions passed')
