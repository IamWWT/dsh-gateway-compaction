import z from '@deepseek-ai/schemastery';
import { DEFAULTS } from './native-compaction.js';

const integer = (min, max) => z.number().step(1).min(min).max(max);
const ratio = (min, max) => z.number().min(min).max(max);
const chunkFields = {
  enabled: z.boolean(), contextWindows: z.dict(integer(1024, 10000000)),
  fallbackWindow: integer(1024, 10000000), chunkRatio: ratio(0.1, 0.95),
  chunkMaxTokens: integer(128, 262144), mergeMaxTokens: integer(128, 262144),
  maxChunks: integer(1, 4096), keepRecentMessages: integer(0, 1000), keepRecentTokens: integer(0, 1000000),
  headroomTokens: integer(0, 1000000), safetyRatio: ratio(0, 0.5), tokenSafetyFactor: ratio(1, 4),
  maxOutputTokens: integer(128, 262144), maxStreamInputTokens: integer(0, 10000000), betweenCallsMs: integer(0, 60000), maxMergeRounds: integer(1, 32), maxCalls: integer(1, 8192),
  retries: integer(0, 8), timeoutMs: integer(100, 3600000), totalTimeoutMs: integer(100, 14400000),
  retryDelayMs: integer(0, 60000),
};
const preFields = { maxToolArgumentChars: integer(0, 1000000), maxToolResultChars: integer(0, 1000000), dropReasoning: z.boolean() };
const withDefaults = (fields, defaults) => z.object(Object.fromEntries(Object.entries(fields).map(([key, schema]) => [key, schema.default(defaults[key])])));
const sampling = () => z.object({ temperature: z.union([ratio(0, 2), z.const(null)]) });
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(), matchAll: z.boolean().default(true).volatile(),
  models: z.array(z.string()).default([]).volatile(), effort: z.string().default('off').volatile(),
  compactionEffort: z.string().default('').volatile(),
  supplementOn: z.boolean().default(true).volatile(), supplement: z.string().default(DEFAULTS.supplement).volatile(),
  maxTokensFloor: integer(0, 262144).default(8192).volatile(), slimOversized: z.boolean().default(true).volatile(),
  sampling: sampling().default({ temperature: null }).volatile(),
  chunking: withDefaults(chunkFields, DEFAULTS.chunking).default({}).volatile(),
  preprocessing: withDefaults(preFields, DEFAULTS.preprocessing).default({}).volatile(),
  summaryRoute: z.object({ provider: z.string().default(''), model: z.string().default('') }).default({}).volatile(),
  modelPolicies: z.array(z.object({ provider: z.string().required(), model: z.string().required(),
    effort: z.string(), maxTokensFloor: integer(0, 262144), slimOversized: z.boolean(),
    supplementOn: z.boolean(), supplement: z.string(), sampling: sampling(),
    chunking: z.object(chunkFields), preprocessing: z.object(preFields),
  })).default([]).volatile(),
  command: z.object({ enabled: z.boolean().default(true),
    newContext: z.object({ enabled: z.boolean().default(false) }).default({}) }).default({}).volatile(),
  autoCompaction: z.object({ enabled: z.boolean().default(true), thresholdRatio: ratio(0.1, 0.95).default(0.75),
    retainRatio: ratio(0, 0.8), retainTokens: integer(0, 1000000),
    summarizationProvider: z.string().default(''), summarizationModel: z.string().default(''),
    maxTokens: integer(128, 262144).default(8192), compactionRetries: integer(0, 8).default(1),
    maxOverflowRetries: integer(0, 8).default(1), headroomTokens: integer(0, 1000000).default(2048),
  }).default({}).volatile(),
});

export function validateRelations(cfg) {
  for (const route of [cfg.summaryRoute, { provider: cfg.autoCompaction?.summarizationProvider, model: cfg.autoCompaction?.summarizationModel }])
    if (Boolean(route?.provider) !== Boolean(route?.model)) throw new Error('摘要 provider/model 必须同时填写或同时留空。');
  const keys = new Set();
  for (const p of cfg.modelPolicies ?? []) {
    if (!p.provider?.trim() || !p.model?.trim()) throw new Error('模型覆盖必须填写 provider 和 model。');
    const key = JSON.stringify([p.provider, p.model]);
    if (keys.has(key)) throw new Error('同一个 provider/model 不能重复配置。');
    keys.add(key);
  }
}
