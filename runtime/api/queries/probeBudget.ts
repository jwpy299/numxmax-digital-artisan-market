/**
 * 探测预算常量（池信号腿）—— **单一来源**。
 *
 * 为什么独立成模块（门禁 portal#45 的 :132 指出"两处各写一份会漂移"，而我第一版把常量挂在
 * `connection.ts` 上又引出了新问题）：
 *  - 只改一侧就会让 `poolAcquirePing` 的**入参兜底值**与 `healthProbe` 的**正常调用值**分叉 ——
 *    兜底值一旦超过探测预算，池信号就会被顶出 HTTP 预算，悄悄重开这道守卫本该关上的洞；
 *  - 而挂在 `connection.ts` 导出会让**仓内近百个 mock 了 `queries/connection` 的测试**里
 *    `vi.mock` 工厂全部失配（它们只声明自己用到的那几个导出）。
 *
 * 依赖方向：`connection.ts` 与 `queries/healthProbe.ts` 都 **import 本模块**；本模块**不 import 任何业务模块**
 * ⇒ 既无环，也不扩既有模块的导出面。
 */

/** 池信号预算的**名义值 1.5s**（并行腿，1.5s < 3s HTTP 预算）：既是 `poolAcquirePing` 入参缺失/NaN/非正数时的
 *  兜底，也是 `healthProbe` 的正常调用值。
 *  ⚠️ **不要直接引它**（门禁 wb#53 R7 的 :165-166）：夹取若只做在 `poolAcquirePing` 内部，那"单一来源"的
 *  **正常路径就没被夹** —— `healthProbe` 传的是未夹的值，`PROBE_CRITICAL_PATH_MS` 也由它派生
 *  ⇒ 一旦有人把这个名义值调到上界之上，"绝对上界"就只对兜底路径成立。**在源头夹**才没有第二条漏径。 */
const POOL_PING_TIMEOUT_NOMINAL_MS = 1_500;

/**
 * 池信号预算的**绝对上界 60s**：`poolAcquirePing` 收到"巨大但有穷"的 `timeoutMs`（如 `1e12`）时夹到这里。
 *
 * 为什么必须有这条（门禁 wb#53 R4 的 :158）：Node 的 `setTimeout` 对 > 2^31-1ms（≈24.8 天）的延迟会
 * **回绕成 1ms** ⇒ 立刻超时，与"`NaN` 导致永不超时"正好相反 —— 两种都是"越界入参静默改变语义"。
 *
 * 为什么是 60s（门禁 portal#45 R5 的 :157-159 指出 120s 是个没根据的魔法数，我同意并改口径）：
 *  - 探测语义上，池信号本就该在 HTTP 预算（3s）量级；60s 已是它的 **40 倍**，"绝不该出现在探测里的量级"；
 *  - 同时**远离溢出区**（2^31-1ms ≈ 24.8 天），夹取不会把"溢出成 1ms"的离谱行为留在边界附近；
 *  - 放在本模块（而非函数内联）才符合本 PR 建立的**单一来源**：预算与它的封顶是同一件事的两面。
 */
export const POOL_PING_TIMEOUT_MAX_MS = 60_000;

/**
 * 对外**唯一的**池信号预算（**已在源头夹到上界**）。
 *
 * `connection.poolAcquirePing`（入参兜底与夹取）、`healthProbe`（正常调用值）、`PROBE_CRITICAL_PATH_MS`
 * （临界路径派生）全都走这一个值 ⇒ "预算 ≤ 上界"由**构造**保证，不存在"只夹了某一条路"的漏径。
 * 这正是门禁 wb#53 R7 的 :165-166 指出的：夹取只做在 `poolAcquirePing` 内部时，"单一来源"的正常路径没被夹，
 * 派生量（临界路径）也绕过了上界。**要夹就夹在源头**。
 */
export const POOL_PING_TIMEOUT_MS = Math.min(POOL_PING_TIMEOUT_NOMINAL_MS, POOL_PING_TIMEOUT_MAX_MS);
