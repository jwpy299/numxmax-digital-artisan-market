// 确定性伪随机（LCG）— 同一个 seed 永远产出同一序列，
// 用于任务报告、价格曲线等"看起来随机但必须可复现"的内容。
export function createRng(seed: number) {
  let state = (seed >>> 0) || 1;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
  return {
    next, // 0-1
    between: (min: number, max: number) => min + next() * (max - min),
    int: (min: number, max: number) => Math.floor(min + next() * (max - min + 1)),
    pick: <T>(arr: T[]): T => arr[Math.floor(next() * arr.length)],
  };
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
