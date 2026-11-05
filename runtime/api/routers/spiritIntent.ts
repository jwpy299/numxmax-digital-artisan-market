/**
 * spiritIntent —— 精灵意图-动作层（彭总 2026-09-03 令：星云调用 APP 功能 + 蓝牙控家电）。
 *
 * 定位：spirit-chat 的下游——对话识别出动作意图后，翻译成系统真实能力调用。
 * 意图三类：
 * - device 设备控制（打开空调/打印文件）→ 走 deviceMcp/devices 指令面契约
 *   纪律钉死：B 级直排，C 级必须双签票据（不另立规矩，不绕闸口）
 * - app    APP 功能调用（查待办/看纪要/开工作台）→ 返回动作卡（APP 端执行跳转）
 * - chat   纯闲聊/问答 → 不动作
 *
 * 意图识别：确定性关键词路由先行（零延迟零成本），拿不准回落 null 由 LLM 自由聊。
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { rawRows } from "./terminal";
import { sessionMe } from "./wbSession";

export type SpiritIntentKind = "device" | "app" | "chat";

export interface SpiritIntent {
  kind: SpiritIntentKind;
  /** device: 设备动作；app: 功能路径 */
  action?: string;
  target?: string;    // 设备名/功能名
  confidence: number;
}

// ─── 意图识别（确定性路由，纯函数可测） ─────────────────────────

const DEVICE_VERBS = /(打开|开启|关掉|关闭|开一下|关一下|调高|调低|调到|设置|打印|扫描|启动|停止|开|关)/;
const DEVICE_NOUNS = /(空调|灯|打印机|打印|电视|风扇|窗帘|加湿器|净化器|音箱|投影)/;
const CABIN_TALK_PATTERN = /(问问|问一下|问下|找|喊|叫|让|告诉|通知)(一下|下)?(.{1,4}舱)/;
const APP_INTENTS: Array<{ pattern: RegExp; action: string; target: string }> = [
  { pattern: CABIN_TALK_PATTERN, action: "cabin_talk", target: "跨舱协同" },
  { pattern: /(待办|任务|工单|今天.*(干|做)什)/, action: "open_todos", target: "待办中心" },
  { pattern: /(纪要|会议|开个会)/, action: "open_meetings", target: "会议纪要" },
  { pattern: /(工作台|工作台页)/, action: "open_workbench", target: "工作台" },
  { pattern: /(考勤|打卡|签到)/, action: "open_attendance", target: "考勤" },
  { pattern: /(审批|报销|请假)/, action: "open_approvals", target: "审批" },
  { pattern: /(工资|薪资|钱包|余额|词元)/, action: "open_wallet", target: "钱包" },
  // v2.9.1 深链补齐（彭总令：精灵跳转 APP 功能界面）
  { pattern: /(扫一扫|扫一下|雷达|连设备|附近设备)/, action: "open_radar", target: "扫一扫" },
  { pattern: /(通讯录|联系人|找同事)/, action: "open_contacts", target: "通讯录" },
  { pattern: /(组织|部门|舱位)/, action: "open_cabins", target: "部门舱位" },
  { pattern: /(总经理驾驶舱|更新舱|市场舱|财务舱|运行舱|运营舱|法务舱|品牌舱|渠道舱|文化知识舱)/, action: "open_cabins", target: "部门舱位" },
  { pattern: /(超市|商城|数字员工市场|雇一个)/, action: "open_market", target: "员工超市" },
  { pattern: /(看板|数据|报表|经营)/, action: "open_dashboard", target: "数据看板" },
  { pattern: /(晨报|早报)/, action: "open_briefing", target: "晨报" },
  { pattern: /(回首页|回主页|个人空间)/, action: "go_home", target: "首页" },
  { pattern: /(企业空间)/, action: "go_ent", target: "企业空间" },
  { pattern: /(我的|个人中心|设置)/, action: "open_mine", target: "我的" },
];

/** app 意图动作 → 深链（与 APP Root.tsx SPIRIT_LINKING 路由表同口径） */
export const APP_DEEPLINKS: Record<string, string> = {
  open_todos: "lingshu://todo",
  open_meetings: "lingshu://rooms",
  open_workbench: "lingshu://duty",
  open_attendance: "lingshu://duty",
  open_approvals: "lingshu://todo",
  open_wallet: "lingshu://assets",
  cabin_talk: "lingshu://contacts",
  open_radar: "lingshu://radar",
  open_contacts: "lingshu://contacts",
  open_cabins: "lingshu://cabins",
  open_market: "lingshu://market",
  open_dashboard: "lingshu://dashboard",
  open_briefing: "lingshu://briefing",
  go_home: "lingshu://home",
  go_ent: "lingshu://ent",
  open_mine: "lingshu://mine",
};

