# dsh-gateway-compaction — 进度档案

> 本插件进度真源。开发/维护本插件的 agent 在每次需求/事故后更新本文件；
> 工作区根 `progress.md` 只放指向本文件的索引链接，不写细节。

## 一句话定位

Qwen3.8 本地网关（llama.cpp / NInfer）上的会话压缩修复插件：源码 link 安装于 3082 dev web
（`~/.dsh-dev`），对「压缩摘要 / 会话标题」两类辅助调用做五层 fetch 拦截，
并处理超大对话的分片 map-reduce 压缩救援 + 无内置引擎 preset 的自动溢出救援（Feature 6）。
仓库：`dsh-plugins/dsh-gateway-compaction/`。

## 当前状态（2026-09-19 更新）

- 版本 1.3.0（源码 link 安装，版本号仅簿记）。
- 全部测试绿：smoke(58) / window-resolution(10) / rescue-e2e(29) /
  integration-fetch(11) / preset-applicability(10) / client-smoke /
  prompt-sync(3) / auto-rescue(36)。
- 3082 已装（profile 已切到新名 `dsh-gateway-compaction`）；host 端改动需 `systemctl --user restart dsh-dev-web` 生效（重启由用户执行）。

## 进行中 / 最近批次

### 改名 dsh-gateway-compaction（2026-09-19，已上线待重启）

- 仓库 / 包名 / 插件 id / 设置段 / GitHub 仓 / 本地目录：`dsh-qwen38-gateway-compaction` → `dsh-gateway-compaction`（1.3.0）。
- 手动命令 `/qwen38-compact` → **`/gateway-compact`**（harness 已有内置 `/compact`，不可复用）；`/clear-context` 不变。
- **settings.yaml 段名 `qwen38-gateway-compaction:` → `gateway-compaction:`（段内容不变）需用户手工改名**，否则新插件按默认值运行。
- 3082 profile 已 rm 旧 + add 新（`~/.dsh-dev/profiles/web` 已指向新路径）。
- 适用模型说明进 README 中英「适用模型」章节 + 设置页卡片描述。
- 升级三步：rm 旧 → add 新（已完成）→ 用户改 settings.yaml 段名 + restart。

### 自动压缩救援（阶段二，已实现，待重启 + 验收）

- `autoCompaction` 配置段（默认开启）：无内置压缩引擎的 preset（如 minimal）两级兜底——
  ① 压力预警：每轮前按 `thresholdRatio(0.8) × 实际窗口` 提前压缩；
  ② 溢出恢复：网关报 `context_length_exceeded`(400) 时压缩并重试（`maxOverflowRetries`，
    默认 1，每会话独立预算，idle / 新 assistant 消息后重置）。
- 归属判定（绝不双压）：app 级 `compaction` 服务启用 → 跳过；否则查 preset
  `compositionInventory()` 是否挂 `@deepseek-ai/dsh-compaction-basic`（30s TTL 缓存）；
  检测不确定 → 按「有引擎」处理。**standard 等自带引擎的 preset 行为零变化**（验收标准）。
- 救援引擎：`BasicCompactionEngine`（`auto:false`）+ detached ctx（永不注册 `compaction`
  服务）；`llm` 经 Proxy 矫正 `resolveModelInfo` 窗口（declared < 配置值保留 declared，
  防硬件超窗）；rescue 摘要走本插件 wire 层，自身溢出走分片救援。全链路 fail-open。
- 设置页：「自动压缩救援」开关 + 高级参数（thresholdRatio / maxOverflowRetries，
  关开关时置灰）；中英文 locale 同步。
- 测试：新增 `test/auto-rescue.mjs`（36 断言：decideBuiltInCompaction 全分支 /
  patchModelInfoWindows 纯函数语义 / autoCompactionEngineConfig 映射回退）。
- 文档：README 中/英（能力表 + 功能 6 + 配置示例）、CHANGELOG、本文件已同步。
- 待用户验证（重启后）：
  - `systemctl --user restart dsh-dev-web`，刷新 3082，设置页见「自动压缩救援」开关（默认开）。
  - standard preset 会话行为不变（无新增日志/无额外压缩）。
  - minimal（或任一未挂 compaction-basic 的 preset）构造 400 溢出 →
    `journalctl --user -u dsh-dev-web` 应见 "overflow recovery (rescue)" /
    "pressure compaction (rescue)" / "automatic overflow rescue" 关键词，且会话恢复。

