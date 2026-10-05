import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm';
import * as plugin from '../index.js';

test('real Cordis + LlmRuntime load, recurse through native adapter, hot-read and unload cleanly', async () => {
  const ctx = new Context();
  new LlmRuntime(ctx);
  let calls = 0;
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 8192 }, reasoning: { efforts: [{ id: 'off', name: 'Off' }] } }; }
    async *stream(options) {
      calls++;
      assert.ok(options.messages.length <= 5);
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Verified native checkpoint.' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['fixture'], new Adapter());
  const fetch = globalThis.fetch;
  try {
    const fiber = ctx.plugin(plugin, { command: { enabled: false, newContext: { enabled: false } }, autoCompaction: { enabled: false }, maxTokensFloor: 512,
      chunking: { chunkMaxTokens: 256, mergeMaxTokens: 512, maxChunks: 128, keepRecentMessages: 0 } });
    await fiber;
    const request = Object.freeze({ provider: 'fixture', model: 'small', purpose: 'compaction', messages: [
      { role: 'user', content: [{ type: 'text', text: 'facts 当前任务 '.repeat(10000) }] },
      { role: 'user', content: [{ type: 'text', text: 'Produce a checkpoint.' }] },
    ] });
    const output = [];
    for await (const c of ctx.llm.stream(request)) output.push(c);
    assert.equal(output.at(-1)?.reason.kind, 'stop');
    assert.ok(calls > 2);
    assert.equal(globalThis.fetch, fetch);
    await fiber.dispose();
    const prior = calls;
    for await (const _ of ctx.llm.stream({ provider: 'fixture', model: 'small', messages: [{ role: 'user', content: [{ type: 'text', text: 'plain' }] }] })) {}
    assert.equal(calls, prior + 1);
  } finally { await ctx.fiber.dispose(); }
});
