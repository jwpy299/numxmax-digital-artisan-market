/**
 * teamProgress —— NumX Max 工程团队实时进度聚合（彭总令 2026-10-06：挂门户域名，独立页面）。
 *  GET /api/team-progress（进度页专用口令鉴权——TEAM_PROGRESS_TOKEN env，不用工作台登录态）＋
 *  GET /api/team-progress/stream（SSE 实时流；EventSource 只能 GET——token 走 query 是全系统唯一例外）。
 *  聚合：① Gitea 开放 PR 动态（hetu 六仓）② Kimi↔NumX 对话桥最新流 ③ 波次完成态（内置清单）。
 *  纪律：全部有界（3s 超时/截断）；Gitea/桥 token 不出域；失败独立回落空面不炸页。
 */
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";

const GITEA = process.env.GITEA_API_BASE ?? "http://192.0.2.10:3000/api/v1";
const GITEA_AUTH = process.env.GITEA_RO_TOKEN ?? "";
const BRIDGE = process.env.BRIDGE_API_BASE ?? "http://192.0.2.10:3421";
/** **读**令牌（GET `/msg`）：只读用途。
 *  ⚠️ 名字里带 `READ`（门禁 portal#48 R3 的 :31，命名倒挂）：原来这个模块级常量叫 `BRIDGE_TOKEN`，
 *  而"写令牌"却读自**同名环境变量** `BRIDGE_TOKEN` —— 1:1 映射最容易被后来人误读成"就一个令牌"，
 *  然后把读写分离撤销回去。故：常量名对齐语义（`BRIDGE_READ_TOKEN`），环境变量名保持 `BRIDGE_RO_TOKEN` 不动
 *  （部署里已在用，改它会打断现网）。 */
const BRIDGE_READ_TOKEN = process.env.BRIDGE_RO_TOKEN ?? "";
/** **写**令牌（POST `/msg`）——与读令牌**分开**（Kimi 派活 ③，security）：
 *  原来 `BRIDGE_RO_TOKEN` 同时用于 GET(:106/:151) 与 POST(:195)，而桥服务端**没有只读强制**
 *  ⇒ 一个"只读"令牌实测能写 = 口子。现优先取 `BRIDGE_TOKEN`（RW，部署里由 `portal-run.env` 注入，
 *  值运行时从 S4 读、**不落明文**）；未配置时才回落到 RO —— 那种情况下**写仍然会成功**，
 *  所以这是一条**已登记的风险**（台账：portal#47 R?/RO-can-write），不是"已修复"。
 *  ⚠️ 谁要动这里：别把 RW 令牌打印进日志/响应；`reason` 只回粗分类，不回桥的原文。
 *  ⚠️ **回落必须留痕**（门禁 portal#48 R1 的 :22-22，security·medium）：原来这条回落是**静默**的 ——
 *     "读写令牌分离"这个补丁在**最需要它生效的部署场景**（漏配 RW）下会**悄无声息地失效**，很难被发现。
 *     处置：① 回落时 `console.warn` **一次**（只记事、不打印令牌值）；② 响应里带 `tokenTier`，
 *     让"这次写用的到底是哪一档"变成**可观测**的；③ **不 fail-closed**：真 fail-closed（503）会当场
 *     打断彭总的发话功能，而 RW 令牌的注入在部署侧、尚未完成 —— 观测优先，等 RW 到位后这条回落自然不再发生。
 *     （台账：portal#47/RO-can-write；本条的验收口径见 portal#48 回执。）
 *  ⚠️ **档位与取值必须同源**（门禁 portal#48 R2 的 :28，bug·medium）：我第一版令牌用 `??`（只兜 undefined/null）、
 *     档位用真值判断（`""` 也算未配）—— 两套语义在 `BRIDGE_TOKEN=""` 时**互相打架**：档位自称回落，
 *     实际却拿空串去写（必然 401），告警还会把话说反。现统一到**同一个谓词**：空串按"未配置"处理。 */
