/* Classic-script client bundle; generated field definitions come from ui-fields.js. */
window.__ModuleLoader__.load({ id: 'dsh-gateway-compaction', factory: require => {
  const React = require('react'), h = React.createElement;
  const { useState, useSyncExternalStore, useCallback } = React;
  /* FIELD_DEFINITIONS */
  const NS = 'gateway-compaction';
  const get = (o, path) => path.reduce((v, k) => v?.[k], o);
  const control = { width: '100%', boxSizing: 'border-box', padding: '8px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-default)', color: 'var(--dsw-alias-text-primary)', background: 'var(--dsw-alias-background-primary)' };
  const button = { ...control, width: 'auto', cursor: 'pointer' };
  const help = { fontSize: '12px', color: 'var(--dsw-alias-text-secondary)', lineHeight: 1.5, margin: '4px 0 0' };
  function parse(field, text) {
    const kind = field[2];
    if (kind === 'boolean') return text === 'true';
    if (kind === 'list') return text.split(/[,，\n]/).map(s => s.trim()).filter(Boolean);
    if (kind === 'jsonObject') {
      const v = JSON.parse(text || '{}');
      if (!v || typeof v !== 'object' || Array.isArray(v) || Object.values(v).some(n => !Number.isInteger(n) || n < 1024 || n > 10000000)) throw Error('窗口必须为 1024–10000000 的整数。');
      return v;
    }
    if (kind === 'number' || kind === 'optionalNumber') {
      if (kind === 'optionalNumber' && text.trim() === '') return null;
      const n = text.trim() === '' ? NaN : Number(text);
      const decimals = /Ratio|Factor|temperature/.test(field[0]);
      if (!Number.isFinite(n) || n < field[4] || n > field[5] || (!decimals && !Number.isInteger(n))) throw Error(`${field[1]}：请输入 ${field[4]}–${field[5]} ${decimals ? '之间的数值' : '之间的整数'}。`);
      return n;
    }
    return text;
  }
  function format(field, value) {
    if (field[2] === 'jsonObject') return JSON.stringify(value ?? {}, null, 2);
    if (field[2] === 'list') return (value ?? []).join(', ');
    return value === null || value === undefined ? '' : String(value);
  }
  function Card({ scope }) {
    const snapshot = useSyncExternalStore(useCallback(fn => scope.subscribe(fn), [scope]), useCallback(() => scope.getSnapshot(), [scope]));
    const [edits, setEdits] = useState({}), [revision, setRevision] = useState(null);
    const [saving, setSaving] = useState(false), [message, setMessage] = useState('');
    const stage = (key, value) => { if (revision === null) setRevision(snapshot.revision); setEdits(prev => ({ ...prev, [key]: value })); setMessage(''); };
    const fields = GROUPS.flatMap(g => g[1]);
    const read = f => Object.hasOwn(edits, f[0]) ? edits[f[0]] : format(f, get(snapshot.value, f[0].split('.')));
    async function save() {
      if (!snapshot.writable) { setMessage('配置暂不可写，请等待宿主连接恢复。'); return; }
      try {
        const ops = [];
        for (const [key, text] of Object.entries(edits)) {
          if (key === 'modelPolicies') {
            const policies = JSON.parse(text || '[]');
            if (!Array.isArray(policies)) throw Error('模型覆盖必须为 JSON 数组。');
            const seen = new Set();
            for (const p of policies) {
              if (!p.provider?.trim() || !p.model?.trim()) throw Error('每条模型覆盖必须填写 provider 和 model。');
              const id = JSON.stringify([p.provider, p.model]);
              if (seen.has(id)) throw Error('模型覆盖 provider/model 不能重复。');
              seen.add(id);
            }
            ops.push({ op: 'set', path: ['modelPolicies'], value: policies }); continue;
          }
          const f = fields.find(f => f[0] === key), value = parse(f, text);
          ops.push(value === null && key !== 'sampling.temperature' ? { op: 'unset', path: key.split('.') } : { op: 'set', path: key.split('.'), value });
        }
        for (const prefix of ['summaryRoute', 'autoCompaction']) {
          const keys = prefix === 'summaryRoute' ? ['provider', 'model'] : ['summarizationProvider', 'summarizationModel'];
          const values = keys.map(k => (edits[`${prefix}.${k}`] ?? get(snapshot.value, [prefix, k]) ?? '').trim());
          if (Boolean(values[0]) !== Boolean(values[1])) throw Error('摘要 provider/model 必须同时填写或同时留空。');
        }
        if (!ops.length) { setMessage('没有待保存的更改。'); return; }
        setSaving(true);
        let timer;
        try {
          const ok = await Promise.race([scope.mutate(ops, revision ?? snapshot.revision), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('保存等待超时；请重新打开配置页核实宿主是否已接受。')), 15000); })]);
          if (ok === false) throw Error('宿主未接受保存（参数校验或版本冲突）。保留了编辑内容，请重新加载配置后核对。');
          setEdits({}); setRevision(null); setMessage('已保存。新的压缩任务立即使用新配置。');
        } finally { clearTimeout(timer); }
      } catch (error) { setMessage(error.message); } finally { setSaving(false); }
    }
    function row(f) {
      const value = read(f), id = `gc-${f[0]}`;
      let error = ''; try { parse(f, value); } catch (e) { error = e.message; }
      const common = { id, disabled: saving, 'aria-invalid': Boolean(error), value, style: control, onChange: e => stage(f[0], e.target.value) };
      return h('div', { key: id, style: { marginBottom: '16px', minWidth: 0 } },
        h('label', { htmlFor: id, style: { display: 'block', fontWeight: 600, marginBottom: '5px' } }, f[1]),
        f[2] === 'boolean' ? h('input', { id, type: 'checkbox', checked: value === 'true', disabled: saving, onChange: e => stage(f[0], String(e.target.checked)) })
          : ['multiline', 'jsonObject'].includes(f[2]) ? h('textarea', { ...common, rows: 4 })
          : h('input', { ...common, type: ['number', 'optionalNumber'].includes(f[2]) ? 'number' : 'text', min: f[4], max: f[5], step: 'any' }),
        h('p', { style: help }, f[3]), error ? h('p', { role: 'alert', style: help }, error) : null);
    }
    return h('div', { style: { width: '100%', maxWidth: '960px', color: 'var(--dsw-alias-text-primary)' } },
      h('h2', null, '上下文压缩 · 2.0'),
      h('p', { style: help }, '通过宿主模型适配器处理压缩。输入、输出、保留尾部与安全余量统一预算。原始会话日志保持不变。'),
      !snapshot.writable ? h('p', { role: 'status' }, '正在等待可写配置；若持续不恢复，请检查插件 Host 是否启用。') : null,
      ...GROUPS.map(([title, fs], i) => h('details', { key: title, open: i === 0, style: { marginTop: '16px', padding: '12px', border: '1px solid var(--dsw-alias-border-default)', borderRadius: '8px' } },
        h('summary', { style: { cursor: 'pointer', fontWeight: 600, marginBottom: '12px' } }, title),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))', gap: '0 20px' } }, ...fs.map(row)))),
      h('details', { style: { margin: '16px 0' } }, h('summary', { style: { cursor: 'pointer', fontWeight: 600 } }, '按 provider / model 精确覆盖'),
        h('p', { style: help }, '仅覆盖填写的字段，其余继承全局值。可覆盖 effort、maxTokensFloor、sampling、chunking、preprocessing、slimOversized、supplementOn、supplement。使用宿主中的精确 provider/model ID。'),
        h('pre', { style: { ...help, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, '[{"provider":"my-provider","model":"my-model","effort":"low","chunking":{"maxOutputTokens":8192,"chunkMaxTokens":1024,"contextWindows":{"my-provider/my-model":32768}}}]'),
        h('textarea', { 'aria-label': '模型覆盖 JSON', rows: 12, style: { ...control, marginTop: '8px', fontFamily: 'monospace' }, disabled: saving,
          value: edits.modelPolicies ?? JSON.stringify(snapshot.value?.modelPolicies ?? [], null, 2), onChange: e => stage('modelPolicies', e.target.value) })),
      h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', margin: '18px 0' } },
        h('button', { type: 'button', style: button, disabled: saving, onClick: save }, saving ? '正在保存…' : '保存配置'),
        h('button', { type: 'button', style: button, disabled: saving, onClick: () => { setEdits({}); setRevision(null); setMessage('已放弃未保存的更改，并加载当前宿主值。'); } }, '放弃更改 / 重新加载')),
      message ? h('p', { role: 'status', style: { overflowWrap: 'anywhere' } }, message) : null);
  }
  return { inject: ['slots', 'configForms'], apply(ctx) {
    const scope = ctx.configForms.get(NS);
    ctx.effect(() => ctx.configForms.whileServed([NS], () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
      { name: 'plugins.bundle.config', key: 'dsh-gateway-compaction' },
      props => props?.view === 'page' ? h(Card, { scope }) : null))), 'gateway-compaction: configuration page');
  } };
} });
