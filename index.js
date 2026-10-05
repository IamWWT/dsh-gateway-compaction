/** dsh-gateway-compaction 2.0: native summaries; the host owns durable history. */
import { Config, validateRelations } from './config.js';
import { createCompactionMiddleware, readConfig } from './native-compaction.js';
import { registerTransactions } from './transactions.js';
export { Config } from './config.js';
export { MANUAL_COMPACT_COMMAND, MANUAL_NEW_CONTEXT_COMMAND, makeHardResetEngine } from './transactions.js';
export const name = 'gateway-compaction';
export const VERSION = '2.0.0';
export const inject = ['llm'];
export const COMPACT_EFFORT_SETTINGS_NAMESPACE = 'gateway-compaction';
const COMPACTION_BASIC_MODULE = '@deepseek-ai/dsh-compaction-basic';
function positiveInt(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** Coerce a config number to a finite non-negative integer, or `fallback`. */
function nonNegativeInt(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/**
 * Map the resolved `autoCompaction` section (feature 5) onto the engine
 * constructor arguments. Pure: settings object in, engine config out.
 * `auto` is ALWAYS false — the plugin drives the instance imperatively from
 * its own event listeners (see `registerAutoRescue`), never the engine's
 * built-in auto registration. `retainTokens` outranks `retainRatio` (the
 * engine rejects both at once). All invalid/missing scalars fall back to the
 * engine's own defaults so a partial settings.yaml section never breaks the
 * rescue.
 * @param raw - the `autoCompaction` section (or a partial one).
 * @returns `{ enabled: false }` or `{ enabled: true, engineConfig }`.
 */
export function autoCompactionEngineConfig(raw) {
  const source = raw !== null && typeof raw === "object" ? raw : {};
  if (source.enabled === false) return { enabled: false };
  const engineConfig = {
    auto: false,
    thresholdRatio: typeof source.thresholdRatio === "number" && Number.isFinite(source.thresholdRatio) && source.thresholdRatio > 0
    ? source.thresholdRatio
    : 0.8,
    summarizationProvider: typeof source.summarizationProvider === "string" ? source.summarizationProvider : "",
    summarizationModel: typeof source.summarizationModel === "string" ? source.summarizationModel : "",
    maxTokens: positiveInt(source.maxTokens, 8192),
    headroomTokens: nonNegativeInt(source.headroomTokens, 2048),
    compactionRetries: nonNegativeInt(source.compactionRetries, 1),
    maxOverflowRetries: nonNegativeInt(source.maxOverflowRetries, 1)
  };
  if (typeof source.retainTokens === "number" && Number.isFinite(source.retainTokens) && source.retainTokens >= 0) {
    engineConfig.retainTokens = Math.floor(source.retainTokens);
  } else if (typeof source.retainRatio === "number" && Number.isFinite(source.retainRatio) && source.retainRatio > 0) {
    engineConfig.retainRatio = source.retainRatio;
  }
  return { enabled: true, engineConfig };
}

export function decideBuiltInCompaction(appCompaction, presetId, inventory) {
  if (appCompaction !== undefined && appCompaction !== null) {
    const auto = appCompaction?.config?.auto;
    if (auto !== false) return "active";
  }
  if (inventory === undefined || inventory === null) return "absent";
  if (inventory.error) return "unknown";
  const id = typeof presetId === "string" && presetId.length > 0 ? presetId : inventory.defaultId;
  if (id === null || id === undefined || !inventory.byId.has(id)) return "unknown";
  return inventory.byId.get(id) ? "active" : "absent";
}

/**
 * Flatten a preset `compositionInventory()` list into per-preset flags: does
 * this preset's composition mount dsh-compaction-basic with effective
 * enablement (a `conditional` `!!js` row counts as enabled — the expression
 * is not evaluable from here, and deferring is the safe side)?
 * @param list - the `AgentPresetComposition[]` rows (id, rows, isDefault…).
 * @returns `{ byId, defaultId, error?: false }`.
 */
function indexCompositionInventory(list) {
  const byId = new Map();
  let defaultId = null;
  if (!Array.isArray(list)) return { byId, defaultId, error: true };
  for (const preset of list) {
    if (preset === null || typeof preset !== "object" || typeof preset.id !== "string") continue;
    if (byId.has(preset.id)) continue;
    const rows = Array.isArray(preset.rows) ? preset.rows : [];
    let has = false;
    for (const row of rows) {
      if (row && row.moduleName === COMPACTION_BASIC_MODULE && row.enabled !== false) {
        has = true;
        break;
      }
    }
    if (preset.broken !== undefined) has = false;
    byId.set(preset.id, has);
    if (defaultId === null && preset.isDefault === true) defaultId = preset.id;
  }
  return { byId, defaultId, error: false };
}

export function patchModelInfoWindows(model, info, windows) {
  if (info === null || typeof info !== "object") return info;
  const configured = typeof model === "string" && windows !== null && typeof windows === "object"
    ? windows[model]
    : undefined;
  if (typeof configured !== "number" || !Number.isFinite(configured) || configured <= 0) return info;
  const declared = info?.context?.contextWindow;
  if (typeof declared === "number" && Number.isFinite(declared) && declared <= configured) return info;
  const context = { ...(info.context ?? {}) };
  context.contextWindow = configured;
  return { ...info, context };
}

/**
 * Wrap an llm service so the engine's `resolveModelInfo` sees the operator's
 * declared context window for models in `windows` (see
 * patchModelInfoWindows). Every other member is passed through (functions
 * rebound to the service), so `llm.stream` — the summarization call this
 * plugin's wire layers inspect — is untouched.
 * @param llm - the llm service the engine resolves against.
 * @param windows - model id → declared context window map.
 */
export function apply(ctx, config = {}) {
  const current = () => {
    const raw = readConfig(config);
    const checked = Config['~standard'].validate(raw);
    if (checked.issues) throw new Error('Invalid gateway compaction config: ' + JSON.stringify(checked.issues));
    const cfg = readConfig(checked.value);
    validateRelations(cfg);
    return cfg;
  };
  current();
  ctx.on('llm/stream', createCompactionMiddleware(ctx, current));
  registerTransactions(ctx, current, autoCompactionEngineConfig, decideBuiltInCompaction, indexCompositionInventory);
}
