// v1.5.2 chunked-rescue tests: recency retention (keepRecentMessages, default
// 15, AgentScope-style), the lightweight chunk instruction, and the default
// window fallback. All internal calls are captured on a mock fetch — no
// network.
import {
  chunkedCompactionRescue,
  CHUNK_SUMMARY_INSTRUCTION,
  COMPACTION_SIGNATURE,
  MERGE_PREAMBLE,
} from '../index.js'

let passed = 0
let failed = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) passed += 1
  else {
    failed += 1
    console.log(`  FAIL ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`)
  }
}

function makeLogger() {
  return { logger: { info: () => {}, warn: () => {}, error: () => {} } }
}

// Build a compaction body whose prompt clearly exceeds one call under the
// fallback window (262144 * 0.7 ≈ 183k budget). 500 user messages x ~1k chars
// estimate ≈ 250k tokens.
function bigCompactionBody() {
  const messages = []
  for (let i = 0; i < 500; i++) {
    messages.push({ role: 'user', content: [{ type: 'text', text: `Message number ${i} with a plausible amount of conversation content about task ${i}: fixing ordering, renaming files, running tests, checking logs, and confirming the outcome. `.repeat(40) }] })
  }
  const instruction = `${COMPACTION_SIGNATURE}\nCondense the conversation ABOVE into a structured checkpoint.`
  messages.push({ role: 'user', content: [{ type: 'text', text: instruction }] })
  return { model: 'qwen3.8-max-0902', stream: false, max_tokens: 32768, messages }
}

console.log('chunked rescue (recency retention + chunk instruction + window fallback):')
{
  const calls = [] // {method, kind, body}
  const originalFetch = async (input) => {
    const url = typeof input === 'string' ? input : (input?.url ?? '')
    if (input && typeof input === 'object' && typeof input.text === 'function') {
      // internalCall passes a Request; its method is POST.
      const body = JSON.parse(await input.text())
      calls.push({ kind: 'internal', body })
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: `partial-summary-${calls.length}`, } , finish_reason: 'stop' }] }) }
    }
    if (url.includes('/v1/models')) {
      calls.push({ kind: 'probe', url })
      // No disclosure: forces the default fallback window path.
      return { ok: true, status: 200, json: async () => ({ data: [] }) }
    }
    throw new Error(`unexpected mock fetch ${url}`)
  }
  const body = bigCompactionBody()
  const init = { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
  const input = 'https://llm.goaichat.top/v1/chat/completions'
  const policy = {
    entries: [['temperature', 0.7]], floor: 32768, wireReasoning: 'none', enableThinkingOff: true,
    models: ['Qwen3.8-27B-GGUF'], matchAll: true, slimOversized: true, ninModels: new Set(),
    chunking: { enabled: true, contextWindows: {}, ratio: 0.7, chunkMaxTokens: 8192, mergeMaxTokens: 16384, maxChunks: 8 }, // keepRecentMessages intentionally absent -> default 15
  }
  const res = await chunkedCompactionRescue(makeLogger(), originalFetch, input, init, policy)
  check('rescue commits (returns a synthetic Response)', !!(res && typeof res.status === 'number'), true)
  if (!res) throw new Error('rescue returned undefined; cannot inspect commit path')

  const internals = calls.filter((c) => c.kind === 'internal')
  check('probe attempted once', calls.filter((c) => c.kind === 'probe').length, 1)
  check('internal calls: slices + merge', internals.length >= 3, true)

  const sliceMessages = (bodyMsg) => (bodyMsg.messages ?? [])
  // Last slice call carries the chunk instruction; the merge call carries the official instruction.
  const lastMsgContent = (m) => {
    const arr = m.content
    if (Array.isArray(arr)) return arr.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('')
    return typeof m.content === 'string' ? m.content : ''
  }
  const sliceCalls = internals.filter((c) => {
    const msgs = sliceMessages(c.body)
    const tail = msgs[msgs.length - 1]
    return lastMsgContent(tail) === CHUNK_SUMMARY_INSTRUCTION
  })
  check('every slice uses the lightweight chunk instruction', sliceCalls.length, internals.length - 1)
  const mergeCall = internals.find((c) => {
    const msgs = sliceMessages(c.body)
    const tail = lastMsgContent(msgs[msgs.length - 1])
    return tail.startsWith(COMPACTION_SIGNATURE)
  })
  check('merge call ends with the official instruction', !!mergeCall, true)

  // Recency retention: the last 15 conversation messages never appear in any
  // slice (they are appended verbatim to the merge input instead).
  const keptTexts = body.messages.slice(-16, -1).map((m) => JSON.stringify(m))
  const inAnySlice = (arr) => arr.some((m) => JSON.stringify(m) === keptTexts[0])
  check('oldest kept message absent from every slice', sliceCalls.every((c) => !inAnySlice(sliceMessages(c.body))), true)
  const mergeMsgs = mergeCall ? sliceMessages(mergeCall.body) : []
  check('merge input includes the verbatim recent tail', mergeMsgs.some((m) => JSON.stringify(m) === keptTexts[0]), true)
  check('merge input includes MERGE_PREAMBLE', mergeMsgs.some((m) => lastMsgContent(m) === MERGE_PREAMBLE), true)

  const json = await res.json()
  const content = json.choices?.[0]?.message?.content ?? ''
  check('final response carries merged text', content.includes('partial-summary'), true)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)