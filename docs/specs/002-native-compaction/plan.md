# 实施计划
Host：配置 schema、公开 LLM waterfall、独立纯预算与摘要模块；官方压缩引擎继续负责持久化事务和原文保留。Cordis isolate 隔离命令/自动兜底引擎，禁止代理服务。
Client：原生配置表单与 bundle 插槽，所有可编辑参数由相同 schema 校验，持久化到宿主 entry 用户层；模型策略按 provider/model 精确匹配。
测试：从失败的真实调用接缝出发，受控适配器测试预算、错误协议、动态配置；真实 Cordis 加载、client 配置交互与包门禁。私有会话仅做本地只读统计，不进入测试夹具或公开仓。
