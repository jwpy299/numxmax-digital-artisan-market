/**
 * evolutionShared —— 自进化能力共享模块（确定性向量 / 工业词表 / 工具目录辅助）。
 *
 * 提炼自 eliza IMemoryManager 的 embedding 写入/召回语义，工业化改造：
 * - 无外部 LLM/embedding 服务：64 维确定性哈希向量 = 工业词表加权（3×）+ 字符 bigram 哈希，
 *   L2 归一化；同一文本永远得到同一向量（全确定性，无随机）。
 * - 工业词表仅限制造/设备/工艺域表述，不纳入其他领域词汇。
 */
import { createHash } from "node:crypto";

export const EVO_EMBEDDING_DIM = 64;
export const EVO_INDUSTRIAL_WEIGHT = 3;

/** 工业词表（加权 3 倍）：覆盖设备/工艺/质量/排产/运维域 */
export const EVO_INDUSTRIAL_VOCAB = [
  "CNC", "cnc", "数控", "振动", "频谱", "动平衡", "焊接", "焊缝", "热处理", "淬火",
  "回火", "质检", "检验", "测量", "排产", "刀具", "主轴", "轴承", "车床", "铣床",
  "加工中心", "磨床", "冲压", "锻造", "模具", "装配", "传感器", "标定", "校准",
  "巡检", "点检", "保养", "维护", "劣化", "故障", "告警", "异常", "超差", "缺陷",
  "气孔", "咬边", "裂纹", "毛刺", "良率", "不良", "返修", "报废", "工艺", "工序",
  "工位", "产线", "车间", "班次", "交接班", "工单", "派工", "设备", "网关",
  "温度", "压力", "扭矩", "转速", "进给", "切削", "冷却", "液压", "气动",
  "OEE", "oee", "SPC", "spc", "节拍", "换模", "首件", "互锁", "安全",
] as const;

/** djb2 字符串哈希（确定性，非加密用途） */
function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

/** sha256 十六进制（区块/指纹用途，复用 node crypto） */
export function evoSha256(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/**
 * 确定性 64 维哈希向量：
 * 1) 工业词表命中项 → vec[hash(term)%64] += 3（词表加权）；
 * 2) 全文本字符 bigram → vec[hash(bigram)%64] += 1；
 * 3) L2 归一化。空文本回退零向量（对齐 eliza embedding 失败回退语义，不阻塞写入）。
 */
export function evoEmbed(text: string): number[] {
  const vec = new Array<number>(EVO_EMBEDDING_DIM).fill(0);
  if (!text || !text.trim()) return vec;
  for (const term of EVO_INDUSTRIAL_VOCAB) {
    if (text.includes(term)) {
      vec[djb2(`v:${term}`) % EVO_EMBEDDING_DIM] += EVO_INDUSTRIAL_WEIGHT;
    }
  }
  const compact = text.replace(/\s+/g, "");
  for (let i = 0; i < compact.length - 1; i++) {
    const bg = compact.slice(i, i + 2);
    vec[djb2(`b:${bg}`) % EVO_EMBEDDING_DIM] += 1;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (norm === 0) return vec;
  return vec.map((v) => Math.round((v / norm) * 1e6) / 1e6);
}

/** 余弦相似度（向量已归一化时等价于点积，仍按通用式计算） */
export function evoCosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 召回阈值：severity≥4（critical）降至 0.05 保证必召回，其余 0.1（对齐 eliza 默认） */
export function evoRecallThreshold(severity: number): number {
  return severity >= 4 ? 0.05 : 0.1;
}

/** 反思去重阈值：与既有 insights 余弦 > 0.92 视为 already_known 跳过 */
export const EVO_REFLECT_DEDUP_THRESHOLD = 0.92;