### 压缩提示词优化（已随 1.2.0 发布）

- 已实现：
  - `supplementOn`（默认 true）：主指令后追加 6 条补充规则（近期加权/逐字保真/进行中任务/
    冲突取最新/会话主语言/不虚构），单次压缩与分片救援全链路生效；幂等
    （`SUPPLEMENT_MARKER` 首行标记）。官方主指令只追加不替换。
  - 分片合并前言重写为显式合并规则（后片优先/去重/并集/Current Work 取最后一片/不丢段落）。
  - 设置页「压缩提示词」展示区三段化（主指令 + 补充规则(可关) + 合并前言），
    `supplementOn` 开关进基础设置组；中英文 locale 同步。
  - 新增 `test/prompt-sync.mjs` 守卫 client 展示文本与 host 下发文本逐字一致。
  - README(中/英) + CHANGELOG 已同步。
- 待用户验证：
  - `systemctl --user restart dsh-dev-web` 后刷新 3082，设置页应见三段提示词 +
    「启用补充规则」开关（默认开）。
  - 真实大会话跑 `/gateway-compact` 验证分片压缩质量。

### 遗留（未开工 / 已知限制）

- ~~阶段二：请求 400 溢出时被动触发压缩重试~~ → 已完成（上文「自动压缩救援」批次）。
- 可选优化（未拍板）：尾部原文保护 / chunkMaxTokens 调大 / 边界感知切片 / 滚动接力。
- 设置页三区折叠 UI 方案（未确认）。
- `/clear-context` 改名后 3082 是否已重启，用户端未确认。

### 已知限制（非阻塞，记录在案）

1. **旧会话的补充规则标记**：改名（`qwen38-` → `gateway-`）前生成的摘要/检查点里带旧
   `SUPPLEMENT_MARKER` 文本；新代码识别的是新标记，最坏情况是补充规则在提示词里
   重复出现一次——纯文本重复，无功能影响，新会话不受影响。
2. **settings.yaml 段名需手工改名**：`qwen38-gateway-compaction:` → `gateway-compaction:`
   （段内容不动）。不改的后果 = 新插件按全默认值运行（功能仍在，但个性化配置失效）。
3. **`minimalContext:` 配置块是设计占位**：代码不消费；README 配置示例中已注明，
   实际键为 `autoCompaction.*` + `chunking.contextWindows`。
4. **98% 没有独立触发器**：原设计的 98% 自动摘要压缩未实现为独立阈值，由
   「400 溢出 → 压缩 → 重试」路径覆盖（数值区间等价，见 docs/minimal-context-budget.md）。

## 关键约定（勿忘）

- host 代码改动必须重启 3082（`systemctl --user restart dsh-dev-web`）才生效；
  client.js 改动刷新页面即可，但稳妥起见一并重启。
- 网关 127.0.0.1:8881（qwen3.8-27b）；`contextWindows.qwen3.8-27b = 167236`
  （= 378144 − 192000 − 18908，见 docs/minimal-context-budget.md）。
- 窗口解析链：显式 `contextWindows` > 网关活查 `/v1/models`（5min TTL）> settings.yaml 声明；
  全无则一次性 warn + fail open。
- 压缩主指令真源在 harness `dsh-compaction-basic`（本插件只复用 + 追加，不替换）；
  `COMPACTION_SIGNATURE` 首行校验防 harness 升级后静默失配。

## 历史里程碑

- 1.2.0：自动压缩救援（功能 6：压力预警 + 400 溢出压缩重试，无内置引擎 preset 兜底，
  绝不双压）+ 压缩提示词优化批次（补充规则/合并前言/设置页三段展示）。
- 2026-09-09：由 `dsh-qwen38-llamacpp-compaction-fix` 迁移改名（docs/migration-*.md）。
- 1.1.1：`/qwen38-new-context` → `/clear-context` 改名；双 slot 注册
  （`settings.plugin.item` + `plugins.bundle.config`）；contextWindows 修正 167236；
  窗口自动解析（活查/声明兜底）。
- 1.1.0：去 `-fix` 尾缀改名。
- 1.0.x：五层拦截 + 分片救援 + 手动命令。