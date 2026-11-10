# Open-source and release compliance

本文件用于 SignPath Foundation 及其它 OSS 审核，记录当前真实合规状态和未决事项，不把准备项写成批准项。

## 项目与许可

- 项目：NumX Max · Digital Artisan Market
- 代码许可证：Apache-2.0；文档：CC-BY-4.0。
- `runtime/package.json` 与 `runtime/package-lock.json` 已不再包含 `gsap` 或 `@gsap/react`；动画由本地 CSS、IntersectionObserver 和 scroll listener 实现，不再打包 GSAP Standard License 组件。
- 当前 CycloneDX SBOM：[`SBOM.json`](../SBOM.json)，共 **873 个组件**。
- 第三方声明：[`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)。
- 组织安装包额外排除 `frontend/assets`，只保留本地组织入口及运行依赖，避免把未使用的门户 bundle 和第三方专有组件带入 Windows 安装包。

## 审核对应项

| 项目 | 当前证据与边界 |
| --- | --- |
| Malware / 禁止任意执行 | 插件只支持 manifest 白名单权限，禁止任意代码上传执行；DSH／Kimi／workbuddy 使用真实 Agent 会话、工作目录和工具循环。 |
| OSI 许可 | Apache-2.0 代码、CC-BY-4.0 文档；GSAP 已从源码和 lockfile 移除，SBOM 可复核。 |
| 维护与发布 | 公开 main 持续更新，CI 通过；发布包附未签名预验状态，未把 debug 或自签名制品称为生产正式签名。 |
| 代码签名政策 | [`CODE-SIGNING.md`](CODE-SIGNING.md)，含 SignPath 文案、Owner 单签、最终 SHA 与制品 SHA-256 绑定、人工审批要求。 |
| 隐私 | [`PRIVACY.md`](PRIVACY.md) 与[平台隐私政策](https://www.lingshu-nebulaai.com/legal/privacy)，说明网络行为、canonical MySQL、第三方服务和未配置即 fail-closed 的边界。 |
| 安装与卸载 | Windows NSIS 提供安装与卸载；未签名预验已在 fresh GitHub-hosted Windows VM 完成安装／启动／升级／回滚／卸载。 |
| 构建来源 | GitHub-hosted runners 从公开 main 最终 commit SHA 构建，记录 workflow run、未签名制品 SHA-256 和签名后制品 SHA-256。 |
| 审批 | Owner 单签；每次签名请求都需人工批准，旧 SHA 的签批不得用于新 SHA。 |
| 插件与工资 | 不改 PKX 和订阅插件包；canonical MySQL、竞岗、事件驱动、独立验收和原工资链保持不变。 |

## 未决事项

- SignPath OSS 申请已受理，**尚未批准**；SignPath Foundation 证书仍为 `CSR PENDING`。
- 当前订阅返回 `TrustedBuildSystems feature is disabled`，必须等待功能启用后才能开启 GitHub 源验证。
- 公开仓当前没有独立媒体覆盖、公开下载统计或大规模 star/fork 社区，审核声誉材料以真实 CI、Release 和生产下载页为准，不夸大社区热度。
- 未签名预验不等于可信签名；正式签名后必须重新执行 Authenticode、RFC3161、可信发布者及 Windows VM 全生命周期验证。
