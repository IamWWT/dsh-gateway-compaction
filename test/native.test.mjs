import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCompactionMiddleware, readConfig, routePolicy, splitText, textTokens, estimateMessages, historyText } from '../native-compaction.js';
import { Config, validateRelations } from '../config.js';
import { GROUPS } from '../ui-fields.js';
const user = text => ({ role: 'user', content: [{ type: 'text', text }] });
const instruction = user('Produce a concise structured checkpoint with current intent and next step.');
const config = { maxTokensFloor: 512, chunking: { contextWindows: { m: 8192 }, chunkMaxTokens: 256, mergeMaxTokens: 512, headroomTokens: 256, maxOutputTokens: 2048, retryDelayMs: 0, keepRecentMessages: 0 } };
function fixture(settings = config, respond = () => ({ text: 'A concise checkpoint with the next step.', reason: { kind: 'stop' } }), info = {}) {
  const calls = []; let pass = 0, middleware;
  const ctx = { logger: { info() {}, warn() {} }, llm: {
    resolveModelInfo: async () => ({ context: { contextWindow: 8192 }, reasoning: { efforts: [{ id: 'off' }] }, ...info }),
    stream(request) {
      return middleware(request, async function* () {
        calls.push(request);
        const r = await respond(request, calls.length);
        if (r.throw) throw r.throw;
        if (r.text !== undefined) {
          yield { type: 'text-delta', index: 0, text: r.text };
          yield { type: 'block-end', index: 0, block: { type: 'text', text: r.text } };
        }
        if (r.reason) yield { type: 'finish', reason: r.reason };
      });
    },
  } };
  middleware = createCompactionMiddleware(ctx, () => settings);
  async function run(messages = [user('Some work.'), instruction], extra = {}) {
    const chunks = [];
    for await (const c of middleware(Object.freeze({ purpose: 'compaction', provider: 'p', model: 'm', messages, ...extra }), async function* () { pass++; yield { type: 'finish', reason: { kind: 'stop' } }; })) chunks.push(c);
    return chunks;
  }
  return { run, calls, passed: () => pass };
}
test('provider-neutral route recurses only once, supports immutable input and no private wire fields', async () => {
  const f = fixture(); const chunks = await f.run();
  assert.equal(f.calls.length, 1); assert.equal(f.passed(), 0);
  assert.equal(chunks.at(-1).reason.kind, 'stop');
  assert.equal(f.calls[0].reasoningEffort, 'off');
  assert.equal(f.calls[0].temperature, undefined);
  assert.equal(f.calls[0].tools, undefined); assert.equal(f.calls[0].toolHistory, undefined);
  assert.equal(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'A concise checkpoint with the next step.');
});
test('normal conversation, titles, disabled and empty allow-list pass through', async () => {
  for (const [settings, extra] of [[config, { purpose: undefined }], [config, { purpose: 'session-title' }], [{ enabled: false }, {}], [{ matchAll: false, models: [] }, {}]]) {
    const f = fixture(settings); await f.run(undefined, extra); assert.equal(f.passed(), 1); assert.equal(f.calls.length, 0);
  }
});
test('single enormous message is split without dropping its middle; requests fit combined budgets', async () => {
  const text = '历史🧠 fact\n'.repeat(12000) + 'IMPORTANT-END';
  const f = fixture(); await f.run([user(text), instruction]);
  assert.ok(f.calls.length > 2);
  const maps = f.calls.slice(0, -1).map(c => c.messages[0].content[0].text).join('');
  assert.ok(maps.includes('IMPORTANT-END'));
  assert.equal(maps.replace(/^\[user\]\n/, ''), text);
  for (const c of f.calls) assert.ok(estimateMessages(c.messages, 1.2) + c.maxTokens + 820 <= 8192);
});
test('lossless unicode splitter reconstructs source at every budget', () => {
  const text = '中😀 abc\n'.repeat(1000);
  for (const budget of [64, 128, 1024]) { const parts = splitText(text, budget, 1.2); assert.equal(parts.join(''), text); assert.ok(parts.every(s => textTokens(s, 1.2) <= budget)); }
});
test('tail token cap puts oversized recent messages into chunks, zero disables retention', async () => {
  const f = fixture({ ...config, chunking: { ...config.chunking, keepRecentMessages: 15, keepRecentTokens: 100 } });
  const tail = '最新事实'.repeat(9000);
  await f.run([user('Old '.repeat(9000)), user(tail), instruction]);
  assert.ok(f.calls.length > 2);
  assert.ok(!f.calls.at(-1).messages.some(m => m.content[0].text.includes(tail)));
});
test('output truncation increases budget once and never reports incomplete output as stop', async () => {
  const f = fixture(config, (_, n) => ({ text: n === 1 ? 'TRUNCATED' : 'Complete checkpoint', reason: { kind: n === 1 ? 'max-tokens' : 'stop' } }));
  const chunks = await f.run(); assert.equal(f.calls[1].maxTokens, f.calls[0].maxTokens * 2);
  assert.equal(chunks[1].text, 'Complete checkpoint');
});
test('empty, missing finish, terminal auth error and persistent truncation fail without fabricated success', async () => {
  for (const response of [{ text: '', reason: { kind: 'stop' } }, { text: 'no finish' }, { text: 'partial', reason: { kind: 'error', failure: { code: 'AUTHENTICATION_ERROR' } } }, { text: 'cut off', reason: { kind: 'max-tokens' } }]) {
    const f = fixture({ ...config, chunking: { ...config.chunking, retries: 0 } }, () => response);
    await assert.rejects(f.run());
  }
});
test('actual overflow is recovered by smaller fragments, bounded by maxCalls', async () => {
  const f = fixture(config, (req, n) => n === 1 ? { reason: { kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED' } } } : { text: 'Smaller checkpoint', reason: { kind: 'stop' } });
  await f.run([user('History '.repeat(700)), instruction]); assert.ok(f.calls.length >= 3);
  const blocked = fixture({ ...config, chunking: { ...config.chunking, maxCalls: 1 } });
  await assert.rejects(blocked.run([user('History '.repeat(10000)), instruction]), /maxCalls/);
});
test('provider/model policies are exact, preserve global window maps and use a separate summary route', async () => {
  const cfg = { ...config, summaryRoute: { provider: 'other', model: 'sum' }, modelPolicies: [{ provider: 'other', model: 'sum', effort: 'high', chunking: { chunkMaxTokens: 128, contextWindows: {} } }] };
  assert.equal(routePolicy(cfg, 'other', 'sum').chunking.contextWindows.m, 8192);
  assert.equal(routePolicy(cfg, 'p', 'sum').effort, 'off');
  const f = fixture(cfg, undefined, { reasoning: { efforts: [{ id: 'low' }] } }); await f.run();
  assert.equal(f.calls[0].provider, 'other'); assert.equal(f.calls[0].model, 'sum');
  assert.equal(f.calls[0].reasoningEffort, undefined, 'unsupported requested effort must not be sent');
});
test('cancellation interrupts stalled adapters and does not start retries', async () => {
  const controller = new AbortController();
  const f = fixture(config, () => new Promise(() => {}));
  const pending = f.run(undefined, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(new Error('cancelled-by-user')), 20);
  await assert.rejects(pending, /cancelled-by-user/); clearTimeout(timer); assert.equal(f.calls.length, 1);
});
test('deadline bounds an adapter that ignores abort signals', async () => {
  const keepAlive = setInterval(() => {}, 30);
  try {
    const f = fixture({ ...config, chunking: { ...config.chunking, timeoutMs: 100, retries: 0 } }, () => new Promise(() => {}));
    await assert.rejects(f.run(), /timeout/i); assert.equal(f.calls.length, 1);
  } finally { clearInterval(keepAlive); }
});
test('preprocessing is private and zero keeps tool parameters/results intact', () => {
  const message = { role: 'tool', content: [{ type: 'text', text: 'x'.repeat(200) }, { type: 'reasoning', text: 'private thought' }] };
  const before = JSON.stringify(message);
  const cfg = readConfig({ preprocessing: { maxToolResultChars: 10 } });
  assert.match(historyText(message, cfg), /excerpt/); assert.ok(!historyText(message, cfg).includes('private thought'));
  assert.ok(historyText(message, readConfig({ preprocessing: { maxToolResultChars: 0 } })).includes('x'.repeat(200)));
  assert.equal(JSON.stringify(message), before);
});
test('all UI fields exist in schema; invalid ranges rejected and partial model override inherits', () => {
  const resolved = Config['~standard'].validate({}); assert.equal(resolved.issues, undefined);
  const cfg = readConfig(resolved.value);
  for (const group of GROUPS) {
    assert.equal(group.length, 4, 'group must be [title, badge, summary, fields]');
    assert.ok(['常用', '高级'].includes(group[1]), `group ${group[0]} badge`);
    assert.ok(typeof group[2] === 'string' && group[2].length > 0, `group ${group[0]} summary`);
    for (const [key, , , help] of group[3]) {
      const parts = key.split('.'); let value = cfg;
      for (const part of parts.slice(0, -1)) value = value[part];
      assert.ok(value && typeof value === 'object', key);
      // Optional retention fields intentionally have no default.
      assert.ok(Object.hasOwn(value, parts.at(-1)) || /retain/.test(key), key);
      assert.ok(help.includes('键：'), `${key} help must name its configuration key`);
    }
  }
  for (const chunking of [{ retries: -1 }, { chunkRatio: 1 }, { keepRecentMessages: 0.5 }, { timeoutMs: 0 }]) assert.ok(Config['~standard'].validate({ chunking }).issues);
  assert.throws(() => validateRelations({ summaryRoute: { provider: 'p' } }), /provider/);
  assert.throws(() => validateRelations({ modelPolicies: [{ provider: 'p', model: 'm' }, { provider: 'p', model: 'm' }] }), /重复/);
});
