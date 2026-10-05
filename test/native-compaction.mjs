import assert from 'node:assert/strict';
import { apply } from '../index.js';

// Reproduce the desktop's volatile configuration + frozen compaction envelope.
// The adapter owns its transport; global fetch interception cannot repair it.
const originalFetch = globalThis.fetch;
const handlers = new Map();
const requests = [];
const config = Object.fromEntries(Object.entries({
  matchAll: true, models: [], command: { enabled: false, newContext: { enabled: false } },
  autoCompaction: { enabled: false },
  chunking: { enabled: true, contextWindows: { 'small-model': 8192 }, chunkRatio: 0.7,
    chunkMaxTokens: 512, mergeMaxTokens: 1024, maxChunks: 64, keepRecentMessages: 0 },
}).map(([key, value]) => [key, { get: () => value }]));
const ctx = {
  on: (key, fn) => { handlers.set(key, fn); },
  effect: () => {}, inject: () => {},
  logger: { info() {}, warn() {}, error() {} },
  llm: {
    resolveModelInfo: async () => ({ context: { contextWindow: 8192 }, defaultMaxTokens: 1024,
      reasoning: { efforts: [{ id: 'off' }] } }),
    async *stream(options) {
      requests.push(options);
      assert.ok(JSON.stringify(options.messages).length < 24000, 'internal input must fit the smaller model');
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'Checkpoint: preserve the user request and next step.' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Checkpoint: preserve the user request and next step.' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  },
};
apply(ctx, config);
const options = Object.freeze({ purpose: 'compaction', provider: 'fixture', model: 'small-model',
  messages: Object.freeze([
    ...Array.from({ length: 30 }, () => Object.freeze({ role: 'user', content: [{ type: 'text', text: '历史事实 current work '.repeat(600) }] })),
    { role: 'user', content: [{ type: 'text', text: 'You are now acting as a compaction engine for this AI coding assistant. Produce a checkpoint.' }] },
  ]), maxTokens: 1,
});
let nextCalls = 0;
const chunks = [];
for await (const chunk of handlers.get('llm/stream')(options, async function* () {
  nextCalls++;
  yield { type: 'finish', reason: { kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED' } } };
})) chunks.push(chunk);
assert.equal(nextCalls, 0, 'overfull compaction must not reach the adapter unchanged');
assert.ok(requests.length > 1, 'must summarize through the public LLM service in bounded chunks');
assert.equal(chunks.at(-1)?.reason?.kind, 'stop');
assert.equal(globalThis.fetch, originalFetch, 'must not monkey-patch process-global fetch');
assert.equal(options.maxTokens, 1, 'caller-owned frozen input remains unchanged');
console.log('PASS native compaction: volatile settings, bounded requests, frozen input, public transport');
