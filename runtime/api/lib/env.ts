import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value && process.env.NODE_ENV === "production") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value ?? "";
}

export const env = {
  appId: required("APP_ID"),
  appSecret: required("APP_SECRET"),
  isProduction: process.env.NODE_ENV === "production",
  // 门禁 PR#9-r14-④/r15-①：显式非生产判定单点——环境集（development/test）演进只改本点（identity.flagOptInEffective/totp 加密回落同引；
  //  staging/未设/拼错一律不算非生产=安全降级面的环境闸全走本钉）；isDevelopment/isTest 散件摘除（零消费实证——注记曾谎报消费端）
  isExplicitNonProd: process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test",
  databaseUrl: required("DATABASE_URL"),
  kimiAuthUrl: required("KIMI_AUTH_URL"),
  kimiOpenUrl: required("KIMI_OPEN_URL"),
  ownerUnionId: process.env.OWNER_UNION_ID ?? "",
  // 门禁 PR#9-r35-⑤：2FA 加密钥+issuer 归 env 单点（process.env 直读收口——totp.ts/adminAuth.ts 同引本件；
  //  静态快照=import 期定值——测试要换钥走 vi.resetModules+动态 import（adminAuth.test.ts 同款纪律在册）
  totpSecretEncKey: process.env.TOTP_SECRET_ENC_KEY ?? "",
  totpIssuer: process.env.TOTP_ISSUER ?? "",
};
