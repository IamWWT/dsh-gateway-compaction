/**
 * Gating smoke test for dsh-gateway-compaction.
 *
 * Run from this directory (a `node_modules` symlink into a tree that provides
 * @deepseek-ai/schemastery + @deepseek-ai/dsh-settings must be resolvable —
 * e.g. the profile's node_modules, or the global dsh install):
 *
 *   node test/smoke.mjs
 */
import {
  COMPACTION_SIGNATURE,
  TITLE_SIGNATURE,
  apply,
  applyThinkingOff,
  buildInternalBody,
  estimateBodyTokens,
  estimateMessageTokens,
  estimateTextTokens,
  rewriteCompactionBody,
  rewriteTitleBody,
  sliceMessages,
  truncateMessageToBudget
} from "../index.js";

let passed = 0;
let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`);
  }
}

const POLICY = {
  entries: [
    ["temperature", 0.7],
    ["top_p", 0.8],
    ["top_k", 20],
    ["min_p", 0.0],
    ["presence_penalty", 1.5],
    ["repetition_penalty", 1.0]
  ],
  floor: 16384,
  wireReasoning: "none",
  enableThinkingOff: true,
  models: ["Qwen3.8-27B-GGUF"],
  chunking: null
};

function compactionInit(model, { maxTokens = 1, extraMessages = [] } = {}) {
  const body = {
    model,
    stream: true,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: "You are a coding assistant." },
      ...extraMessages,
      { role: "user", content: `please do something` },
      { role: "assistant", content: "done" },
      { role: "user", content: `${COMPACTION_SIGNATURE}\nCondense the conversation ABOVE...` }
    ]
  };
  return { body: JSON.stringify(body) };
}

function titleInit(model, maxTokens = 64) {
  const body = {
    model,
    stream: true,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: `${TITLE_SIGNATURE}\n...` },
      { role: "user", content: "first human message" }
    ]
  };
  return { body: JSON.stringify(body) };
}

console.log("compaction gate:");
{
  const init = compactionInit("Qwen3.8-27B-GGUF");
  check("allowed model is rewritten", rewriteCompactionBody(init, POLICY), true);
  const body = JSON.parse(init.body);
  check("  enable_thinking merged", body.chat_template_kwargs?.enable_thinking, false);
  check("  reasoning_effort written", body.reasoning_effort, "none");
  check("  sampling applied", [body.temperature, body.top_p, body.top_k, body.min_p, body.presence_penalty, body.repetition_penalty], [0.7, 0.8, 20, 0.0, 1.5, 1.0]);
  check("  max_tokens raised to floor", body.max_tokens, 16384);

  const init2 = compactionInit("gpt-4.1");
  check("disallowed model untouched", [rewriteCompactionBody(init2, POLICY), init2.body.length > 0 && !init2.body.includes("enable_thinking")], [false, true]);

  const init3 = { body: JSON.stringify({ stream: true, messages: [{ role: "user", content: COMPACTION_SIGNATURE }] }) };
  check("missing model field untouched", rewriteCompactionBody(init3, POLICY), false);

  check("empty models list disables policy", rewriteCompactionBody(compactionInit("Qwen3.8-27B-GGUF"), { ...POLICY, models: [] }), false);

  const quoted = compactionInit("Qwen3.8-27B-GGUF", {
    extraMessages: [{ role: "user", content: COMPACTION_SIGNATURE + " (quoted in an earlier turn)" }]
  });
  check("signature quoted mid-conversation still rewrites the real call", rewriteCompactionBody(quoted, POLICY), true);

  const trailing = { body: JSON.stringify({ model: "Qwen3.8-27B-GGUF", messages: [{ role: "user", content: `see docs:\n${COMPACTION_SIGNATURE}` }] }) };
  check("last user message NOT starting with the signature untouched", rewriteCompactionBody(trailing, POLICY), false);

  const merged = { body: JSON.stringify({ model: "Qwen3.8-27B-GGUF", chat_template_kwargs: { other_kwarg: 1 }, messages: [{ role: "user", content: COMPACTION_SIGNATURE }] }) };
  check("existing chat_template_kwargs preserved on merge", [rewriteCompactionBody(merged, POLICY), JSON.parse(merged.body).chat_template_kwargs], [true, { other_kwarg: 1, enable_thinking: false }]);

  const onlySampling = { ...POLICY, wireReasoning: "", enableThinkingOff: false };
  const samplingOnly = compactionInit("Qwen3.8-27B-GGUF");
  check("sampling/floor still apply when thinking-off gates are off", [rewriteCompactionBody(samplingOnly, onlySampling), JSON.parse(samplingOnly.body).temperature, JSON.parse(samplingOnly.body).max_tokens, "chat_template_kwargs" in JSON.parse(samplingOnly.body)], [true, 0.7, 16384, false]);
}
console.log("tool stripping (Qwen3 + llama.cpp tool-call trap):");
{
  // A compaction body carrying the conversation's tool schemas must come back
  // WITHOUT tools: with tools present and thinking off, Qwen3 on llama.cpp
  // answers a tool call (empty content) instead of the text checkpoint.
  const init = compactionInit("Qwen3.8-27B-GGUF");
  const body = JSON.parse(init.body);
  body.tools = [{ type: "function", function: { name: "bash" } }];
  body.tool_choice = "auto";
  init.body = JSON.stringify(body);
  check("compaction: rewrite strips tools + tool_choice", [rewriteCompactionBody(init, POLICY), JSON.parse(init.body).tools, JSON.parse(init.body).tool_choice], [true, undefined, undefined]);
  // Title bodies get the same treatment.
  const tinit = titleInit("Qwen3.8-27B-GGUF");
  const tbody = JSON.parse(tinit.body);
  tbody.tools = [{ type: "function", function: { name: "bash" } }];
  tinit.body = JSON.stringify(tbody);
  check("title: rewrite strips tools", [rewriteTitleBody(tinit, POLICY), JSON.parse(tinit.body).tools], [true, undefined]);
}

console.log("title gate:");
{
  const init = titleInit("Qwen3.8-27B-GGUF");
  check("allowed model is rewritten", rewriteTitleBody(init, POLICY), true);
  const body = JSON.parse(init.body);
  check("  enable_thinking merged", body.chat_template_kwargs?.enable_thinking, false);
  check("  reasoning_effort written", body.reasoning_effort, "none");
  check("  title max_tokens left alone", body.max_tokens, 64);

  const init2 = titleInit("Gemma4-12B");
  check("disallowed model untouched", rewriteTitleBody(init2, POLICY), false);

  const userRole = { body: JSON.stringify({ model: "Qwen3.8-27B-GGUF", messages: [{ role: "user", content: TITLE_SIGNATURE }] }) };
  check("signature in a user-role message untouched (must be system/developer)", rewriteTitleBody(userRole, POLICY), false);

  const disabled = { ...POLICY, wireReasoning: "", enableThinkingOff: false };
  check("both gates off -> untouched", rewriteTitleBody(titleInit("Qwen3.8-27B-GGUF"), disabled), false);
}

console.log("estimation:");
{
  const ascii = estimateTextTokens("a".repeat(400));
  const cjk = estimateTextTokens("中".repeat(100));
  check("ascii ~4 chars/token", ascii, 100);
  check("cjk ~1 char/token (conservative)", cjk, 100);
  check("cjk denser than ascii for equal length", estimateTextTokens("中".repeat(400)) > estimateTextTokens("a".repeat(400)), true);
  const withTools = { messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "x", description: "d".repeat(400) } }] };
  check("body estimate includes tools", estimateBodyTokens(withTools) > estimateBodyTokens({ messages: [{ role: "user", content: "hi" }] }), true);
}

console.log("slicing:");
{
  const big = (n) => ({ role: "user", content: `message ${n}: ` + "x".repeat(n * 1000) });
  const messages = [
    { role: "system", content: "sys" },
    { role: "developer", content: "dev" },
    big(1),
    { role: "assistant", content: "a1", tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "tool result" },
    big(2),
    big(3)
  ];
  const sliced = sliceMessages(messages, 600);
  check("leading system/developer peeled into prefix", sliced.prefix.map((m) => m.role), ["system", "developer"]);
  check("all non-prefix messages covered exactly once in order", sliced.slices.flat().map((m) => (typeof m.content === "string" ? m.content.slice(0, 12) : m.role)), [
    "message 1: x",
    "a1",
    "tool result",
    "message 2: x",
    "message 3: x"
  ]);
  check("no slice starts with a tool message", sliced.slices.some((s) => s[0]?.role === "tool"), false);
  check("assistant tool_calls kept with its tool result", sliced.slices.some((s) => s.includes(messages[3]) && s.includes(messages[4])), true);
  check("every slice fits the budget (or holds an orphan-guard overflow)", sliced.slices.every((s) => s.reduce((sum, m) => sum + estimateMessageTokens(m), 0) <= 600 || s.some((m) => m.role === "tool")), true);

  const truncated = truncateMessageToBudget({ role: "user", content: "y".repeat(100000) }, 200);
  check("oversized single message truncated below budget", estimateMessageTokens(truncated) <= 200, true);
  check("truncation marker present", truncated.content.includes("truncated"), true);
}

console.log("internal call bodies:");
{
  const source = {
    model: "Qwen3.8-27B-GGUF",
    stream: true,
    max_tokens: 16384,
    temperature: 0.7,
    chat_template_kwargs: { enable_thinking: false },
    reasoning_effort: "none",
    tools: [{ type: "function" }],
    messages: []
  };
  const out = buildInternalBody(source, [{ role: "user", content: "slice" }], 8192);
  check("model kept", out.model, "Qwen3.8-27B-GGUF");
  check("thinking-off fields kept", [out.chat_template_kwargs?.enable_thinking, out.reasoning_effort], [false, "none"]);
  check("sampling kept", out.temperature, 0.7);
  check("tools dropped", "tools" in out, false);
  check("stream forced false", out.stream, false);
  check("max_tokens set to the internal cap", out.max_tokens, 8192);
  check("messages replaced", out.messages, [{ role: "user", content: "slice" }]);
}

console.log("settings wiring:");
{
  // New API generation (dsh-settings >= 0.1.3): ctx.settings.installSection.
  let newApiCall = null;
  const hooksSink = {};
  const ctxNew = {
    logger: { info() {}, warn() {}, error() {} },
    on() {},
    llm: { resolveModelInfo: async () => ({}) },
    inject: (deps, cb) => {
      if (deps.includes("settings")) cb({ settings: { installSection: (owner, ns, schema, entry, hooks) => { newApiCall = { ns, entry }; Object.assign(hooksSink, hooks); } } });
    }
  };
  const listeners = {};
  ctxNew.on = (ev, fn) => { listeners[ev] = fn; };
  apply(ctxNew, { models: ["Qwen3.8-27B-GGUF"] });
  check("new API: installSection called with the namespace", newApiCall?.ns, "gateway-compaction");
  check("new API: entry is schema-resolved (defaults filled)", [newApiCall?.entry?.effort, newApiCall?.entry?.maxTokensFloor, newApiCall?.entry?.chunking?.enabled], ["off", 16384, true]);
  // setSource from the settings scope must re-point the live policy: after
  // switching the allow-list away, a previously-allowed model passes through
  // untouched (synchronous next) instead of entering the effort gate.
  hooksSink.setSource(() => ({ ...newApiCall.entry, models: ["some-other-model"] }));
  let passThrough = 0;
  const r = listeners["llm/stream"]({ provider: "qwen", model: "Qwen3.8-27B-GGUF", purpose: "compaction" }, () => { passThrough++; });
  check("new API: setSource re-points the live policy", [passThrough, r === undefined], [1, true]);
}
{
  // No settings surface at all: entry-only fallback must still work.
  const listeners = {};
  const ctxBare = {
    logger: { info() {}, warn() {}, error() {} },
    on: (ev, fn) => { listeners[ev] = fn; },
    llm: { resolveModelInfo: async () => ({}) }
  };
  apply(ctxBare, {});
  const options = { provider: "qwen", model: "Qwen3.8-27B-GGUF", purpose: "compaction" };
  let nextCalled = 0;
  const gen = listeners["llm/stream"](options, () => { nextCalled++; return (async function* () { yield "x"; })(); });
  for await (const _ of gen) {}
  check("no settings service: waterfall still runs on entry defaults", nextCalled === 1 && options.reasoningEffort === undefined, true);
}

console.log("manual compaction command:");
{
  // A ctx that provides the commands service: the global manual-command
  // registrations must land inside an injected child context.
  const registeredDefs = [];
  const injectCalls = [];
  // Drive generator effects to completion (the real runtime unwinds them on
  // teardown; the test just needs the body to run).
  const runEffect = (fn) => {
    if (typeof fn !== "function") return () => {};
    const result = fn();
    if (result && typeof result.next === "function") {
      let step = result.next();
      while (!step.done) step = result.next();
    }
    return () => {};
  };
  const ctxCmd = {
    logger: { info() {}, warn() {}, error() {} },
    on() {},
    llm: { resolveModelInfo: async () => ({}) },
    effect: runEffect,
    inject: (deps, cb) => {
      injectCalls.push([...deps]);
      if (deps.includes("commands")) cb({
        commands: { register: (def) => { registeredDefs.push(def); return () => {}; } },
        effect: runEffect,
        // The real cordis child context exposes `reflect`; the engine's
        // Service constructor registers itself through it.
        reflect: { provide() {} }
      });
    }
  };
  apply(ctxCmd, {});
  check("command: inject declares the required services", injectCalls.some((d) => d.includes("commands") && d.includes("tokenMeter") && d.includes("sessions")), true);
  const names = registeredDefs.map((d) => d.name).sort();
  check("command: both manual commands registered by default", JSON.stringify(names), JSON.stringify(["clear-context", "gateway-compact"]));
  for (const def of registeredDefs) {
    check(`command: ${def.name} handler is async`, typeof def.handler, "function");
  }
  // Handler against a non-maintenance agent maps to the friendly busy text.
  const inv = { agent: {}, signal: new AbortController().signal, commandId: "c1" };
  for (const def of registeredDefs) {
    const out = await def.handler(inv);
    check(`command: ${def.name} bad agent yields a friendly error (no throw)`, typeof out?.text === "string" && out.text.length > 0, true);
    // Regression guard: the engine must actually construct on the handler
    // path. `new makeHardResetEngine(E)(args)` parses as `new (E-subclass(args))`
    // and dies with "cannot be invoked without 'new'" — which this text check
    // would otherwise swallow as a generic friendly error.
    check(`command: ${def.name} engine constructs (no precedence bug)`, !/construction failed/.test(out.text), true);
  }
}
{
  // Standard-preset sessions already register the built-in `compaction`
  // service; constructing another engine there used to throw
  // `service "compaction" has been registered`. The manual engines must stay
  // usable in that environment (they run detached from the registry).
  const registeredStd = [];
  const runEffectStd = (fn) => {
    if (typeof fn !== "function") return () => {};
    const result = fn();
    if (result && typeof result.next === "function") {
      let step = result.next();
      while (!step.done) step = result.next();
    }
    return () => {};
  };
  const ctxStd = {
    logger: { info() {}, warn() {}, error() {} },
    on() {},
    llm: { resolveModelInfo: async () => ({}) },
    effect: runEffectStd,
    inject: (deps, cb) => {
      if (deps.includes("commands")) cb({
        commands: { register: (def) => { registeredStd.push(def); return () => {}; } },
        effect: runEffectStd,
        reflect: {
          provide(name) {
            if (name === "compaction") throw new Error('service "compaction" has been registered at <built-in>');
          }
        }
      });
    }
  };
  apply(ctxStd, {});
  const invStd = { agent: {}, signal: new AbortController().signal, commandId: "c2" };
  for (const def of registeredStd) {
    const out = await def.handler(invStd);
    check(`command(std session): ${def.name} survives the built-in compaction service`, typeof out?.text === "string" && !/construction failed|has been registered/.test(out.text), true);
  }
}
{
  // command.newContext.enabled: false suppresses ONLY the hard-reset command.
  let registered = null;
  const runEffectOff = (fn) => {
    if (typeof fn !== "function") return () => {};
    const result = fn();
    if (result && typeof result.next === "function") {
      let step = result.next();
      while (!step.done) step = result.next();
    }
    return () => {};
  };
  const ctxNewCtxOff = {
    logger: { info() {}, warn() {}, error() {} },
    on() {},
    llm: { resolveModelInfo: async () => ({}) },
    effect: runEffectOff,
    inject: (deps, cb) => {
      if (deps.includes("commands")) cb({ commands: { register: (def) => { registered = def; return () => {}; } }, effect: runEffectOff });
    }
  };
  apply(ctxNewCtxOff, { command: { newContext: { enabled: false } } });
  check("command: newContext disabled keeps only /gateway-compact", registered?.name, "gateway-compact");
}
{
  // The hard-reset engine's summarizer is a template: it must not touch the
  // LLM seam and must return the unmarked SummaryResult variant.
  const { makeHardResetEngine } = await import("../index.js");
  class FakeBase { constructor(ctx, config) { this.ctx = ctx; this.config = config; } }
  let llmTouched = false;
  const HardReset = makeHardResetEngine(FakeBase);
  const instance = new HardReset({ llm: { stream() { llmTouched = true; } } }, { auto: false });
  const result = await instance.summarize();
  check("new-context: summarizer makes no LLM call", llmTouched, false);
  check("new-context: summary is a single text block", Array.isArray(result.summary) && result.summary.length === 1 && result.summary[0].type === "text" && /硬重置/.test(result.summary[0].text), true);
  check("new-context: unmarked variant (no llmStreamCall)", !("llmStreamCall" in result) && typeof result.provider === "string" && typeof result.model === "string", true);
}
{
  // command.enabled: false must suppress the /gateway-compact registration
  // (the hard-reset command is gated by its own flag and stays registered).
  const registeredDefsOff = [];
  const runEffectOff2 = (fn) => {
    if (typeof fn !== "function") return () => {};
    const result = fn();
    if (result && typeof result.next === "function") {
      let step = result.next();
      while (!step.done) step = result.next();
    }
    return () => {};
  };
  const ctxOff = {
    logger: { info() {}, warn() {}, error() {} },
    on() {},
    llm: { resolveModelInfo: async () => ({}) },
    effect: runEffectOff2,
    inject: (deps, cb) => {
      if (deps.includes("commands")) cb({ commands: { register: (def) => { registeredDefsOff.push(def); return () => {}; } }, effect: runEffectOff2 });
    }
  };
  apply(ctxOff, { command: { enabled: false } });
  check("command: compact disabled via config leaves only /clear-context", JSON.stringify(registeredDefsOff.map((d) => d.name)), JSON.stringify(["clear-context"]));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
