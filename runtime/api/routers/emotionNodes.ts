/**
 * emotionNodes —— 灵枢情绪价值节点（2026-08-29 彭总令：「灵枢的语言情绪价值按我给你的延伸」）。
 *
 * 定位：四个关键时刻，灵枢主动「记得你」——注册第 7 天 / 分身首单 / 晋升解锁 / 评分首上 4.5。
 * 纪律：
 * - 文案确定性（纯函数），男=兄弟/女=姐妹/未填=老板，绝不靠模型现编；
 * - 走汇报总线 emitReport（dedupe_key 唯一，同节点同人永不重发）；
 * - 故障静默降级（情绪是锦上添花，绝不挡业务主链）。
 */
import { sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { rawRows } from "./terminal";
import { emitReport } from "./reportBus";

export type EmotionNode = "day7" | "first_order" | "promotion" | "score45";

/** 称呼（纯函数）：与注册第一句话同一纪律 */
export function siblingTerm(gender: string | null | undefined): string {
  if (gender === "male") return "兄弟";
  if (gender === "female") return "姐妹";
  return "老板";
}

/** 节点文案（纯函数）：title/body 全确定性 */
export function emotionCopy(node: EmotionNode, term: string, extra?: { name?: string; slotNo?: number; score?: number }): { title: string; body: string } {
  const name = extra?.name ?? "你的分身";
  switch (node) {
    case "day7":
      return {
        title: `${term}，灵枢陪你七天了`,
        body: `七天的路一起走过来了。${name}还在成长——今天去工作台给它派一单，战功是一天一天攒出来的。`,
      };
    case "first_order":
      return {
        title: `${term}，${name}拿下第一单！`,
        body: `第一单验收合格——这是${name}打工生涯的起点。继续派单，口碑攒够了就能上架超市替你赚租金。`,
      };
    case "promotion":
      return {
        title: `${term}，新名额解锁！`,
        body: `满两月+评分达标，第 ${extra?.slotNo ?? "?"} 个分身坑位开了——军团又多一员。去首页再领一位吧。`,
      };
    case "score45":
      return {
        title: `${term}，${name}冲上 ${extra?.score?.toFixed(1) ?? "4.5"} 分`,
        body: `这分数已经是招牌员工了。超市里的雇主就认这个——保持住，租金档位你来定。`,
      };
  }
}

/** 投递（查性别 → 组文案 → 汇报总线；故障静默 false） */
export async function emitEmotionNode(userId: number, node: EmotionNode, dedupeKey: string, extra?: { name?: string; slotNo?: number; score?: number }): Promise<boolean> {
  try {
    const u = rawRows(await getDb().execute(sql`SELECT gender FROM wb_users WHERE id=${userId} LIMIT 1`))[0];
    const copy = emotionCopy(node, siblingTerm(u ? (u.gender as string | null) : null), extra);
    return await emitReport({
      audience: "personal",
      userId,
      level: "info",
      sourceRing: "emotion",
      title: copy.title,
      body: copy.body,
      dedupeKey,
    });
  } catch {
    return false; // 情绪节点故障静默（绝不挡主链）
  }
}

/** 注册满 7 天扫描（挂 proactiveJobs 尾部）：前一天满 7 天的用户各推一条 */
export async function runEmotionSweep(): Promise<number> {
  const rows = rawRows(
    await getDb().execute(
      sql`SELECT id FROM wb_users
          WHERE createdAt >= DATE_SUB(CURDATE(), INTERVAL 8 DAY) AND createdAt < DATE_SUB(CURDATE(), INTERVAL 7 DAY)
          LIMIT 200`,
    ),
  );
  let sent = 0;
  for (const r of rows) {
    const uid = Number(r.id);
    if (await emitEmotionNode(uid, "day7", `emo:day7:u${uid}`)) sent += 1;
  }
  return sent;
}
