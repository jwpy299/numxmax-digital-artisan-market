# NumX Max · Digital Artisan Market

组织智能运行时、桌面端与 PKX 订阅插件的开源快照。

## 范围
- `runtime/`：OAP v0、lease/outbox/checkpoint/evidence/revoke/version、前端与后端。
- `desktop/`：桌面端应用及安装、升级、回滚代码。
- `plugins/`：PKX manifest、Ed25519 验签、最小权限适配、示例插件与测试。
- `docs/`：架构、协议、安全和发布边界。

## 构建与验证
```bash
cd runtime
npm ci
npm run check
npm run build
npm test
```

公开环境的 skip 清单与 root-only 特权复跑见 [`docs/INTERNAL-GATES.md`](docs/INTERNAL-GATES.md)。

## 下载与发布

- 桌面端下载页：[NumX Max 下载注册中心](https://www.lingshu-nebulaai.com/getdesktop)；公开构建制品见 [Releases](https://github.com/jwpy299/numxmax-digital-artisan-market/releases)。
- **Code signing policy**：见 [`docs/CODE-SIGNING.md`](docs/CODE-SIGNING.md)。签名目标为“Free code signing provided by SignPath.io, certificate by SignPath Foundation”；申请批准和签名验证完成前，现有 EXE 均为未签名预验包。
- 隐私说明：[`docs/PRIVACY.md`](docs/PRIVACY.md)。

## 明确边界
- 本快照不包含生产密钥、商户配置、用户数据、内部地址或生产部署状态。
- 支付只提供适配器接口与测试夹具；真实商户配置、回调密钥和退款证书必须留在私有部署。
- SCNet 模型与算力需要部署方自行授权和配置，公共代码不附带额度、账号或真实训练结果。
- `executed != done`，`awaiting_review != delivered`；工资只按独立验收交付结算。
- 插件只支持 manifest 白名单权限，不支持任意上传或执行代码。

许可证：Apache-2.0（代码）；CC-BY-4.0（文档）。商标与生产数据不随源码授权。
