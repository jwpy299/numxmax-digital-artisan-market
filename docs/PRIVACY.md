# NumX Max 开源桌面端隐私说明

本说明适用于由本公开仓库构建的 NumX Max 组织运行时桌面端。平台账号与业务数据的完整规则见[平台隐私政策](https://www.lingshu-nebulaai.com/legal/privacy)。

## 网络行为

桌面端不会在未配置服务地址、未登录或用户未发起操作的情况下，把用户文档、任务内容或企业数据发送到未知系统。以下功能会在用户安装、登录、更新、下载或执行 Agent 任务时产生必要网络请求：

- 登录、企业身份绑定、任务编排、事件同步、独立验收与撤销：连接用户或部署方选择的 NumX Max／DSH／Agent 服务。
- 下载、升级与回滚：连接项目发布页或部署方配置的下载服务。
- DSH、Kimi、workbuddy：只通过各自 ARP Agent 适配器工作。workbuddy 未配置真实 Agent 服务时保持关闭；普通模型 Chat Completion 不替代 Agent 服务。其它未开放 runtime 不因旧环境变量而启用。
- GitHub Actions 与 SignPath：仅处理开源代码、workflow／commit 元数据和待签名制品，不接收终端用户业务数据或生产密钥。

相关第三方隐私政策：[GitHub](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement)、[SignPath](https://signpath.io/privacy-policy)。其它实际启用的 Agent 或模型服务，由部署方在启用前补充其服务地址、数据处理范围和隐私政策；未补充时不得宣称无数据出域。

## 本地与 canonical 数据

- canonical MySQL 是合同、任务、钱包、证据、幂等键、租约和流程的事实源；桌面端不是事实源。
- 桌面缓存不得被当作生产数据库备份。卸载不删除 canonical 服务端数据，也不代表用户数据删除请求已完成。
- 安装、升级、回滚和卸载不得删除用户主动保留的业务资料；清理测试数据不得删除 canonical 数据或生产验收证据。

## 联系

隐私与数据权利请求通过[平台隐私政策](https://www.lingshu-nebulaai.com/legal/privacy)公布的渠道提交。若该页面联系方式仍为占位符，发布审批必须保持阻断，不得伪造联系信息。
