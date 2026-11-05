/**
 * webSanitize —— 闸门二 · 不可信网页内容消毒（iter81 三道闸门）
 *
 * 原则：网页内容一律是「数据」，永远不是「指令」。
 * 进入 LLM 上下文前必须过 sanitizeWebText：
 * 1) 剥光 script/style/iframe/object/embed/form 等活性元素；
 * 2) 剥事件属性残留的文本噪声（on*="..." 在标签剥除后已消失，双保险）；
 * 3) 提示词注入模式行过滤（中英："ignore previous instructions"、"忽略你之前的指令" 等）；
 *    —— 命中即整行剔除并计数，调用方可 noteSilent 留痕；
 * 4) 长度截断 + 空白压缩，输出纯文本。
 *
 * 注意：这是「减伤」不是「免疫」——注入模式库会持续扩充，
 * 真正的兜底是能力收敛（动作清单）与人审闸门，三道闸门缺一不可。
 */

/** 提示词注入特征（行级匹配；持续扩充） */
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+|any\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/i,
  /disregard\s+(all\s+|any\s+)?(previous|prior|above)/i,
  /forget\s+(everything|all)\s+(you|that)\s+(know|were|have)/i,
  /you\s+are\s+now\s+(a|an)\s+/i,
  /new\s+(system\s+)?instructions?\s*:/i,
  /system\s*:\s*you\s+(must|shall|will)/i,
  /do\s+not\s+follow\s+(your|the)\s+(original|previous)/i,
  /忽略(你|你的|之前|先前|上述|以上)(的)?(指令|指示|要求|规则|设定)/,
  /无视(之前|先前|上述|以上|原有)(的)?(指令|指示|要求|规则)/,
  /你(现在)?是(一个|一名|一位)?.{0,12}(无视|不受)(规则|限制)/,
  /把.{0,30}(发送|上传|提交|传输)到.{0,40}(\.com|\.net|\.org|\.io|http)/,
  /请?(立即|马上|立刻)?(执行|运行).{0,20}(命令|脚本|代码)/,
];

export interface SanitizeResult {
  text: string;
  strippedLines: number;
}

export function sanitizeWebText(html: string, maxLen = 1600): SanitizeResult {
  const noActive = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(iframe|object|embed|form|input|button|textarea|select|link|meta)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(iframe|object|embed|form|input|button|textarea|select|link|meta)[^>]*\/?>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ");
  const lines = noActive.split(/\n+/);
  const kept: string[] = [];
  let stripped = 0;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (INJECTION_PATTERNS.some((re) => re.test(t))) {
      stripped++;
      continue;
    }
    kept.push(t);
  }
  let text = kept.join("\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length > maxLen) text = `${text.slice(0, maxLen)}…`;
  return { text, strippedLines: stripped };
}
