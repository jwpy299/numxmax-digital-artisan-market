/** 测试钩（OCR 仓规 R71-6 同例：钩不进 dist 出货——本模块仅被 guards.test.ts / identity.test.ts 两测试引用，esbuild 树摇后产线包物理不含；
 *  引用面由 identitySurface.test.ts 哨兵看守；R7-c15-②：开窗器本体叠加 NODE_ENV=test 环境闸——本钩即使误入产线包也开不了窗） */
import { asResolvedAdminIdentity, withMintArmed } from "./identity"; // R7-17-④：同模块单条 import；R7-b7-①：roleOfEvidence 退役（委派语义内联回 lockRoleOfWbUser）；R7-c10-②：开窗器同钩出（导出 mint 未开窗恒 null）

export const __asResolvedAdminIdentityForTest = asResolvedAdminIdentity;
export const __withMintArmedForTest = withMintArmed; // R7-c10-②：测试侧唯一开窗窄口（哨兵看守）
