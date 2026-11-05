import type { Context } from "hono";
import { sql } from "drizzle-orm";
import { callSlotChat } from "./modelGateway";
import { sessionMe } from "./wbSession";
import { getDb } from "../queries/connection";
import { rawRows, warnThrottled } from "../queries/rawRows";
import { clientIp } from "../lib/clientIp";
import { detectIntent, APP_DEEPLINKS } from "./spiritIntent";

/**
 * #24 星云手机精灵 · 云端对话端点
 * POST /api/spirit-chat  { message: string, token?: string }
 * → { ok, reply, who? }  |  { ok:false, reason }
 * 带有效 token：识别用户身份并注入其舱位真实待办（统一账号体系，与 APP/工作台同源 nt_ token）；
 * 不带/失效 token：匿名演示模式（不报错，只回通用能力）。
 * 安全：每 IP 6 次/分钟内存限流；输入≤200 字；输出≤400 tokens；只走 flash 槽。
 */

const hits = new Map<string, number[]>();
const LIMIT = 6;
const WINDOW_MS = 60_000;

function allow(ip: string): boolean {
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= LIMIT) { hits.set(ip, arr); return false; }
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear(); // 防膨胀
  return true;
}

const SYSTEM_WORK = `你是「星云」，NumX Max 组织智能体系统的手机精灵，一只可爱的熊猫机器人（二次元形象）。
说话风格：干练、简短、报数据给确定性口径，自称"星云"。回答控制在 80 字以内，适合语音播报。
你是随身组织军师：熟悉舱位、任务、会议纪要、工作台。不知道的就老实说不知道，不要编造数据。`;

/** 生活模式（彭总 2026-09-03 令：精灵分工作/生活模式） */
const SYSTEM_LIFE = `你是「星云」，用户的手机精灵，一只可爱的熊猫机器人（二次元形象）。
现在是生活模式：松弛、温暖、会开玩笑，自称"星云"，不主动谈工作（除非用户问起）。
聊日常、家电控制、兴趣话题。回答控制在 80 字以内，适合语音播报。`;

function systemOf(mode?: string): string {
  return mode === "life" ? SYSTEM_LIFE : SYSTEM_WORK;
}

/** v2.9.10 精灵进化记忆（彭总令：精灵蒸馏一起干）——三师蒸出的精灵域养料直接进人格，
 *  60s 缓存；无养料静默。 */
let spiritMemoryCache = { text: "", at: 0 };
async function spiritMemory(): Promise<string> {
  if (Date.now() - spiritMemoryCache.at < 60_000) return spiritMemoryCache.text;
  try {
    const rows = rawRows(
      await getDb().execute(
        sql`SELECT id, LEFT(solution,260) AS s FROM st_evolve_lessons WHERE topic LIKE '%精灵%' AND topic NOT LIKE 'retired:%' ORDER BY id DESC LIMIT 2`,
      ),
    ) as { id: number; s: string }[];
    spiritMemoryCache = {
      text: rows.length ? "\n【精灵进化记忆（蒸馏养料，参考执行）】\n" + rows.map((r) => `· ${r.s}`).join("\n") : "",
      at: Date.now(),
    };
    // 后训练①调阅打点（fire-and-forget）
    if (rows.length) {
      void import("./evolvePost").then((m) => m.markLessonUsage(rows.map((r) => r.id), "spirit")).catch(() => {});
    }
  } catch { /* 静默 */ }
  return spiritMemoryCache.text;
}

