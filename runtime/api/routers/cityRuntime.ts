/**
 * cityRuntime —— 城市智能运行时（2026-08-29 彭总令：第三运行时坐实）。
 *
 * 定位：每城一名「城市运营官」智能体（佛山·佛枢 / 肇庆·肇星），挂进三环真节拍：
 * - 调度环（30min）：评估本城实况（真表 COUNT），KPI 快照落 st_city_agents.kpi_json；
 * - 点亮欢迎：本城今日新点亮企业/个人 → 运营官发汇报（dedupe 日级，不刷屏）；
 * - 城市晨报：每天 08:05（城中无打扰窗外）发一条本城日报（点亮/交付/待拓）；
 * - 状态机：on_duty（有数据在干活）/ observing（空城观察中）——如实，不装忙。
 * 纪律：全确定性评估（不靠模型现编数字）；emitReport 走汇报总线；故障静默不挡主链。
 */
import { sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { rawRows } from "./terminal";
import { emitReport } from "./reportBus";

export interface CityKpi { enterprises: number; users: number; todayNew: number; weeklyDeliveries: number }

/** 运营官状态机（纯函数可测）：有实体点亮=在岗，空城=观察中 */
export function officerState(k: CityKpi): "on_duty" | "observing" {
  return k.enterprises + k.users > 0 ? "on_duty" : "observing";
}

/** 晨报文案（纯函数可测）：确定性，数字全部来自 KPI */
export function cityDailyCopy(officer: string, cityCn: string, k: CityKpi): { title: string; body: string } {
  if (k.enterprises + k.users === 0) {
    return {
      title: `【${cityCn}晨报】${officer}：空城待拓`,
      body: `${cityCn}目前 0 点亮。空城不是空白，是机会——第一家点亮的企业将直接出现在城市分屏首页。`,
    };
  }
  return {
    title: `【${cityCn}晨报】${officer}：点亮 ${k.enterprises + k.users}（企 ${k.enterprises}/人 ${k.users}）`,
    body: `昨日新增点亮 ${k.todayNew}；全城周验收交付 ${k.weeklyDeliveries} 单。${k.todayNew > 0 ? "新血已入账，继续拓。" : "今日目标：新增至少 1 家点亮。"}`,
  };
}

async function cityKpi(city: string): Promise<CityKpi> {
  const db = getDb();
  const num = (r: Record<string, unknown>[]) => Number(r[0]?.c ?? 0);
  const enterprises = num(rawRows(await db.execute(sql`SELECT COUNT(*) c FROM wb_factories WHERE disabled=0 AND city=${city}`)));
  const users = num(rawRows(await db.execute(sql`SELECT COUNT(*) c FROM wb_users WHERE city=${city}`)));
  const todayNew =
    num(rawRows(await db.execute(sql`SELECT COUNT(*) c FROM wb_factories WHERE disabled=0 AND city=${city} AND createdAt >= CURDATE()`))) +
    num(rawRows(await db.execute(sql`SELECT COUNT(*) c FROM wb_users WHERE city=${city} AND createdAt >= CURDATE()`)));
  // 城市交付口径：本城企业名下验收（暂按全城近似——待验收单带 city 后精确化）
  const weeklyDeliveries = num(rawRows(await db.execute(sql`SELECT COUNT(*) c FROM st_delivery_acceptances WHERE accepted_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`)));
  return { enterprises, users, todayNew, weeklyDeliveries };
}

/** 城市中文名（确定性映射） */
export const CITY_CN: Record<string, string> = {
  guangzhou: "广州", shenzhen: "深圳", zhuhai: "珠海", shantou: "汕头", foshan: "佛山",
  shaoguan: "韶关", zhanjiang: "湛江", zhaoqing: "肇庆", jiangmen: "江门", maoming: "茂名",
  huizhou: "惠州", meizhou: "梅州", shanwei: "汕尾", heyuan: "河源", yangjiang: "阳江",
  qingyuan: "清远", dongguan: "东莞", zhongshan: "中山", chaozhou: "潮州", jieyang: "揭阳", yunfu: "云浮",
};

/**
 * 城市动作面：招商线索提案（2026-08-29 彭总令）。
 * 本城今日新点亮企业 → 运营官建「跟进提案」入 st_evo_proposals（status=pending）——
 * 纪律：运营官只提不批，批准/驳回走原双签人工流；target_key=city:<code>:ent:<id> 天然幂等。
 */
export async function cityLeadProposals(city: string, officer: string): Promise<number> {
  const db = getDb();
  const { isoWeek } = await import("./evo");
  const week = isoWeek();
  const fresh = rawRows(
    await db.execute(
      sql`SELECT id, enterpriseName FROM wb_factories
          WHERE disabled=0 AND city=${city} AND createdAt >= DATE_SUB(NOW(), INTERVAL 1 DAY) LIMIT 10`,
    ),
  ) as { id: number; enterpriseName: string }[];
  let created = 0;
  for (const f of fresh) {
    const key = `city:${city}:ent:${f.id}`;
    const pending = rawRows(
      await db.execute(sql`SELECT id FROM st_evo_proposals WHERE target_key=${key} AND status='pending' LIMIT 1`),
    );
    if (pending.length > 0) continue;
    const cn = CITY_CN[city] ?? city;
    await db.execute(
      sql`INSERT INTO st_evo_proposals
          (week, target_type, target_key, title, content, evidence, status, factory_id, skill_key, proposal_type, rationale, diff_preview, \`source\`)
          VALUES (${week}, 'ops', ${key},
            ${`【${cn}】招商线索：「${String(f.enterpriseName).slice(0, 40)}」新点亮，建议 24h 内跟进`.slice(0, 128)},
            ${`城市运营官 ${officer} 巡城发现：企业「${String(f.enterpriseName).slice(0, 80)}」于 24h 内点亮${cn}。建议动作：首联（开通回访）→ 需求摸底 → 适配数字员工模板推荐。`.slice(0, 3800)},
            ${`st_city_agents 节拍实采：${cn} 今日新增点亮`.slice(0, 3800)},
            'pending', NULL, '', 'investigate', ${`城市智能运行时自动线索（非人工录入）`.slice(0, 3800)}, NULL, 'city-runtime')`,
    );
    created += 1;
  }
  return created;
}

/** 城市节拍主流程（挂 proactiveJobs 调度环节拍尾部，独立隔离） */
export async function runCityBeat(now = new Date()): Promise<{ cities: number }> {
  const db = getDb();
  let officers = rawRows(await db.execute(sql`SELECT id, city, officer_name, state FROM st_city_agents`)) as {
    id: number; city: string; officer_name: string; state: string;
  }[];
  if (officers.length === 0) return { cities: 0 };

  const hour = now.getHours(), minute = now.getMinutes();
  const isMorningDaily = hour === 8 && minute < 30; // 晨报窗（08:00-08:30 调度环内触发一次，dedupe 日级兜底）

  for (const o of officers) {
    try {
      const k = await cityKpi(o.city);
      const next = officerState(k);
      // KPI 快照+状态回写（节拍留痕）
      await db.execute(
        sql`UPDATE st_city_agents SET kpi_json=${JSON.stringify(k)}, state=${next}, last_beat_at=NOW() WHERE id=${o.id}`,
      );
      // 点亮欢迎（日级 dedupe）：今日有新点亮 → 运营官欢迎一条
      if (k.todayNew > 0) {
        await emitReport({
          audience: "factory", level: "info", sourceRing: "city",
          title: `🏙 ${o.officer_name}（${CITY_CN[o.city] ?? o.city}）：今日新点亮 +${k.todayNew}`,
          body: `本城累计点亮 ${k.enterprises + k.users}（企业 ${k.enterprises} / 个人 ${k.users}）。`,
          dedupeKey: `city:welcome:${o.city}:${now.toISOString().slice(0, 10)}`,
        });
      }
      // 城市动作面：招商线索提案（只提不批，双签留给人）
      const leads = await cityLeadProposals(o.city, o.officer_name).catch(() => 0);
      if (leads > 0) {
        await emitReport({
          audience: "factory", level: "action", sourceRing: "city",
          title: `📋 ${o.officer_name} 提交 ${leads} 条招商线索提案（待双签）`,
          body: `已进入提案队列——批准/驳回请走超级终端提案中心。`,
          dedupeKey: `city:leads:${o.city}:${now.toISOString().slice(0, 10)}`,
        });
      }
      // 城市晨报（08:00-08:30 窗）
      if (isMorningDaily) {
        const copy = cityDailyCopy(o.officer_name, o.city === "foshan" ? "佛山" : o.city === "zhaoqing" ? "肇庆" : o.city, k);
        await emitReport({
          audience: "factory", level: "info", sourceRing: "city",
          title: copy.title, body: copy.body,
          dedupeKey: `city:daily:${o.city}:${now.toISOString().slice(0, 10)}`,
        });
      }
    } catch {
      // 单城失败不拖垮其他城市
    }
  }
  return { cities: officers.length };
}
