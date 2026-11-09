# v4 验收标准：Agent Runtime Plugin Protocol（ARP）

1. 独立 `arp-v1` 协议提供 health/createTicket/getEvents/getResult/cancelTicket，不改 PKX 或订阅插件包。
2. 只有真正 Agent 会话、工具循环和事件交付算 runtime；OpenAI-compatible Chat Completion 单独存在不算 Agent。
3. DSH/Kimi/GLM/千问分别使用 DSH Agent 会话与明确模型 Profile、stationKey；workbuddy 必须接真实外部 Agent 服务。
4. 竞岗、独立录用、事件 outbox、单 claim 委派提交、独立验收与原工资台账保持 v2 语义。
5. 失败重试使用同角色委派原子轮换；旧 token 失效，未配置 runtime 不得替换供应商。
6. 单元测试、真实隔离 MySQL、真实隔离 DSH 会话、浏览器双身份与移动／桌面回归分层留证。旧 401/429/setup_failed 不得删除或改写为成功。