/** 可选身份识别：有效 token → 注入用户真实上下文；无效/缺失 → 匿名（不抛错） */
export async function resolveWho(token?: string): Promise<{ who?: string; ctx?: string }> {
  if (!token || !token.startsWith("nt_")) return {};
  try {
    const { user, factory } = await sessionMe(token);
    const db = getDb();
    const list = rawRows(
      await db.execute(
        sql`SELECT title, status FROM st_cabin_tasks
            WHERE assignee_user_id=${user.id} AND status='open'
            ORDER BY created_at DESC LIMIT 5`,
      ),
    ) as unknown as { title: string; status: string }[];
    const taskLines = list.length > 0
      ? list.map((t, i) => `${i + 1}. ${t.title}`).join("；")
      : "（当前无未完成舱位任务）";

    // 按舱适配（彭总 2026-09-03 令：个人工作台按舱适配——每个舱对应超级终端）：
    // 我是舱长的舱 + 我有任务的舱 → 注入舱位上下文（工作台视角随舱走）
    let cabinLines = "（暂无舱位归属）";
    try {
      const myCabins = rawRows(
        await db.execute(
          sql`SELECT DISTINCT c.name, c.code,
                     (c.head_user_id=${user.id}) AS isHead,
                     (SELECT COUNT(*) FROM st_cabin_tasks t WHERE t.cabin_id=c.id AND t.status='open') AS openTasks
              FROM st_ent_cabins c
              LEFT JOIN st_cabin_tasks t2 ON t2.cabin_id=c.id AND t2.assignee_user_id=${user.id}
              WHERE c.factory_id=${user.factoryId} AND c.disabled=0
                AND (c.head_user_id=${user.id} OR t2.id IS NOT NULL)
              LIMIT 4`,
        ),
      ) as unknown as { name: string; code: string; isHead: number; openTasks: number }[];
      if (myCabins.length > 0) {
        cabinLines = myCabins
          .map((c) => `${c.name}${Number(c.isHead) ? "（你是舱长）" : ""}：${c.openTasks} 件在办`)
          .join("；");
      }
    } catch { /* 舱表异常不挡主链 */ }
    // 数据面扩展：本企业最近 3 条已归档会议纪要（标题+摘要前 60 字）
    let meetingLines = "（暂无会议纪要）";
    try {
      const meetings = rawRows(
        await db.execute(
          sql`SELECT topic, LEFT(COALESCE(summary,''), 60) AS brief FROM st_meetings
              WHERE status='closed' AND createdBy=${user.id} ORDER BY createdAt DESC LIMIT 3`,
        ),
      ) as unknown as { topic: string; brief: string }[];
      if (meetings.length > 0) {
        meetingLines = meetings.map((m, i) => `${i + 1}.《${m.topic}》${m.brief ? "：" + m.brief : ""}`).join("；");
      }
    } catch { /* 会议表异常不挡主链 */ }
    // ③ 精灵身份分级（彭总令：在谁手里是谁的秘书）——读舱位角色
    let spiritRole = "个人助理";
    try {
      const isGM = rawRows(
        await db.execute(
          sql`SELECT id FROM st_ent_cabins WHERE factory_id=${user.factoryId} AND code='x_gm' AND head_user_id=${user.id} LIMIT 1`,
        ),
      );
      const headOf = rawRows(
        await db.execute(
          sql`SELECT name FROM st_ent_cabins WHERE factory_id=${user.factoryId} AND head_user_id=${user.id} AND code!='x_gm' AND disabled=0 LIMIT 1`,
        ),
      );
      if (isGM.length > 0) spiritRole = "总经理秘书";
      else if (headOf.length > 0) spiritRole = `舱务秘书（${String(headOf[0].name)}）`;
    } catch { /* 角色判定失败默认个人助理 */ }

    return {
      who: user.displayName || user.username,
      ctx: `\n当前用户：${user.displayName || user.username}（${factory.enterpriseName}），你是他的「${spiritRole}」，称他/她为"${(user.displayName || "老板").slice(0, 8)}"或"老板"。\n该用户舱位归属：${cabinLines}\n未完成的舱位任务：${taskLines}\n最近会议纪要：${meetingLines}\n问任务/舱位/会议时基于以上真实数据回答；之外的问题不要编造业务数据。`,
    };
  } catch { return {}; } // token 失效 → 静默匿名
}

export async function spiritChatHandler(c: Context): Promise<Response> {
  const ip = clientIp(c);
  if (!ip) {
    warnThrottled("spiritChat.ip", "来源 IP 不可识别——请求拒绝，请核代理/XFF 配置");
    return c.json({ ok: false, reason: "ip_unavailable" }, 400);
  }
  if (!allow(ip)) return c.json({ ok: false, reason: "rate_limited" }, 429);

  let message = "";
  let token: string | undefined;
  let mode: string | undefined;
  try {
    const body = await c.req.json<{ message?: string; token?: string; mode?: string }>();
    message = (body.message ?? "").trim().slice(0, 200);
    token = typeof body.token === "string" ? body.token.slice(0, 64) : undefined;
    mode = typeof body.mode === "string" ? body.mode.slice(0, 16) : undefined;
  } catch { return c.json({ ok: false, reason: "bad_request" }, 400); }
  if (!message) return c.json({ ok: false, reason: "empty" }, 400);

  const { who, ctx } = await resolveWho(token);
  const r = await callSlotChat("flash", {
    messages: [
      { role: "system", content: systemOf(mode) + (await spiritMemory()) + (ctx ?? "\n当前为匿名演示模式：不知道用户身份和业务数据，被问到时大方说明「连上账号就能查真实数据」。") },
      { role: "user", content: message },
    ],
    maxTokens: 400,
    temperature: 0.7,
    timeoutMs: 25000, // 公网 ESA→S1→WG→CD-1 链路余量
    context: "spirit_chat",
  });
  if (!r.ok) return c.json({ ok: false, reason: r.reason ?? "llm_error" }, 502);
  // v2.9.1 意图落地：app 类意图附深链，精灵说完话直接跳进对应功能页
  let deeplink: string | null = null;
  try {
    if (who) {
      const intent = detectIntent(message);
      if (intent.kind === "app" && intent.action) deeplink = APP_DEEPLINKS[intent.action] ?? null;
      // v2.9.10 精灵蒸馏考题源（彭总令：精灵越答不上越要蒸）：动词+设备词都在却落回闲聊=意图落空
      if (intent.kind === "chat" && /(打开|开启|关掉|关闭|打印|控制|连接|调|设置)/.test(message) && /(空调|灯|打印机|电视|风扇|电脑|工作台|舱|任务|设备)/.test(message)) {
        try {
          await getDb().execute(sql`INSERT INTO st_evo_signals (factory_id, kind, actor, payload) VALUES (NULL,'spirit_miss',${who},${JSON.stringify({ message: message.slice(0, 200) })})`);
        } catch { /* 静默 */ }
      }
    }
  } catch { /* 意图失败不挡对话 */ }
  return c.json({ ok: true, reply: (r.content ?? "").trim().slice(0, 500), who: who ?? null, deeplink });
}
