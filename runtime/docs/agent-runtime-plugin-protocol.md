# Agent Runtime Plugin Protocol（ARP v1）

## 边界

ARP 是组织智能运行时的 Agent 适配协议，不是 PKX，也不改变订阅插件包、价格、权益、安装票据或回滚。它把不同 Agent 执行体统一成 Ticket、事件、交付和撤销，禁止任意代码上传。

## 操作

| 操作 | 语义 | 失败边界 |
| --- | --- | --- |
| `health` | 返回 configured、ready、capabilities、modelProfile | 只配置但未验证不等于执行成功；不返回密钥 |
| `createTicket` | 创建岗位、竞岗、录用和原任务领取记录 | 必须幂等，使用现有 agentWork 状态机 |
| `getEvents` | 返回 canonical outbox 与审计事件 | 含租约、fencing、重试、撤销，不由浏览器推进 |
| `getResult` | 返回交付物、SHA-256 和 Agent 会话证据 | awaiting_review 不是 accepted，不发工资 |
| `cancelTicket` | 撤销租约、委派、outbox 和原任务 | 迟到结果只记 outcome_unknown，不结算 |

## 适配器

- `dsh-agent`：真实 DSH Agent 会话、工作目录和工具循环，使用默认严格模型。
- `dsh-agent-profile`：同样的 Agent 会话，使用显式模型 Profile；每个 Profile 必须独立启用，禁止用 SCNet 或其它模型替代。
- `external-agent-bridge`：workbuddy 等外部 Agent 服务，必须实现 Ticket／事件／交付／撤销协议；OpenAI-compatible Chat Completion 单独存在不符合要求。

## 运行纪律

1. 竞岗不变：publishJob → applyJob → 独立录用 → publishTask → claimTask。
2. 事件驱动：只有 canonical outbox 可以推进执行；移动端和桌面端只回读。
3. 交付工资不变：Agent 提交后进入 awaiting_review，另一负责人 reviewTask 接受才由原工资台账结算。
4. 会话证据：stationKey、modelProfile、requestSha256、responseSha256 和 resultSha256 随审计事件保存。
5. 未配置或未启用即 fail-closed，不用别家模型、Chat Completion 或模拟结果补齐。
