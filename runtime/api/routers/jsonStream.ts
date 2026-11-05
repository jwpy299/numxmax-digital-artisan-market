/**
 * jsonStream —— M60 流式 JSON 增量解析（中立模块，供 voiceBuddy/voice 共用，禁环依赖）。
 *
 * 场景：LLM 按指令输出单行 JSON（如 {"reply":"...","emotion":"..."}），
 * stream:true 下增量到达；本模块从【可能不完整】的原文里提取指定字符串字段的
 * 当前已累计值，供「边收边播/边收边显」，绝不等待全量 JSON 落定。
 */

/**
 * 增量提取 string 字段当前值：定位 `"<field>": "` 开口引号后，扫描到未转义闭引号为止；
 * 未扫到闭引号（流式中段）返回已累计部分；字段未开始/非法返回 null。
 * 输出做最小反转义（\" \\ \/ \n \t \r），供增量人读/TTS。
 */
export function extractPartialString(raw: string, field: string): string | null {
  const re = new RegExp(`"${field}"\\s*:\\s*"`);
  const m = re.exec(raw);
  if (!m) return null;
  const start = m.index + m[0].length;
  let out = "";
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "\\" && i + 1 < raw.length) {
      const nx = raw[i + 1];
      if (nx === '"' || nx === "\\" || nx === "/") out += nx;
      else if (nx === "n") out += "\n";
      else if (nx === "t") out += "\t";
      else if (nx === "r") out += "\r";
      else out += nx; // 未知转义（含 \uXXXX 半截）：先原样吐首字符，余下随后续 chunk 补全
      i += 1;
      continue;
    }
    if (ch === '"') return out; // 闭引号：字段完整
    out += ch;
  }
  return out; // 流式中段：已累计部分
}

/**
 * 提取枚举字段的【已闭合】值（如 "kind":"chat"）：只在值完整（闭引号出现）时返回，
 * 流式中段不猜（返回 null）。用于路由类字段早判——值不全宁可等，绝不错判。
 */
export function extractClosedEnum<T extends string>(raw: string, field: string, allowed: readonly T[]): T | null {
  const re = new RegExp(`"${field}"\\s*:\\s*"([^"]*)"`);
  const m = re.exec(raw);
  if (!m) return null;
  const v = m[1] as T;
  return allowed.includes(v) ? v : null;
}