const RW_BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || ""; // 空串视为未配置（空令牌没有任何用途）
const BRIDGE_POST_TOKEN = RW_BRIDGE_TOKEN || BRIDGE_READ_TOKEN;
/** 回落档位（供响应与日志）：`rw` = 用了写令牌；`ro-fallback` = 回落（桥无只读强制 ⇒ 写仍会成功，已登记风险）。 */
const BRIDGE_TOKEN_TIER: "rw" | "ro-fallback" = RW_BRIDGE_TOKEN ? "rw" : "ro-fallback";
/** 档位**只读探针**（门禁 portal#48 R3 的 :34：这条谓词是安全相关分支、且已回归过一次，必须有单测）。
 *  档位是**模块级常量**（import 时求值）⇒ 单测必须 `vi.resetModules()` + 动态 import 才能覆盖三态；
 *  生产代码不要用它做判断（判断请直接用 `BRIDGE_TOKEN_TIER`）。 */
export function __bridgeTierForTest(): "rw" | "ro-fallback" {
  return BRIDGE_TOKEN_TIER;
}
let warnedRoFallback = false;
/** 回落留痕**单点**（只在首次写操作时告警一次，避免每次发话刷屏）。 */
function warnIfRoFallback(): void {
  if (BRIDGE_TOKEN_TIER === "rw" || warnedRoFallback) return;
  warnedRoFallback = true;
  console.warn("[team-progress] BRIDGE_TOKEN(RW) 未配置 —— POST 回落到只读令牌；桥服务端无只读强制 ⇒ 写仍会成功（已登记风险）。请在 portal-run.env 注入 BRIDGE_TOKEN。");
}
const PROGRESS_TOKEN = process.env.TEAM_PROGRESS_TOKEN ?? ""; // 进度页专用口令（env 600，不落码）

interface PrItem { repo: string; number: number; title: string; state: string; user: string; updatedAt: string }
interface BridgeMsg { id: number; from: string; text: string; ts: string }

/** 波次完成态清单（手工维护——NumX 快照复核后更新） */
const WAVES: { wave: string; items: { code: string; title: string; status: "done" | "wip" | "todo"; note?: string }[] }[] = [
  { wave: "波 0 · 内测闸门（真假边界）", items: [
    { code: "P0-1", title: "v3 双页登录闸", status: "done" }, { code: "P0-2", title: "动态水印", status: "done" },
    { code: "P0-3", title: "去我司化", status: "done" }, { code: "P0-4", title: "TEST 残留清", status: "done" },
    { code: "P0-5", title: "资金 UI 收敛", status: "done" }, { code: "P0-6", title: "四勾真读数", status: "done" },
    { code: "P0-7", title: "文案下线", status: "done" },
  ]},
  { wave: "波 1 · 超终拍板台化", items: [
    { code: "P1-1", title: "拍板台首屏", status: "done" }, { code: "P1-2", title: "导航三层折叠", status: "done" },
    { code: "P1-3", title: "terminal.ts 拆域", status: "done" }, { code: "P1-4", title: "深健康端点", status: "done" },
  ]},
  { wave: "波 2 · 数据真件化", items: [
    { code: "P2-1", title: "v3 双页真件化", status: "done" }, { code: "P2-2", title: "舱面单源", status: "done" },
    { code: "P2-3", title: "注册双口统一", status: "done" }, { code: "P2-4", title: "77 pending AI 初审", status: "done" },
    { code: "P2-5", title: "运营舱主官任命", status: "todo", note: "等彭总亲点" },
    { code: "P2-6", title: "意图信号接通", status: "done", note: "已合并部署实证" },
    { code: "P2-7", title: "APP⇄个人台对齐", status: "todo" },
    { code: "P2-8", title: "精灵上岗三件套", status: "done", note: "第一刀已上线" },
    { code: "P2-9", title: "声纹注册＋G1", status: "todo" },
    { code: "P2-10", title: "主动链传动轴", status: "todo" },
  ]},
  { wave: "波 3 · DSH 底座", items: [
    { code: "P3-1", title: "能力总线 /api/mcp", status: "todo" }, { code: "P3-2", title: "dsh-plugin-numx 骨架", status: "todo" },
    { code: "P3-3", title: "AGENTS.md 落仓", status: "done" }, { code: "P3-4", title: "组织级 DSH 桌面端", status: "todo", note: "彭总" },
    { code: "P3-5", title: "工位池 rc5→rc.2", status: "todo" }, { code: "P3-6", title: "authToken hash 化", status: "todo" },
    { code: "P3-7", title: "七段闭环", status: "todo" }, { code: "P3-8", title: "声纹 G2/G3", status: "todo" },
  ]},
];

