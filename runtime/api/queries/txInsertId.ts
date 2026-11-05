/**
 * txInsertId —— 写+读同id同事务单点（R7-c143-②/R7-c144-③/R7-c145-①）：gate.ts 出票/彩排/意图/修正案四处
 *  + devices.ts 入队/注册两站同引——连接域竞态（LAST_INSERT_ID 池化落他连接=拿错 id）封死+政策兜底一处
 *  （1146→412 提示（hint 调用方给）/余→infraUnavailable500 政策点——裸事务重抛 raw=SQL+绑定参数泄客户端面封死）。
 * 环安全钉：本叶引 auth/identity——identity 不回指本叶（单向叶边不成环）。
 */
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "./connection";
import { scalarOfRows } from "./rawRows"; // R7-c155-⑩：解包守卫单点同引（rawRows 随守卫内聚——本文件不再直引）
import { isNoSuchTable, infraUnavailable500 } from "../auth/identity";
import { isDupEntry } from "./dupEntry"; // 撞键判别单源同引（同层叶边）

export async function txInsertId(insert: ReturnType<typeof sql>, tag: string, hint: string, opts?: { dupPassthrough?: boolean }): Promise<number> {
  try {
    return await getDb().transaction(async (tx) => {
      await tx.execute(insert);
      // R7-c150-③/R7-c155-⑩：解包 fail-loud 走 scalarOfRows 单点（positive=id 族——三副本合流一处；
      //  缺值/空白/非数值/非正整即抛——漂移成「合法 id 0」=票据/命令错挂 0 号面封死；事务内抛=回滚写入不半截留存）
      return scalarOfRows(await tx.execute(sql`SELECT LAST_INSERT_ID() AS id`), "id", { positive: true });
    });
  } catch (e) {
    // R7-c155-⑨ security low：dup 原链透传收窄为可选件（dupPassthrough=true 才透——默认掩码上行；
    //  不设防的调用点撞键即泄 SQL+绑定参数面封死——安全不再系于「这些表没有唯一键」的带外 schema 不变式）
    if (opts?.dupPassthrough && isDupEntry(e)) throw e; // 撞键域内信号（声明消费的调用点才收原链——幂等判别保真）
    if (isNoSuchTable(e)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: hint });
    infraUnavailable500(tag, e);
  }
}
