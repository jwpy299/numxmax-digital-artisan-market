# Code signing policy

## 当前状态

- Windows 组织运行时安装包的签名服务目标：**Free code signing provided by SignPath.io, certificate by SignPath Foundation**。
- 截至本文件提交时，SignPath Foundation OSS 申请仍处于准备／申请阶段；在申请批准、签名请求完成并通过 Windows 验证前，现有 EXE 均按**未签名预验包**处理，不得称为可信发布者版本。
- 只有由公开仓库最终 commit SHA 对应的 GitHub Actions 构建、经 Owner 审批并完成 SignPath 签名的制品才可发布。旧 SHA 的签批不能用于新 SHA。

## 角色与责任

- Authors / Committers：[`@jwpy299`](https://github.com/jwpy299)，负责源代码和构建脚本维护。
- Reviewers：[`CODEOWNERS`](../CODEOWNERS) 与 DSH 独立复核流程，负责 secrets、许可证、供应链和发布证据复核；外部贡献必须经维护者评审。
- Approvers：[`@jwpy299`](https://github.com/jwpy299)（Owner 单签）。每次签名请求必须人工审批，并绑定最终 commit SHA、workflow run、未签名制品 SHA-256 和签名后制品 SHA-256。

## 发布门禁

1. GitHub-hosted runner 从公开源构建，禁止上传本地 EXE 直接签名。
2. 构建、测试、secrets／许可证扫描通过后，才把 GitHub Actions artifact 提交 SignPath。
3. Windows EXE 必须具有有效 Authenticode 签名和 RFC3161 时间戳；签名证书链在干净 Windows VM 中验证通过。
4. 安装、启动、卸载、升级、回滚证据全部绑定同一最终 commit SHA 和制品 SHA-256。仅文件改名、仅自签名、仅 OAuth／申请页面均不算完成。
5. 发布页保存签名请求 ID、workflow run、验证日志和已知限制；签名审批与生产上线审批是两个独立步骤。

## 隐私

见 [`docs/PRIVACY.md`](PRIVACY.md) 及[平台隐私政策](https://www.lingshu-nebulaai.com/legal/privacy)。构建与签名阶段向 GitHub 和 SignPath 提供源代码、构建元数据及待签名制品；不得把最终用户业务数据、生产密钥或 canonical 数据放入签名制品。
