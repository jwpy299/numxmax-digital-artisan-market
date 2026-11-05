# Security Policy

请勿通过公开 Issue 提交密钥、用户数据、支付信息或生产漏洞细节。安全问题应通过项目指定的私密安全渠道报告，并包含可复现步骤、影响范围和建议修复方式。发布前必须完成 secrets、license 与供应链复核。

## 当前依赖风险披露

- `xlsx` 的上游 advisories 当前无直接修复版本；公开部署必须在隔离边界内处理不可信表格，不得直接暴露解析服务。
- `pptxgenjs` 与 `image-size` 的后续修复需要主版本升级与独立兼容验证，不以 force 方式升级。
- `@hono/node-server` 的后续修复需要 2.x 主版本兼容验证。
- GSAP Standard License 组件已从公开快照移除，动画由本地 CSS 实现。
- `webgl-constants` 已按上游 LICENSE 核实为 MIT；`jszip` 选择 MIT。
