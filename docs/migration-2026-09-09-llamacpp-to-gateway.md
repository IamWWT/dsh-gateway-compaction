# 迁移史：llama.cpp 专用压缩插件 → 网关通用版（2026-09-09）

> 本文档归档自工作区一次性迁移工具目录 `compaction-fix-apply/`（README + apply.sh +
> transform.py + 迁移前备份快照，2026-09-12 已从工作区根目录删除）。该目录不是插件，
> 也从未是任何服务的运行时依赖；本文件是其全部长期价值的沉淀。

## 背景（根因）

aiops 会话（`.dsh-dev` / 3082）切到 NInfer 的 `qwen3.8-27b` 后，上下文压力
368855/369144（99.9%），自动压缩一直触发（日志里 56 次 compaction/start），
但每一次都死在同一个 400：

```
chat_template_option_not_supported:
"chat_template_kwargs.enable_thinking is not supported"
```

根因：旧插件 `dsh-qwen38-llamacpp-compaction-fix` 是 **llama.cpp 专用**，它给压缩
请求体注入 `chat_template_kwargs.enable_thinking`（llama.cpp 认，NInfer 不认）。
settings.yaml 里把它的 `models` 覆盖成了 `qwen3.8-27b`（NInfer 的模型 id），
于是原生自动压缩和插件压缩**共用同一条被污染的电话线路**，全部 400。

## 本次迁移做了什么

- **插件改名 + 改造**：`dsh-qwen38-llamacpp-compaction-fix` → 本插件
  `dsh-qwen38-gateway-compaction`（源码在本目录）。新增 `ninModels` 配置——
  NInfer 模型自动跳过 `chat_template_kwargs`，只走 `reasoning_effort`；
  分片救援 / 采样 / max_tokens 下限对 llama.cpp 与 NInfer 两种引擎通用。
- **settings.yaml 一次性修复**（transform.py 执行）：
  1. 删除旧插件 `qwen38-llamacpp-compaction-fix:` 孤儿配置段；
  2. 为 `qwen-ninfer/qwen3.8-27b` 声明 `reasoningEfforts`
     （`off: none` / `xhigh: xhigh`），让瀑布层能在压缩/标题调用上关掉思考；
  3. 新插件配置段不手写——`dsh plugin add` 后由本插件 `cordis.patch.yml`
     基础层提供 `models/ninModels/contextWindows` 全部默认值。
- **插件替换**：`dsh plugin --profile web remove` 旧插件 →
  `dsh plugin --profile web add` 本插件（源码 link 安装）。
- **pnpm 放行**：profile 的 `pnpm-workspace.yaml` 补 `minimumReleaseAge: 0`，
  绕过 supply-chain 冷却期对 `dsh plugin` 内部 `pnpm install` 的拦截（仅本 profile）。

## 验证方式（当时已确认通过）

- dsh 日志出现 `qwen38-gateway-compaction: rewriting compaction request bodies ...`；
- 会话日志 `compaction/end` 不再出现 `chat_template_option_not_supported` 400；
- profile 的 `package.json` 依赖与 `dsh.profile.bundles` 只含新插件名。

## 后续注意

- 2026-09-09 迁移后工作区 profile 的 `node_modules` 里残留过两个悬空软链
  （`dsh-qwen38-gateway-compaction-fix`、`dsh-qwen38-llamacpp-compaction-fix`，
  指向已不存在的目录）。2026-09-12 已清除；若再出现同名牌软链，确认其不在
  `dsh.profile.bundles` 与 `package.json` 依赖里后可直接删除。
- GitHub 仓库改名：`dsh-qwen38-llamacpp-compaction-fix` →
  `dsh-qwen38-gateway-compaction`（GitHub 自动 301 旧地址）。