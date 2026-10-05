/** Official durable transactions, each owned by a disposable Cordis fiber. */
export const MANUAL_COMPACT_COMMAND = 'gateway-compact';
export const MANUAL_NEW_CONTEXT_COMMAND = 'clear-context';
export function makeHardResetEngine(Engine) {
  return class HardResetEngine extends Engine {
    async summarize() {
      return { summary: [{ type: 'text', text: 'A new context window was explicitly requested. Earlier conversation is available in the original session log. Inspect current files and task state before continuing.' }], provider: 'template', model: 'hard-reset' };
    }
  };
}

export async function withEngine(ctx, config, hardReset, work) {
  const { BasicCompactionEngine } = await import('@deepseek-ai/dsh-compaction-basic');
  const Engine = hardReset ? makeHardResetEngine(BasicCompactionEngine) : BasicCompactionEngine;
  const realm = ctx.isolate('compaction');
  const fiber = realm.plugin(Engine, { ...config, auto: false });
  try {
    await fiber;
    const engine = realm.get('compaction');
    if (!engine) throw new Error('官方压缩引擎未能加载；请检查宿主服务依赖。');
    return await work(engine);
  } finally { await fiber.dispose(); }
}

export function registerTransactions(ctx, read, enginePolicy, decideBuiltIn, indexInventory) {
  ctx.inject(['commands', 'tokenMeter', 'sessions'], sctx => {
    for (const hardReset of [false, true]) {
      sctx.effect(() => sctx.commands.register({
        name: hardReset ? MANUAL_NEW_CONTEXT_COMMAND : MANUAL_COMPACT_COMMAND,
        description: hardReset ? '清除模型可见历史，原始事件仍在磁盘（须在插件配置中启用）' : '将历史压缩为可恢复工作的摘要，超长输入自动分片',
        async handler(invocation) {
          const cfg = read();
          if (!cfg.enabled || (hardReset ? !cfg.command.newContext.enabled : !cfg.command.enabled))
            return { kind: 'error', text: '此命令已关闭；请到左上角「插件 → dsh-gateway-compaction → 配置」启用。' };
          try {
            // Manual transactions share the configured retention and summary policy.
            const engineConfig = enginePolicy({ ...cfg.autoCompaction, enabled: true }).engineConfig;
            const result = await withEngine(sctx, engineConfig, hardReset, engine => engine.compactNow(invocation.agent, invocation.signal, invocation.commandId));
            return result ? { kind: 'success', text: `已${hardReset ? '硬重置' : '压缩'} ${result.shadowedSeqs.length} 条历史；原始会话日志仍保留。`, sourceEventSeq: result.summarySeq }
              : { kind: 'success', text: '当前没有可压缩的历史。' };
          } catch (error) {
            return { kind: 'error', text: `压缩未完成：${error.message}。请查看插件诊断日志；未完成的摘要不会替换历史。` };
          }
        },
      }), `gateway-compaction: ${hardReset ? 'clear-context' : 'gateway-compact'}`);
    }
  });
  ctx.inject(['tokenMeter', 'sessions'], sctx => {
    const attempts = new WeakMap(), inFlight = new WeakSet();
    async function ownsRecovery(agent) {
      try {
        const presets = ctx.get('agentPresets');
        const inventory = presets ? indexInventory(await presets.compositionInventory()) : null;
        const id = ctx.get('sessionProjections')?.stateOf(agent.session, 'agentPreset');
        return decideBuiltIn(ctx.get('compaction'), id, inventory) === 'absent';
      } catch { return false; }
    }
    async function recover(agent, trigger, signal) {
      const cfg = read();
      if (!cfg.enabled || !cfg.autoCompaction.enabled || signal?.aborted || !agent || inFlight.has(agent) || !await ownsRecovery(agent)) return false;
      const policy = enginePolicy(cfg.autoCompaction).engineConfig;
      const count = attempts.get(agent) ?? 0;
      if (trigger === 'context-overflow' && count >= policy.maxOverflowRetries) return false;
      if (trigger === 'context-overflow') attempts.set(agent, count + 1);
      inFlight.add(agent);
      const before = agent.session.surface?.replaceGeneration;
      try {
        await withEngine(sctx, policy, false, engine => engine.compactIfNeeded(agent, trigger, signal));
      } catch (error) {
        sctx.logger.warn(`gateway-compaction: automatic ${trigger} failed: ${error.message}`);
      } finally { inFlight.delete(agent); }
      return !signal?.aborted && typeof before === 'number' && agent.session.surface?.replaceGeneration > before;
    }
    sctx.on('agent/pre-step', async ({ agent, signal }, next) => { await recover(agent, 'pressure', signal); return next(); });
    sctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
      if (failure?.code === 'CONTEXT_WINDOW_EXCEEDED' && await recover(agent, 'context-overflow', signal)) return { kind: 'retry' };
      return next();
    });
    sctx.on('agent/status', ({ agent, status }) => { if (status === 'idle') attempts.delete(agent); });
  });
}
