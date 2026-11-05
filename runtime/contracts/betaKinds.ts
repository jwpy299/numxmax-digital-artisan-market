/**
 * betaKinds —— 内测报名身份枚举跨栈单源（OCR wb#77 二十七轮票：服务端 zod/闸谓词与前端选择器
 * 各自字面复刻=改名/新增静默脱勾面封死；@contracts=仓内跨栈契约层惯例[authLock/dialect 同例]）。
 * 消费面：sms.ts（zod 枚举）、smsVerify.ts（闸谓词型）、agentic.ts（verifyBetaCode 两调用面）、HeroSection（选择器派生）。
 *  betaInvites.ts 曾中转（二十九轮票已拆——路由只作路由，消费方全直引）。
 */
export const BETA_KINDS = ["personal", "enterprise"] as const;
export type BetaKind = (typeof BETA_KINDS)[number];
