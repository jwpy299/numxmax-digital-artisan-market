/**
 * portal —— 门户站域跨栈单源（OCR wb#77 二十九轮票：www 缺省域在 betaDlConfig/workbench/admin 三处字面复刻
 * +grep 式 lockstep 钉太脆——@contracts 跨栈契约层惯例[authLock/dialect/betaKinds 同例]，真单源收口）。
 * 消费面：api/routers/betaDlConfig.ts（短信下载链缺省）、src/config/workbench.ts（前端门户基址缺省）。
 * 注意：api/routers/admin.ts 的 PORTAL_URL 语义是「门户应用源」可带端口（:3100 先例）——**不是**本静态下载域，
 * 不并入本钉（wb#77 九轮票：混引=门户域迁移时短信链指到非 /dl 宿主=死链回马枪）。
 */
export const PKG_DL_ENT = "/dl/numx-enterprise-setup.exe"; // 企业版安装包稳定名直链单源（GetDesktop/HeroSection/betaDlConfig 三面同引[OCR portal#69 maint 票：env 覆盖发散 404 面封死——env 面=后端短信链面，前端固定稳定名是对的面]）
export const PKG_DL_PER = "/dl/numx-personal-setup.exe"; // 个人版（DSH）安装包稳定名直链单源
export const PKG_DL_ORG = "/dl/numx-org-runtime-setup.exe"; // 组织智能体运行时安装包稳定名直链单源（彭总 2026-10-22 令——桌面端四卡面）

export const PORTAL_WEB_URL_DEFAULT = "https://downloads.example.invalid";
