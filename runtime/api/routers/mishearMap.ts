/**
 * mishearMap —— ASR 误听确定性归一表（服务端/解析层共用单一事实源）。
 *
 * 来历：生产实证误听（灵枢→林叔/灵数、星云→新云仙/心云……）+ 实验室复现
 * （注塑机→住宿机、料筒→廖统、点检→电简，sherpa 流式绑定热词不生效的实测证据）。
 *
 * 纪律：
 * - 只做「生产/实验室实证过的误听对」的确定性替换，不瞎猜语义；
 * - 长词优先（先替换长串再替换短串，防止「NumX Max」被「灵枢」截胡）；
 * - 归一只改识别文本，绝不影响动作安全闸（kind 判定后仍有白名单/票据/置信度三道闸）；
 * - 新增词条必须有实证来源（生产日志或实验室复现），并在此注释标注。
 */

/** [误听形, 正确形]——长词优先排序在 mishearCorrect 内做，此处书写顺序无关 */
const MISHEAR_PAIRS: Array<[string, string]> = [
  // ── 品牌与人格（生产实证 v1.5.2 口径） ──
  ["新云仙", "星云"], ["心云", "星云"], ["新员", "星云"], ["新云落克", "星云"],
  ["林叔", "灵枢"], ["灵数", "灵枢"], ["领书", "灵枢"], ["林数", "灵枢"],
  // ── 驻部智能体名（生产实证） ──
  ["灵厕", "灵策"], ["灵彻", "灵策"], ["灵筑主", "灵筑"], ["灵算师", "灵算"],
  ["零算", "灵算"], // 实验室复现（2026-08-14 sherpa 服务端链路）
  ["灵恒", "灵衡"], ["灵谋", "灵眸"],
  // ── 办公物件（生产实证） ──
  ["皮迪亚", "PPT"], ["批评地", "PPT"], ["屁屁踢", "PPT"],
  ["文江", "Word"], ["沃德", "Word"], ["埃克塞尔", "Excel"],
  ["百名单", "白名单"], ["听不娶", "听不见"], ["单机", "单据"], ["早下", "找一下"],
  // ── 工业词汇（实验室复现 2026-08-14：sherpa zipformer-3.3M 对行业词误听） ──
  ["住宿机", "注塑机"], ["注速机", "注塑机"],
  ["廖统", "料筒"],
  ["电简表", "点检表"], ["电检表", "点检表"], ["点简", "点检"],
  // 实测无误差无需归一的工业词：模次、螺杆、转速、合模（留注备查，不占表位）
];

/** 长词优先的有序规则表（模块加载时排一次） */
const ORDERED: Array<[string, string]> = [...MISHEAR_PAIRS].sort((a, b) => b[0].length - a[0].length);

/**
 * ASR 文本确定性归一：按长词优先全量替换。
 * 幂等占位词条（误听形==正确形）不参与替换。
 */
export function mishearCorrect(text: string): string {
  let out = String(text ?? "");
  for (const [wrong, right] of ORDERED) {
    if (wrong === right) continue;
    if (out.includes(wrong)) out = out.split(wrong).join(right);
  }
  return out;
}

/** 解析层 prompt 用的对照块（与替换表同源生成，防止两处口径漂移） */
export function mishearPromptBlock(): string {
  const seen = new Map<string, string[]>();
  for (const [wrong, right] of MISHEAR_PAIRS) {
    if (wrong === right) continue;
    const arr = seen.get(right) ?? [];
    arr.push(wrong);
    seen.set(right, arr);
  }
  const lines = [...seen.entries()].map(([right, wrongs]) => `〔${wrongs.join("/")} → ${right}〕`);
  return (
    `语音识别误听对照（ASR 同音字纠偏，判意图前先按此归一原文）：\n${lines.join("；")}\n` +
    `〔班组语音房/开会/晨会/语音会议 语义同族〕\n`
  );
}
