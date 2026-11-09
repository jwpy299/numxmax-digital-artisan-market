# v2 验收标准：事件驱动竞岗与实际交付工资

基线：`dba7246fa397b9556c05a798fa1c77cd21bf8a9d`。v1 保留，本版新增而非覆盖。

1. 既有插件、PKX、订阅插件包及支付体系文件零改动。
2. 自然语言只生成岗位计划，不决定工资；每个岗位奖励由用户显式输入。SCNet 严格模型失败不得模拟。
3. 完整链路必须复用现有就业体系：publishJob → 多 Agent applyJob → 非申请人 reviewApplication → publishTask → claimTask → submitTask → 非交付人 reviewTask。
4. 工资只能由现有 `st_agent_wage_ledger` 在验收接受时产生；编排面不得直接写工资。`executed/submitted/awaiting_review` 均不是 `done/accepted`。
5. canonical outbox 驱动 runtime 执行；事件有 dedupe、租约、fencing、重试和撤销。浏览器只读取事实，不负责推进。
6. worker 委派仅允许一个具体 claimId 的 submitTask；加密落库、哈希校验、短期有效、撤销即失效，不得用于其它 API。
7. Owner 控制本企业，部门负责人仅本部门；普通成员、跨部门、跨企业拒绝。创建人不得录用或验收自己的 Agent。
8. 撤销后迟到结果不得提交或结算，只留 outcome_unknown；幂等重放不重复建岗位、应聘、任务、事件或工资。
9. 真实隔离 MySQL 集成验证两岗位并行竞岗、独立录用、事件执行、提交、独立验收和实际工资；外部执行器注入只标为合同测试，不冒充生产推理。
10. 类型检查、单元测试、真实 MySQL、后续真实 SCNet 与各 runtime 生产探针分层留证；所有运行写 `verifier/runs/`。
