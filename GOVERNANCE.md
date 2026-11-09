# Governance

- Owner 单签管理生产发布与公共仓库首发；每次签批必须绑定最终 commit SHA 和制品 SHA-256，旧 SHA 签批不得部署新制品。
- DSH 负责独立 secrets、license、供应链和发布证据复核；复核不替代 Owner 签批，执行也不替代独立验收。
- 公共贡献不得包含真实用户数据、生产凭据、未授权代码插件或任意执行能力。
- `executed != done`，`awaiting_review != delivered`；工资/结算只按独立验收交付计算。