/** 进度页口令校验（X-Progress-Token 头优先、query 兜底[SSE 例外]） */
function readProgressToken(c: Context): string {
  return c.req.header("x-progress-token") ?? c.req.query("token") ?? "";
}

function gate(c: Context): boolean {
  const t = readProgressToken(c);
  return Boolean(PROGRESS_TOKEN) && t === PROGRESS_TOKEN; // 常量比对（低权只读面；timing 面不在本面威胁模型）
}

async function fetchJson(url: string, headers: Record<string, string>, timeoutMs = 3000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 桥消息形状校验+截断单点（JSON 面+SSE 面同引） */
function mapBridgeMsg(m: unknown): BridgeMsg | null {
  if (!m || typeof m !== "object") return null;
  const r = m as { id?: unknown; from?: unknown; text?: unknown; ts?: unknown };
  if (typeof r.id !== "number" || typeof r.from !== "string" || typeof r.ts !== "string") return null;
  return { id: r.id, from: r.from, text: typeof r.text === "string" ? r.text.slice(0, 500) : "", ts: r.ts };
}

/** Gitea 开放 PR 拉取单点 */
async function fetchOpenPrs(): Promise<PrItem[]> {
  const repos = ["wb", "portal", "mobile", "pool", "ocr-gate", "dshlink"];
  const prLists = await Promise.all(
    repos.map((r) => fetchJson(`${GITEA}/repos/hetu/${r}/pulls?state=open&limit=5&sort=recentupdate`, { authorization: GITEA_AUTH })),
  );
  const openPrs: PrItem[] = [];
  repos.forEach((r, i) => {
    const list = prLists[i];
    if (Array.isArray(list)) {
      for (const p of list as { number: number; title: string; state: string; user?: { login: string }; updated_at: string }[]) {
        openPrs.push({ repo: r, number: p.number, title: p.title, state: p.state, user: p.user?.login ?? "-", updatedAt: p.updated_at });
      }
    }
  });
  openPrs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return openPrs.slice(0, 12);
}

export async function teamProgressHandler(c: Context): Promise<Response> {
  if (!gate(c)) return c.json({ error: "unauthorized" }, 401);

  const [openPrs, bridgeRaw] = await Promise.all([
    fetchOpenPrs(),
    fetchJson(`${BRIDGE}/msg?after=0`, { "X-Bridge-Token": BRIDGE_READ_TOKEN }),
  ]);
  const bridgeMsgs: BridgeMsg[] = [];
  if (bridgeRaw && typeof bridgeRaw === "object" && Array.isArray((bridgeRaw as { messages?: unknown[] }).messages)) {
    for (const m of (bridgeRaw as { messages: unknown[] }).messages.slice(-12)) {
      const v = mapBridgeMsg(m);
      if (v) bridgeMsgs.push(v);
    }
  }
  return c.json({ ok: true, ts: new Date().toISOString(), openPrs, bridge: bridgeMsgs, waves: WAVES });
}

/** SSE 实时流（彭总令「我要的是实时的」）：桥消息 2s 增量即推/PR 面 10s 比对/心跳 25s/断连清理 */
export async function teamProgressStreamHandler(c: Context): Promise<Response> {
  if (!gate(c)) return c.json({ error: "unauthorized" }, 401);
  c.header("X-Accel-Buffering", "no");
  c.header("Cache-Control", "no-cache, no-transform");
  const abort = c.req.raw.signal;
  return streamSSE(c, async (stream) => {
    let lastBridgeId = 0;
    let lastPrSig = "";
    let lastWaveSig = "";
    let stopped = false;
    const onAbort = (): void => { stopped = true; };
    abort.addEventListener("abort", onAbort);
    try {
      const firstBridge = await fetchJson(`${BRIDGE}/msg?after=0`, { "X-Bridge-Token": BRIDGE_READ_TOKEN });
      if (firstBridge && typeof firstBridge === "object" && Array.isArray((firstBridge as { messages?: unknown[] }).messages)) {
        const msgs = (firstBridge as { messages: unknown[] }).messages.map(mapBridgeMsg).filter((m): m is BridgeMsg => m !== null);
        if (msgs.length) lastBridgeId = msgs[msgs.length - 1].id;
        await stream.writeSSE({ event: "bridge", data: JSON.stringify(msgs.slice(-12)) });
      }
      const prs0 = await fetchOpenPrs();
      lastPrSig = JSON.stringify(prs0);
      lastWaveSig = JSON.stringify(WAVES);
      await stream.writeSSE({ event: "prs", data: lastPrSig });
      await stream.writeSSE({ event: "waves", data: lastWaveSig });
      await stream.writeSSE({ event: "ready", data: JSON.stringify({ ts: new Date().toISOString() }) });

      let ticks = 0;
      let lastPingAt = Date.now();
      while (!stopped) {
        await new Promise((r) => setTimeout(r, 2000));
        if (stopped) break;
        ticks++;
        const inc = await fetchJson(`${BRIDGE}/msg?after=${lastBridgeId}`, { "X-Bridge-Token": BRIDGE_READ_TOKEN });
        if (inc && typeof inc === "object" && Array.isArray((inc as { messages?: unknown[] }).messages)) {
          const msgs = (inc as { messages: unknown[] }).messages;
          if (msgs.length) {
            const mapped = msgs.map(mapBridgeMsg).filter((m): m is BridgeMsg => m !== null);
            if (mapped.length) {
              lastBridgeId = mapped[mapped.length - 1].id;
              await stream.writeSSE({ event: "bridge", data: JSON.stringify(mapped) });
            }
          }
        }
        if (ticks % 5 === 0) {
          const prs = await fetchOpenPrs();
          const sig = JSON.stringify(prs);
          if (sig !== lastPrSig) { lastPrSig = sig; await stream.writeSSE({ event: "prs", data: sig }); }
        }
        if (ticks % 30 === 0) {
          const sig = JSON.stringify(WAVES);
          if (sig !== lastWaveSig) { lastWaveSig = sig; await stream.writeSSE({ event: "waves", data: sig }); }
        }
        if (Date.now() - lastPingAt >= 25_000) { // 时间戳心跳（不随循环 tick 漂移）
          lastPingAt = Date.now();
          await stream.writeSSE({ event: "ping", data: String(lastPingAt) });
        }
      }
    } finally {
      abort.removeEventListener("abort", onAbort);
    }
  });
}

/** 彭总发话上桥（彭总令：一个工作页面直接联通 Kimi 和 NumX）——POST /api/team-progress/say {text}
 *  进度页口令鉴权同面；服务端转发桥（from:'peng'）——桥 token 不出域（前端只见 ok）。 */
export async function teamProgressSayHandler(c: Context): Promise<Response> {
  if (!gate(c)) return c.json({ error: "unauthorized" }, 401);
  let text = "";
  try {
    const body = await c.req.json<{ text?: string }>();
    text = (body.text ?? "").trim().slice(0, 800);
  } catch { return c.json({ ok: false, reason: "bad_request" }, 400); }
  if (!text) return c.json({ ok: false, reason: "empty" }, 400);
  warnIfRoFallback(); // 回落留痕（门禁 portal#48 R1 的 :22：静默回落会在最需要它的场景下悄悄失效）
  try {
    const r = await fetch(`${BRIDGE}/msg`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Bridge-Token": BRIDGE_POST_TOKEN },
      body: JSON.stringify({ from: "peng", text }),
    });
    if (!r.ok) return c.json({ ok: false, reason: "bridge_error" }, 502);
    const d = (await r.json()) as { ok?: boolean; id?: number };
    // 把"这次写用的是哪一档令牌"一并回给前端（可观测）：前端可据此提示，运维也可从响应面发现漏配。
    return c.json({ ok: true, id: d.id, tokenTier: BRIDGE_TOKEN_TIER });
  } catch {
    return c.json({ ok: false, reason: "bridge_unreachable" }, 502);
  }
}
