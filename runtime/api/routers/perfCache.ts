/**
 * perfCache —— iter85 只读热点内存缓存。
 *
 * 适用：无租户隔离差异的公开只读查询（匠市列表/详情、榜单、facets 等）。
 * 禁忌：带 factoryId / 用户态的查询不得使用；或必须把租户标识拼进 key。
 *
 * 特性：
 * - Map + TTL 过期（读时惰性判断，无需定时器）
 * - 简单 LRU：写入时超 MAX_KEYS 淘汰最久未访问键
 * - single-flight 防击穿：同 key 并发未命中只回源一次
 * - invalidate(prefix)：写操作后按前缀失效
 *
 * 单进程 Hono 部署下进程内缓存即全局有效。
 */

const MAX_KEYS = 200;

interface Entry {
  value: unknown;
  expiresAt: number;
}

const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

export async function cached<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const hit = store.get(key);
  if (hit) {
    if (hit.expiresAt > Date.now()) {
      // LRU touch：重插到 Map 尾部
      store.delete(key);
      store.set(key, hit);
      return hit.value as T;
    }
    store.delete(key);
  }
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;

  const p = (async (): Promise<T> => {
    try {
      const value = await fn();
      if (store.size >= MAX_KEYS && !store.has(key)) {
        const oldest = store.keys().next().value;
        if (oldest !== undefined) store.delete(oldest);
      }
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/** 按 key 前缀失效，返回失效条数（写操作后调用，如 hire / admin 改 agent） */
export function invalidate(prefix: string): number {
  let n = 0;
  for (const k of [...store.keys()]) {
    if (k.startsWith(prefix)) {
      store.delete(k);
      n += 1;
    }
  }
  return n;
}

/** 测试/运维用：清空并返回当前键数 */
export function cacheStats(): { size: number; inflight: number } {
  return { size: store.size, inflight: inflight.size };
}