export function detectIntent(message: string): SpiritIntent {
  const m = message.trim();
  // 设备控制：动词+设备名词 双命中
  if (DEVICE_VERBS.test(m) && DEVICE_NOUNS.test(m)) {
    const noun = m.match(DEVICE_NOUNS)?.[0] ?? "";
    return { kind: "device", action: m.match(DEVICE_VERBS)?.[1], target: noun, confidence: 0.85 };
  }
  for (const ai of APP_INTENTS) {
    if (ai.pattern.test(m)) {
      return { kind: "app", action: ai.action, target: ai.target, confidence: 0.8 };
    }
  }
  return { kind: "chat", confidence: 0.5 };
}

// ─── 设备动作映射（口语 → deviceMcp 工具名约定） ────────────────
const DEVICE_ACTION_MAP: Record<string, string> = {
  打开: "power_on", 开: "power_on",
  关掉: "power_off", 关闭: "power_off", 关: "power_off",
  调高: "adjust_up", 调低: "adjust_down",
  打印: "print", 扫描: "scan",
};

export function mapDeviceAction(verb: string): string {
  return DEVICE_ACTION_MAP[verb] ?? verb;
}

/** v2.9.1 精灵三阶权限矩阵（彭总令：企业主/部门负责人/员工的精灵各是其秘书）——
 *  身份镜像：人在系统什么角色，精灵就什么权限；人调舱/离职，精灵权限随动。
 *  tier: owner（总经理秘书）/ head（舱务秘书）/ staff（个人助理） */
export async function spiritTierOf(userId: number, factoryId: number): Promise<"owner" | "head" | "staff"> {
  const db = getDb();
  try {
    const gm = rawRows(
      await db.execute(
        sql`SELECT id FROM st_ent_cabins WHERE factory_id=${factoryId} AND code='x_gm' AND head_user_id=${userId} AND disabled=0 LIMIT 1`,
      ),
    );
    if (gm.length > 0) return "owner";
    const head = rawRows(
      await db.execute(
        sql`SELECT id FROM st_ent_cabins WHERE factory_id=${factoryId} AND head_user_id=${userId} AND disabled=0 LIMIT 1`,
      ),
    );
    if (head.length > 0) return "head";
  } catch { /* 判定失败按最低阶 */ }
  return "staff";
}

/** 各阶允许的动作面（身份镜像纪律：越权一律服务端拒，不靠前端藏按钮） */
export const TIER_ALLOW: Record<"owner" | "head" | "staff", Set<string>> = {
  owner: new Set(["device", "app", "cabin_talk", "cross_meeting", "money_confirm"]),
  head: new Set(["device", "app", "cabin_talk", "cross_meeting"]),
  staff: new Set(["device_self", "app"]),
};

export const spiritIntentRouter = createRouter({
  /** intent（query）：意图识别 + 可用能力枚举（APP 端据此出动作卡） */
  intent: publicQuery
    .input(z.object({ token: z.string().trim().min(1), message: z.string().trim().min(1).max(500) }))
    .query(async ({ input }) => {
      const session = await sessionMe(input.token);
      const intent = detectIntent(input.message);
      const tier = await spiritTierOf(Number(session.user.id), session.factory.id);

      // 权限闸：跨舱协同仅 owner/head；员工精灵只能与本舱舱主对话（落 contacts 页）
      if (intent.kind === "app" && intent.action === "cabin_talk" && tier === "staff") {
        return { intent: { ...intent, action: "open_contacts", target: "本舱舱主" }, tier };
      }

      if (intent.kind !== "device") return { intent, tier };

      // 设备意图：枚举本人/本厂已绑定设备里能匹配 target 的（诚实——找不到就说不认识这台设备）
      const db = getDb();
      let candidates: Record<string, unknown>[] = [];
      try {
        const kw = `%${intent.target ?? ""}%`;
        candidates = rawRows(
          await db.execute(
            sql`SELECT id, name, category, status FROM wb_assets
                WHERE factory_id=${session.factory.id} AND (name LIKE ${kw} OR category LIKE ${kw})
                LIMIT 5`,
          ),
        );
        if (candidates.length === 0) {
          candidates = rawRows(
            await db.execute(
              sql`SELECT id, name, category, status FROM wb_assets
                  WHERE factory_id=${session.factory.id} AND category LIKE ${kw} LIMIT 5`,
            ),
          );
        }
      } catch { /* 表无则空 */ }

      return {
        intent: {
          ...intent,
          action: mapDeviceAction(intent.action ?? ""),
          candidates,
          needsConfirm: true, // 设备动作一律需用户在 APP 上确认（C 级纪律：双签票据另行）
        },
        tier,
      };
    }),
});
