/** probeDeep —— 深健康探测共享单点（portal#42 票③：admin.ts/terminal.ts 同引，不再双写漂移）：
 *  探 {base}/api/healthz（DB 专用连接真查询＋池信号双真才绿），ok=status 200 且 body.ok===true——
 *  浅探「首页 HTML 404 也算 ok」的假绿灯面已摘除；对端未上线（404/非 JSON）判红不假绿。
 *  5s 超时，失败不抛异常。路径走 Paths.healthz 单源（票①②：与注册路由不漂移）。 */
import { Paths } from "@contracts/constants";

export interface DeepProbeResult {
  url: string;
  httpCode: number;
  latencyMs: number;
  ok: boolean;
}

export async function probeDeep(url: string): Promise<DeepProbeResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  const deepUrl = url.replace(/\/$/, "") + Paths.healthz;
  try {
    const res = await fetch(deepUrl, { signal: controller.signal, redirect: "manual" });
    const body = (await res.json().catch(() => null)) as { ok?: boolean } | null; // 非 JSON/404→null=红
    return { url: deepUrl, httpCode: res.status, latencyMs: Date.now() - started, ok: res.status === 200 && body?.ok === true };
  } catch {
    return { url: deepUrl, httpCode: 0, latencyMs: Date.now() - started, ok: false };
  } finally {
    clearTimeout(timer);
  }
}
