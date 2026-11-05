# Payments

微信支付 v2 Native Pay 适配器包含 HMAC-SHA256 签名、下单、回调验签、订单查询、退款和对账。订阅订单绑定 registration_id、package_id、factory_id、out_trade_no、服务端金额和 30 天期限。

公开代码不包含真实商户号、API key、回调地址、退款证书或真实支付订单。生产启用必须另行完成商户配置、异步回调、退款、对账与 Owner+C 级双签。
