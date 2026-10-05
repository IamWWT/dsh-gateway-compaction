// Shared by the client page and the schema coverage test.
// Group shape:  [title, badge, summary, fields]
// Field shape:  [path, label, kind, help, min?, max?, default?]
//   - label stays short and Chinese-first; the configuration key lives in help.
//   - help carries: what it does, the unit, the default, and the key name.
//   - default drives the "恢复默认" button.
export const GROUPS = [
  ['压缩行为', '常用', '决定哪些会话会被压缩、摘要调用用多少思考、摘要能写多长。', [
    ['enabled', '启用压缩优化', 'boolean', '总开关。只影响摘要压缩调用；普通对话与会话标题沿用宿主配置。默认开启。键：enabled'],
    ['matchAll', '适用于所有模型', 'boolean', '关闭后只处理下面列出的模型。默认开启。键：matchAll'],
    ['models', '指定模型列表', 'list', '逗号分隔的模型 ID；「适用于所有模型」关闭时生效。键：models'],
    ['effort', '摘要调用推理强度', 'text', '默认 off。只在当前模型声明支持该强度时使用；不支持则依次退到 none / minimal / low。键：effort'],
    ['compactionEffort', '强制摘要推理强度', 'text', '留空 = 按模型声明选择。填写（如 none）则每次摘要调用都原样发送该强度——适用于「默认就会思考、但适配器未声明强度」的模型，避免思考吃光输出预算导致摘要为空。键：compactionEffort'],
    ['maxTokensFloor', '单次摘要输出预算', 'number', '单位 tokens，默认 8192。同时受模型输出硬上限与可用窗口约束。键：maxTokensFloor', 0, 262144, 8192],
    ['sampling.temperature', '摘要采样温度', 'optionalNumber', '留空沿用提供者默认；推理模型建议留空。键：sampling.temperature', 0, 2, null],
    ['summaryRoute.provider', '独立摘要 provider', 'text', '与下面的 model 成对填写；都留空则用本次压缩调用的模型。键：summaryRoute.provider'],
    ['summaryRoute.model', '独立摘要 model', 'text', '可选一个更长上下文或更擅长摘要的模型；必须已在宿主中配置。键：summaryRoute.model'],
  ]],
  ['超长会话分片', '常用', '会话比模型一次能装下的更大时，切片提取再合并，避免「压缩不了」。', [
    ['chunking.enabled', '启用分片救援', 'boolean', '输入超出单次预算时自动切片（超大单条消息也会完整切分），再分层合并。默认开启。键：chunking.enabled'],
    ['chunking.chunkMaxTokens', '每片摘要输出上限', 'number', '单位 tokens，默认 4096。偏小有利于合并收敛；偏大会挤占输入预算。键：chunking.chunkMaxTokens', 128, 262144, 4096],
    ['chunking.mergeMaxTokens', '最终合并输出上限', 'number', '单位 tokens，默认 8192。应足以覆盖当前工作状态。键：chunking.mergeMaxTokens', 128, 262144, 8192],
    ['chunking.maxChunks', '最大片数', 'number', '默认 128。超过则明确失败，原始会话保持不变。键：chunking.maxChunks', 1, 4096, 128],
    ['chunking.keepRecentMessages', '保尾消息条数', 'number', '默认 10，0 = 关闭。最近 N 条原文直接进入最终合并（不保证最终摘要逐字保留）。键：chunking.keepRecentMessages', 0, 1000, 10],
    ['chunking.keepRecentTokens', '保尾原文 token 上限', 'number', '单位 tokens，默认 4096。同时受最终输入预算的 1/4 限制；超限消息照常分片提取，不丢弃。键：chunking.keepRecentTokens', 0, 1000000, 4096],
    ['chunking.maxMergeRounds', '最大合并轮数', 'number', '默认 8。每轮必须更短，不收敛就用已有分片摘要收尾。键：chunking.maxMergeRounds', 1, 32, 8],
  ]],
  ['网关卡顿 / 限流适配', '常用', '应对「网关对大请求或连续请求直接断开」这类限制——压缩失败最常见的环境原因。', [
    ['chunking.maxStreamInputTokens', '流式单次输入上限', 'number', '单位 tokens，默认 0 = 不限制（实测 170k tokens 的流式请求可正常返回）。仅在遇到「网关重置较大流式请求」的环境才需要填写；超过该值的分片会自动对半缩小重试。键：chunking.maxStreamInputTokens', 0, 10000000, 0],
    ['chunking.betweenCallsMs', '调用间隔', 'number', '单位毫秒，默认 1500。连续密集请求容易被网关限流（表现为连接重置而非报错码），此项用于拉开间隔。键：chunking.betweenCallsMs', 0, 60000, 1500],
    ['chunking.retries', '每阶段重试次数', 'number', '默认 2，只重试可恢复错误（网络中断、空摘要、输出截断、超窗）。键：chunking.retries', 0, 8, 2],
    ['chunking.retryDelayMs', '重试退避基数', 'number', '单位毫秒，默认 1000，指数退避。键：chunking.retryDelayMs', 0, 60000, 1000],
    ['chunking.timeoutMs', '单次调用超时', 'number', '单位毫秒，默认 120000。超时后停止等待并传递取消信号。键：chunking.timeoutMs', 100, 3600000, 120000],
    ['chunking.totalTimeoutMs', '整次压缩超时', 'number', '单位毫秒，默认 5400000（90 分钟）。含分片、重试与合并的总时长。键：chunking.totalTimeoutMs', 100, 14400000, 5400000],
    ['chunking.maxCalls', '最大模型调用次数', 'number', '默认 256，所有重试/分片/合并共享；这是防失控安全阀，超过即失败而非降级。键：chunking.maxCalls', 1, 8192, 256],
  ]],
  ['预算与窗口', '高级', '手工指定模型窗口与各项安全余量；通常无需改动。', [
    ['chunking.contextWindows', '模型窗口覆盖', 'jsonObject', '总窗口（输入+输出）。示例 {"provider/model": 131072}；provider/model 优先于 model；留 {} 则用宿主声明。键：chunking.contextWindows'],
    ['chunking.fallbackWindow', '未知模型保守窗口', 'number', '单位 tokens，默认 32768。仅当宿主未声明窗口且无手工覆盖时使用，同时写入诊断日志。键：chunking.fallbackWindow', 1024, 10000000, 32768],
    ['chunking.chunkRatio', '输入预算占窗口比例', 'number', '默认 0.65。实际预算还会扣除输出与安全余量并取较小值。键：chunking.chunkRatio', 0.1, 0.95, 0.65],
    ['chunking.headroomTokens', '固定安全余量', 'number', '单位 tokens，默认 2048。与比例余量取较大值。键：chunking.headroomTokens', 0, 1000000, 2048],
    ['chunking.safetyRatio', '比例安全余量', 'number', '默认 0.1，即窗口的 10%。键：chunking.safetyRatio', 0, 0.5, 0.1],
    ['chunking.tokenSafetyFactor', 'token 估算安全系数', 'number', '默认 1.2。中英文分别估算后乘此系数；频繁遇到真实超窗可提高。键：chunking.tokenSafetyFactor', 1, 4, 1.2],
    ['chunking.maxOutputTokens', '模型输出硬上限', 'number', '单位 tokens，默认 16384。请按实际模型配置，不是提供者默认值的预留。键：chunking.maxOutputTokens', 128, 262144, 16384],
  ]],
  ['摘要输入瘦身', '高级', '压缩前对临时摘要输入做无损/轻损清理，减少片数与耗时；原始会话日志不受影响。', [
    ['slimOversized', '启用摘要输入预处理', 'boolean', '默认开启。仅在临时摘要输入中处理思考与工具内容，磁盘事件不变。键：slimOversized'],
    ['preprocessing.dropReasoning', '省略历史思考块', 'boolean', '默认开启。保留对话、工具操作与结果；旧推理轨迹通常无需再总结。键：preprocessing.dropReasoning'],
    ['preprocessing.maxToolArgumentChars', '工具参数保留字符数', 'number', '默认 2000，0 = 不截断。首尾摘取并标记原文仍在会话日志。键：preprocessing.maxToolArgumentChars', 0, 1000000, 2000],
    ['preprocessing.maxToolResultChars', '工具结果保留字符数', 'number', '默认 12000，0 = 不截断。长篇重要工具输出可调大。键：preprocessing.maxToolResultChars', 0, 1000000, 12000],
    ['supplementOn', '追加补充摘要要求', 'boolean', '默认开启。在宿主传入的主压缩指令后追加下面的要求。键：supplementOn'],
    ['supplement', '补充摘要要求', 'multiline', '可指定语言、保留重点与输出风格。键：supplement'],
  ]],
  ['命令与自动兜底', '常用', '手动压缩命令，以及宿主没有内置压缩引擎时的自动兜底。', [
    ['command.enabled', '启用 /gateway-compact', 'boolean', '默认开启。使用宿主压缩事务，原始事件仍可回查。键：command.enabled'],
    ['command.newContext.enabled', '启用 /clear-context', 'boolean', '默认关闭。硬重置会直接清除模型可见历史且不生成摘要。键：command.newContext.enabled'],
    ['autoCompaction.enabled', '无内置引擎时自动兜底', 'boolean', '默认开启。已有内置压缩引擎的 preset 仍由该引擎触发，本插件只优化其摘要调用。键：autoCompaction.enabled'],
    ['autoCompaction.thresholdRatio', '自动触发比例', 'number', '默认 0.75，仅用于无内置引擎的兜底；有内置引擎时请在该引擎配置阈值。键：autoCompaction.thresholdRatio', 0.1, 0.95, 0.75],
    ['autoCompaction.retainTokens', '压缩后保留原文 tokens', 'optionalNumber', '留空则用下面的比例。宿主事务保留的尾部预算，与分片合并的临时尾部不同。键：autoCompaction.retainTokens', 0, 1000000, null],
    ['autoCompaction.retainRatio', '压缩后保留原文比例', 'optionalNumber', '留空使用宿主默认；仅当上面未填 tokens 时生效。键：autoCompaction.retainRatio', 0, 0.8, null],
    ['autoCompaction.headroomTokens', '自动触发安全余量', 'number', '单位 tokens，默认 2048。宿主压力预算额外保留的空间。键：autoCompaction.headroomTokens', 0, 1000000, 2048],
    ['autoCompaction.maxTokens', '事务摘要请求预算', 'number', '单位 tokens，默认 8192。传入官方事务的输出预算。键：autoCompaction.maxTokens', 128, 262144, 8192],
    ['autoCompaction.compactionRetries', '仍超阈值时追加压缩', 'number', '默认 1，0 = 不追加。防止一次摘要后上下文仍过大。键：autoCompaction.compactionRetries', 0, 8, 1],
    ['autoCompaction.maxOverflowRetries', '溢出恢复重试', 'number', '默认 1。仅在压缩确实改变会话表面后重试原请求。键：autoCompaction.maxOverflowRetries', 0, 8, 1],
    ['autoCompaction.summarizationProvider', '兜底摘要 provider', 'text', '与 model 成对填写；通常直接用上面的统一摘要路由即可。键：autoCompaction.summarizationProvider'],
    ['autoCompaction.summarizationModel', '兜底摘要 model', 'text', '留空继承会话模型；统一摘要路由优先。键：autoCompaction.summarizationModel'],
  ]],
];
