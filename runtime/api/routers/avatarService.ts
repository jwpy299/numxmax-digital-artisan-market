/**
 * avatarService —— 分身形象生成服务（2026-08-27 彭总令：个人版/企业版数字人形象一起干）。
 *
 * 口径：同一熊猫机器人基底（彭总视频标准），palette 换肤 + accessories 穿戴可见化——
 * 装扮间买的「衣服工具」直接穿在身上（客服=耳麦/巡检=安全帽/财税=领带/导购=鸭舌帽）。
 * 生成走 tools/gen-avatar.mjs（three 程序化建模，Node 无头），产物进门户 public/avatars/。
 * 纪律：生成失败静默降级（avatar_config 无 url 时 APP 端显示默认灵枢形象），绝不阻塞主链。
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const GEN_SCRIPT = path.resolve(process.cwd(), "tools/gen-avatar.mjs");
const OUT_DIR = process.env.AVATAR_OUT_DIR ?? path.resolve(process.cwd(), "dist/public/avatars");

export interface AvatarSpec {
  palette?: { white?: number; black?: number; screen?: number; teal?: number; tealHi?: number };
  accessories?: string[];
  badgeLetter?: string;
}

/** 预设皮肤（个人=玉绿系；企业=琥珀系；更多皮肤进装扮间售卖） */
export const AVATAR_PRESETS: Record<string, AvatarSpec> = {
  personal_jade: { palette: { teal: 0x34d399, tealHi: 0x7fe3c9 } },
  ent_amber: { palette: { teal: 0xfbbf24, tealHi: 0xfde68a } },
  ocean_blue: { palette: { teal: 0x38bdf8, tealHi: 0x7dd3fc } },
  violet: { palette: { teal: 0xa78bfa, tealHi: 0xc4b5fd } },
};

/** 职业模板 → 穿戴配饰（企业造人工坊模板即穿） */
export const TEMPLATE_ACCESSORIES: Record<string, string[]> = {
  cs: ["headset"],
  inspect: ["hardhat"],
  finance: ["tie"],
  sales: ["cap"],
  custom: [],
};

/** 装扮 item_key → 配饰（个人装扮间：买到即穿上） */
export const DRESS_ACCESSORIES: Record<string, string> = {
  "skill:cs": "headset",
  "skill:inspect": "hardhat",
  "skill:finance": "tie",
  "skill:sales": "cap",
};

/** 生成分身形象（幂等：同 key 同配置直接复用） */
export async function generateAvatar(agentKey: string, spec: AvatarSpec): Promise<string | null> {
  try {
    if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
    const out = path.join(OUT_DIR, `${agentKey}.glb`);
    await new Promise<void>((resolve, reject) => {
      execFile(
        process.execPath,
        [GEN_SCRIPT, JSON.stringify(spec), out],
        { timeout: 120_000 },
        (err) => (err ? reject(err) : resolve()),
      );
    });
    return `/avatars/${agentKey}.glb`;
  } catch {
    return null; // 静默降级（P4 纪律）
  }
}

/** 形象重生成（装扮变更后调用；失败保留旧图） */
export async function regenerateAvatar(agentKey: string, spec: AvatarSpec): Promise<string | null> {
  return generateAvatar(agentKey, spec);
}
