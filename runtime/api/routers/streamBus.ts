/**
 * streamBus —— M8-c 流式输出 + M9-a 事件驱动主动播报总线。
 *
 * 两个 SSE 端点（注册于 boot.ts，registerWechatCallback 之后、/api/* 404 兜底之前）：
 *
 * 1. GET /api/stream/duty-chat?token=&message=（M8-c）
 *    EventSource 只能发 GET，token 走 query 是全系统唯一例外；
 *    token 绝不落日志（本文件无任何 console 输出该路径入参）。
 *    帧序：facts（collectPlatformBrief 真实数据要点，同步先推）
 *        → delta*（callSlotChatFast flash 回复按标点切段打字机逐段推，段间隔 30-60ms；
 *          LLM 网关本身是非流式协议，这里只在传输侧切片，不伪造流式响应）
 *        → done {degraded, truncated}；LLM 异常 → error 帧（facts 已送达）+ done(degraded:true)。
 *    每帧 delta 过 stripSecrets；整段回复切片前也先过一次（防敏感串跨段逃逸）。
 *
 * 2. GET /api/stream/events?token=（M9-a）
 *    sessionMe 鉴权后订阅广播总线：role=admin 收全局；企业号（owner/member 等）只收本厂
 *    factory_id 事件。30 秒注释心跳（": hb"）防反代断连；连接断开立即摘除 listener 防泄漏。
 *    事件源：gate 执行成功 / emitSignal 新信号 → publishBroadcast（fire-and-forget）。
 *    帧格式：event: broadcast + data: {factoryId, level, persona, title, at}；
 *    title 发布时过 stripSecrets；persona 沿用 voice.ts 规则（C→lingshu，B→xingyun，
 *    其余等级不播报）。
 *
 * 进程内 EventEmitter 单实例广播；三端各自实例，DB 轮询（30s）保留作 SSE 断线降级。
 */
import { EventEmitter } from "node:events";
import { TRPCError } from "@trpc/server";
import type { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { streamSSE } from "hono/streaming";
import { sessionMe } from "./wbSession";
import { stripSecrets } from "./voice";
import type { CallOpts, LlmCallResult } from "./modelGateway";

// ─── M9-a 进程内广播总线 ─────────────────────────────────────────────────────

/** 主动播报事件（广播帧载荷） */
export interface StreamBroadcast {
  factoryId: number;
  level: string;
  persona: "lingshu" | "xingyun";
  title: string;
  at: string;
}

const bus = new EventEmitter();
// SSE 连接数即 listener 数，单进程可能远超默认 10；由断连清理保证不泄漏
bus.setMaxListeners(0);

export const BROADCAST_EVENT = "broadcast";

/** persona 规则（与 voice.ts 信号播报表一致）：C→lingshu，B→xingyun，其余等级不播报 */
function personaOf(level: string): "lingshu" | "xingyun" | null {
  if (level === "C") return "lingshu";
  if (level === "B") return "xingyun";
  return null;
}

/**
 * 发布一条主动播报事件（fire-and-forget：同步返回、绝不抛出，主流程零感知）。
 * A/D 级按 persona 规则不播报（D 级走人工通道，不主动推流）。
 */
export function publishBroadcast(evt: { factoryId: number; level: string; title: string; at?: string }): void {
  try {
    const persona = personaOf(String(evt.level));
    if (!persona) return;
    const msg: StreamBroadcast = {
      factoryId: Number(evt.factoryId),
      level: String(evt.level),
      persona,
      title: stripSecrets(String(evt.title)).slice(0, 120),
      at: evt.at ?? new Date().toISOString(),
    };
    bus.emit(BROADCAST_EVENT, msg);
  } catch {
    // 播报是纯旁路，任何异常吞掉，绝不反向影响事件源主流程
  }
}

/** 测试观测用：当前广播订阅者数量（生产代码不得依赖） */
export function broadcastListenerCount(): number {
  return bus.listenerCount(BROADCAST_EVENT);
}

// ─── M8-c duty-chat 流式问答 ────────────────────────────────────────────────

/** 打字机切段间隔（30-60ms 抖动，模拟自然输出节奏） */
const TYPEWRITER_BASE_MS = 30;
const TYPEWRITER_JITTER_MS = 10;
/** 流式回复字符上限（超出截断并在 done 帧标注 truncated） */
const DUTY_CHAT_MAX_REPLY = 2000;

/** 与 adminAi.DUTY_PERSONA 同一套人格文案（adminAi 未导出，改动时需同步） */
const STREAM_DUTY_PERSONA =
  "你是灵枢，NumX Max 平台的值守参谋长，在 S3 超级终端为平台管理员值班。" +
  "风格：沉稳、简短、先结论后依据，军事化早报口吻（晨报分『待办/风险/建议』三段）。" +
  "只引用给定实况数据，禁止编造；回复绝不出现任何编号类敏感串。";

/** flash 槽竞速（M8-a 成果）；双败/熔断全开 → 回落原顺序链路（与 adminAi.callFlash 同策略） */
async function callFlash(opts: CallOpts): Promise<LlmCallResult> {
  const gw = await import("./modelGateway");
  try {
    const r = await gw.callSlotChatFast("flash", opts);
    return r as unknown as LlmCallResult;
  } catch {
    return gw.callSlotChat("flash", opts);
  }
}

/** 按标点边界把回复切成打字机小段（碎片合并到 ≥8 字符，避免单字帧刷屏） */
export function chunkForTypewriter(text: string): string[] {
  if (!text) return [];
  const frags = text.split(/(?<=[。！？；，、,.!?;:\n])/).filter((f) => f.length > 0);
  const chunks: string[] = [];
  let buf = "";
  for (const f of frags) {
    buf += f;
    if (buf.length >= 8) {
      chunks.push(buf);
      buf = "";
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

/** 心跳用 sleep（unref：挂起的计时器绝不拖住进程退出） */
function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as unknown as { unref?: () => void }).unref?.();
  });
}

// ─── M60 语音对话真流式（句级切段）──────────────────────────────────────────

/**
 * 句级切段器：增量喂入文本，标点（。！？；，、,.!?;:换行）闭合的完整句段立即切出，
 * 未闭合尾巴滞留到 flush。供「边想边说」逐句 TTS：完整句一到就发，不等全量回复。
 */
export class SentenceCutter {
  private buf = "";

  /** 喂入增量文本，返回本次闭合出的完整句段（0..n 段） */
  feed(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    // 找最后一个句读位置：之前的部分都是已闭合完整句
    let cut = -1;
    for (let i = 0; i < this.buf.length; i++) {
      if ("。！？；，、,.!?;:\n".includes(this.buf[i])) cut = i;
    }
    if (cut >= 0) {
      const head = this.buf.slice(0, cut + 1);
      this.buf = this.buf.slice(cut + 1);
      // 按标点边界再细分，碎片攒到 ≥4 字才成帧；不足量的尾段回留缓冲区（绝不提前吐出）
      const frags = head.split(/(?<=[。！？；，、,.!?;:\n])/).filter((f) => f.length > 0);
      let acc = "";
      for (const f of frags) {
        acc += f;
        if (acc.length >= 4) {
          out.push(acc);
          acc = "";
        }
      }
      if (acc) this.buf = acc + this.buf;
    }
    return out;
  }

  /** 收尾：吐出滞留尾巴（无内容返回 null） */
  flush(): string | null {
    const tail = this.buf;
    this.buf = "";
    return tail.length > 0 ? tail : null;
  }
}

// ─── 端点注册 ────────────────────────────────────────────────────────────────

/** SSE 事件流心跳间隔（防 nginx/反代空闲断连） */
export const SSE_HEARTBEAT_MS = 30_000;

export function registerStreamEndpoints(app: Hono<{ Bindings: HttpBindings }>): void {
  // M8-c：值守台追问流式输出（facts 先答 → delta 打字机 → done）
  app.get("/api/stream/duty-chat", async (c) => {
    const token = (c.req.query("token") ?? "").trim();
    const message = (c.req.query("message") ?? "").trim();
    if (!token || !message || message.length > 500) {
      return c.json({ error: "参数缺失或 message 过长" }, 400);
    }
    try {
      // H1 修复：duty-chat 聚合全平台数据（沉默企业名单等跨租户信息），必须 requireAdmin，
      // 与 tRPC adminAi.dutyChat 同一鉴权强度；企业号/成员一律 401
      const { requireAdmin } = await import("./terminal");
      await requireAdmin(token);
    } catch {
      return c.json({ error: "需要管理员权限" }, 401);
    }
    c.header("X-Accel-Buffering", "no"); // nginx 反代关缓冲，SSE 实时直达
    c.header("Cache-Control", "no-cache");
    return streamSSE(c, async (stream) => {
      // 先答：真实数据要点同步先行（LLM 可用性无关）；实况聚合失败时退化为空 facts，不阻断回答
      let context = "【平台实况】暂缺（聚合不可用），请基于通用值守原则回答。";
      try {
        const { collectPlatformBrief, briefToContext, briefToFacts } = await import("./adminAi");
        const brief = await collectPlatformBrief();
        context = briefToContext(brief);
        await stream.writeSSE({ event: "facts", data: JSON.stringify({ facts: briefToFacts(brief) }) });
      } catch {
        await stream.writeSSE({ event: "facts", data: JSON.stringify({ facts: [] }) });
      }
      if (stream.aborted) return;
      // 后想：LLM 解读。v168 真流式（stream:true 逐 token 直推，首字 1s 级）；
      // 流式未吐字即失败 → 回落原「非流式+打字机」链路（行为与 v167 前完全一致）
      const dutyMsgs = [
        { role: "system" as const, content: STREAM_DUTY_PERSONA },
        { role: "user" as const, content: `${context}\n管理员问：「${message}」\n请回答（先结论后依据，不超过 200 字）。` },
      ];
      try {
        const { callSlotChatStream } = await import("./modelGateway");
        let streamed = 0;
        let acc = "";
        const rs = await callSlotChatStream("flash", {
          messages: dutyMsgs,
          maxTokens: 500,
          temperature: 0.5,
          // v168 流式棒交 DeepSeek Flash（kimi-k3 流式 30s 卡死实锤）；12s 超时快降级
          modelOverride: "deepseek-v4-flash",
          timeoutMs: 12_000,
          context: "duty_chat_stream",
        }, (delta) => {
          // 边收边推（帧契约为增量片段，前端追加；与 v167 前 delta 语义完全一致）
          acc += delta;
          if (acc.length > DUTY_CHAT_MAX_REPLY) return; // 超限段丢弃，done 标 truncated
          streamed = acc.length;
          void stream.writeSSE({ event: "delta", data: JSON.stringify({ text: stripSecrets(delta) }) }).catch(() => undefined);
        });
        if (rs.ok && streamed > 0) {
          const truncated = acc.length > DUTY_CHAT_MAX_REPLY;
          await stream.writeSSE({ event: "done", data: JSON.stringify({ degraded: false, truncated, streamed: true, firstTokenMs: rs.firstTokenMs }) });
        } else if (streamed > 0) {
          // 吐过字后断流：已推内容有效，如实标 degraded
          await stream.writeSSE({ event: "done", data: JSON.stringify({ degraded: true, truncated: false, streamed: true }) });
        } else {
          throw new Error(String(rs.reason ?? "stream_unavailable"));
        }
      } catch {
        // 回落：非流式全量 → 打字机切段（v167 前行为原样）
        try {
          const r = await callFlash({ messages: dutyMsgs, maxTokens: 500, temperature: 0.5, timeoutMs: 45_000 });
          if (!r.ok) throw new Error(String((r as { reason?: string }).reason ?? "llm_unavailable"));
          const cleaned = stripSecrets(String((r as { content?: string }).content ?? "").trim());
          const truncated = cleaned.length > DUTY_CHAT_MAX_REPLY;
          const text = truncated ? cleaned.slice(0, DUTY_CHAT_MAX_REPLY) : cleaned;
          let i = 0;
          for (const chunk of chunkForTypewriter(text)) {
            if (stream.aborted) return;
            await stream.writeSSE({ event: "delta", data: JSON.stringify({ text: stripSecrets(chunk) }) });
            await stream.sleep(TYPEWRITER_BASE_MS + (i % 4) * TYPEWRITER_JITTER_MS);
            i += 1;
          }
          await stream.writeSSE({ event: "done", data: JSON.stringify({ degraded: false, truncated }) });
        } catch {
          // LLM 故障：facts 已送达，发 error 帧并以 done(degraded) 收尾，前端据此走降级展示
          await stream.writeSSE({ event: "error", data: JSON.stringify({ message: "值守线路有点杂音，请稍后再问" }) });
          await stream.writeSSE({ event: "done", data: JSON.stringify({ degraded: true, truncated: false }) });
        }
      }
    });
  });

  // v168：assistant.ask 真流式（小星/工作台问答首字 1s 级；greeting/handoff/device 意图确定性直通即回）
  // 帧序：delta*（增量片段，前端追加）→ done {answer, suggestions, links, speak, intent, llmUsed, generatedBy, streamed, firstTokenMs, degraded}
  // 失败纪律：流式未吐字失败 → askWithLlmStream 内自动回落非流式全链；仍败 → error 帧 + done(degraded)。token 走 query（同 duty-chat 例外口径，不落日志）。
  app.get("/api/stream/assistant-ask", async (c) => {
    const token = (c.req.query("token") ?? "").trim();
    const message = (c.req.query("message") ?? "").trim();
    const path = (c.req.query("path") ?? "").trim() || undefined;
    const sessionId = (c.req.query("sessionId") ?? "").trim() || undefined;
    if (!message || message.length > 500) {
      return c.json({ error: "参数缺失或 message 过长" }, 400);
    }
    c.header("X-Accel-Buffering", "no");
    c.header("Cache-Control", "no-cache");
    return streamSSE(c, async (stream) => {
      const {
        resolveIdentity, loadStats, loadCsConfig, routeIntent, buildAnswer,
        recallXingxingMemories, askWithLlmStream, recordCsAsk, rememberXingxing, dispatchDeviceIntent,
      } = await import("./assistant");
      const t0 = Date.now();
      const identity = await resolveIdentity(token || undefined);
      const stats = await loadStats();
      const cs = await loadCsConfig();
      const intent = routeIntent(message);
      const log = (answer: string) =>
        recordCsAsk({ sessionId, ip: "", ua: "", userContent: message, intent, botContent: answer });

      // device 意图：B 级真下发/C 级引导（确定性，不问模型）
      if (intent === "device" && identity) {
        const r = await dispatchDeviceIntent(message, identity.factoryId);
        if (r) {
          log(r.answer);
          await stream.writeSSE({ event: "done", data: JSON.stringify({ ...r, streamed: false, degraded: false }) });
          return;
        }
      }
      // greeting / handoff：确定性直通即回（与 ask mutation 同一口径）
      if (intent === "greeting" || intent === "handoff") {
        const r = buildAnswer(intent, identity, stats, cs);
        log(r.answer);
        rememberXingxing(identity, message, r.answer);
        await stream.writeSSE({ event: "done", data: JSON.stringify({ ...r, llmUsed: false, generatedBy: null, streamed: false, degraded: false }) });
        return;
      }
      // 其余意图：真流式 LLM
      const memories = await recallXingxingMemories(identity);
      let firstDeltaAt = 0;
      const llm = await askWithLlmStream(message, intent, identity, stats, path, cs, memories, (delta) => {
        if (!firstDeltaAt) firstDeltaAt = Date.now() - t0;
        void stream.writeSSE({ event: "delta", data: JSON.stringify({ text: stripSecrets(delta) }) }).catch(() => undefined);
      });
      if (llm) {
        log(llm.answer);
        rememberXingxing(identity, message, llm.answer);
        await stream.writeSSE({ event: "done", data: JSON.stringify({ ...llm, degraded: false, firstTokenMs: firstDeltaAt || llm.firstTokenMs }) });
      } else {
        const fallback = { ...buildAnswer(intent, identity, stats, cs), llmUsed: false, generatedBy: null };
        log(fallback.answer);
        rememberXingxing(identity, message, fallback.answer);
        await stream.writeSSE({ event: "error", data: JSON.stringify({ message: "回答线路有点杂音，已切换标准应答" }) });
        await stream.writeSSE({ event: "done", data: JSON.stringify({ ...fallback, streamed: false, degraded: true }) });
      }
    });
  });

  // M78c：跨部门委派流式（delegate 长任务不再黑等——即时回执+心跳保活+打字机回放）
  // 帧序：accepted（受理回执，双方主官/运行轨）→ 心跳注释（15s，LLM 执行期间）
  //     → delta*（回执全文传输侧切段打字机；DSH/bridge 为非流式协议，不伪造流式响应）
  //     → done {collabId, runtime, ms, degraded}；异常 → error 帧 + done(degraded:true)。
  // 鉴权与 deptConsole.delegate 同强度（requireAdmin）；token 走 query 与 duty-chat 同例外口径。
  app.get("/api/stream/dept-delegate", async (c) => {
    const token = (c.req.query("token") ?? "").trim();
    const fromDept = (c.req.query("fromDept") ?? "").trim();
    const toDept = (c.req.query("toDept") ?? "").trim();
    const message = (c.req.query("message") ?? "").trim();
    if (!token || !fromDept || !toDept || !message || message.length > 2000) {
      return c.json({ error: "参数缺失或 message 过长" }, 400);
    }
    const { DEPT_CODES } = await import("./deptConsole");
    if (!(DEPT_CODES as readonly string[]).includes(fromDept) || !(DEPT_CODES as readonly string[]).includes(toDept)) {
      return c.json({ error: "部门代码非法" }, 400);
    }
    try {
      const { requireAdmin } = await import("./terminal");
      await requireAdmin(token);
    } catch {
      return c.json({ error: "需要管理员权限" }, 401);
    }
    c.header("X-Accel-Buffering", "no");
    c.header("Cache-Control", "no-cache");
    return streamSSE(c, async (stream) => {
      const t0 = Date.now();
      await stream.writeSSE({ event: "accepted", data: JSON.stringify({ fromDept, toDept }) });
      // 长任务保活：执行期间每 15s 注释心跳（F5 教训——60s+ 黑等是反代截断元凶）
      const task = (async () => {
        const { runDeptDelegate } = await import("./deptConsole");
        return runDeptDelegate({
          fromDept: fromDept as (typeof DEPT_CODES)[number],
          toDept: toDept as (typeof DEPT_CODES)[number],
          message,
          username: "sse-delegate",
        });
      })();
      let settled = false;
      task.then(() => { settled = true; }, () => { settled = true; });
      while (!settled) {
        // 心跳等待与任务竞速——任务先落地立即出闸，绝不白睡一个心跳周期
        await Promise.race([sleepMs(DELEGATE_HB_MS), task.then(() => undefined, () => undefined)]);
        if (stream.aborted) return;
        if (!settled) await stream.writeln(": hb");
      }
      try {
        const r = await task;
        if (stream.aborted) return;
        const reply = stripSecrets(String(r.reply ?? ""));
        let i = 0;
        for (const chunk of chunkForTypewriter(reply)) {
          if (stream.aborted) return;
          await stream.writeSSE({ event: "delta", data: JSON.stringify({ text: stripSecrets(chunk) }) });
          await stream.sleep(TYPEWRITER_BASE_MS + (i % 4) * TYPEWRITER_JITTER_MS);
          i += 1;
        }
        await stream.writeSSE({
          event: "done",
          data: JSON.stringify({ collabId: r.collabId, runtime: r.runtime, ms: Date.now() - t0, degraded: false }),
        });
      } catch (e) {
        const msg = e instanceof TRPCError ? e.message : "协作线路有点杂音，请稍后再试";
        await stream.writeSSE({ event: "error", data: JSON.stringify({ message: stripSecrets(msg).slice(0, 120) }) });
        await stream.writeSSE({ event: "done", data: JSON.stringify({ degraded: true }) });
      }
    });
  });

  // M60：NumX Max APP 语音对话真流式（边想边说）
  // 帧序：delta*（句级切段，完整句一到就推，逐句 TTS 不整段等）
  //     → emotion（全量 JSON 落定后解析，流式中段不猜情绪）
  //     → done {reply, emotion, rate, pitch, streamed, degraded}；
  // 记忆指令（记住/忘掉）与 voiceBuddy.chat 同一实现分流，直接 reply+done；
  // LLM 全败 → error 帧 + done(degraded:true) 人格化兜底（与 chat 兜底话术一致）。
  // 鉴权同 voiceBuddy.chat（sessionMe，wb 登录用户）；token 走 query 与 duty-chat 同例外口径。
  app.get("/api/stream/voice-chat", async (c) => {
    const token = (c.req.query("token") ?? "").trim();
    const personaRaw = (c.req.query("persona") ?? "lingshu").trim();
    const message = (c.req.query("message") ?? "").trim();
    if (!token || !message || message.length > 500) {
      return c.json({ error: "参数缺失或 message 过长" }, 400);
    }
    if (personaRaw !== "lingshu" && personaRaw !== "xingyun") {
      return c.json({ error: "persona 非法" }, 400);
    }
    const persona = personaRaw;
    let username: string;
    let factoryId: number;
    try {
      const { user, factory } = await sessionMe(token);
      username = String(user.username);
      factoryId = Number(factory.id);
    } catch {
      return c.json({ error: "token 无效或已过期" }, 401);
    }
    c.header("X-Accel-Buffering", "no"); // nginx 反代关缓冲，SSE 实时直达
    c.header("Cache-Control", "no-cache");
    return streamSSE(c, async (stream) => {
      // 有序帧队列：增量回调是同步的，writeSSE 串行化防帧交错
      let chain: Promise<unknown> = Promise.resolve();
      const push = (event: string, data: unknown): void => {
        chain = chain.then(() =>
          stream.aborted ? undefined : stream.writeSSE({ event, data: JSON.stringify(data) }),
        );
      };
      try {
        const vb = await import("./voiceBuddy");
        // 记忆指令分流（与 voiceBuddy.chat 逐字同一实现）
        const memReply = await vb.handleMemoryCommand(persona, message, factoryId, username);
        if (memReply) {
          push("delta", { text: stripSecrets(memReply.reply) });
          push("done", { ...memReply, reply: stripSecrets(memReply.reply), streamed: false, degraded: false });
          await chain;
          return;
        }
        // 正常对话：组织实况 + 记忆注入（与 chat 同口径）
        const brief = await vb.buildOrgBrief(factoryId);
        const mems = await vb.loadMemories(factoryId, username);
        const cutter = new SentenceCutter();
        const result = await vb.generateBuddyReplyStream(
          persona,
          `${vb.briefToText(brief)}\n老板说：「${message}」`,
          vb.memoriesToText(mems),
          (delta) => {
            for (const seg of cutter.feed(delta)) push("delta", { text: stripSecrets(seg) });
          },
        );
        const tail = cutter.flush();
        if (tail) push("delta", { text: stripSecrets(tail) });
        push("emotion", { emotion: result.emotion, rate: result.rate, pitch: result.pitch });
        push("done", {
          reply: stripSecrets(result.reply),
          emotion: result.emotion,
          rate: result.rate,
          pitch: result.pitch,
          streamed: result.streamed,
          degraded: result.degraded,
        });
        await chain;
      } catch {
        // LLM/库全链路故障：人格化兜底收口（与 chat 的 FALLBACK_REPLY 同文案）
        try {
          const vb = await import("./voiceBuddy");
          const fallback = vb.parseBuddyJson(null, persona);
          push("error", { message: "线路有点杂音，这次先凭经验答" });
          push("done", {
            reply: fallback.reply,
            emotion: fallback.emotion,
            rate: 1.0,
            pitch: 1.0,
            streamed: false,
            degraded: true,
          });
          await chain;
        } catch {
          /* 兜底模块都不可用时让流自然关闭 */
        }
      }
    });
  });

  // M60：NumX Max APP utterance 真流式（与 tRPC voice.utterance 同一 runUtterance 核心）
  // 帧序：chat 分支 delta*（句级切段边收边推）→ done {result: 与 voice.utterance 全同构响应}；
  // 非 chat 分支（意图/技能/派单/设备/引导/记忆/人格换岗）无增量，done 一帧整段收口；
  // 鉴权/会话异常 → error 帧（code=TRPC code）后关流，APP 落回原非流式链路（行为不变）。
  app.get("/api/stream/utterance", async (c) => {
    const token = (c.req.query("token") ?? "").trim();
    const text = (c.req.query("text") ?? "").trim();
    const sessionId = Number(c.req.query("sessionId") ?? "");
    const confidenceRaw = c.req.query("confidence");
    const asrConfidence = confidenceRaw != null && confidenceRaw !== "" ? Number(confidenceRaw) : undefined;
    if (!token || !text || text.length > 500 || !Number.isInteger(sessionId) || sessionId <= 0) {
      return c.json({ error: "参数缺失或非法" }, 400);
    }
    if (asrConfidence !== undefined && !(asrConfidence >= 0 && asrConfidence <= 1)) {
      return c.json({ error: "confidence 非法" }, 400);
    }
    try {
      await sessionMe(token);
    } catch {
      return c.json({ error: "token 无效或已过期" }, 401);
    }
    c.header("X-Accel-Buffering", "no"); // nginx 反代关缓冲，SSE 实时直达
    c.header("Cache-Control", "no-cache");
    return streamSSE(c, async (stream) => {
      // 有序帧队列：增量回调同步触发，writeSSE 串行化防帧交错
      let chain: Promise<unknown> = Promise.resolve();
      const push = (event: string, data: unknown): void => {
        chain = chain.then(() =>
          stream.aborted ? undefined : stream.writeSSE({ event, data: JSON.stringify(data) }),
        );
      };
      try {
        const { runUtterance } = await import("./voice");
        const cutter = new SentenceCutter();
        const result = await runUtterance(
          { token, sessionId, text, asrConfidence },
          {
            onChatReplyDelta: (delta) => {
              for (const seg of cutter.feed(delta)) push("delta", { text: stripSecrets(seg) });
            },
          },
        );
        const tail = cutter.flush();
        if (tail) push("delta", { text: stripSecrets(tail) });
        push("done", { result });
        await chain;
      } catch (e) {
        // 会话失效/库故障：error 帧收口，APP 落回原 voice.utterance 链路（同一错误语义）
        const code = e instanceof TRPCError ? e.code : "INTERNAL_SERVER_ERROR";
        push("error", { message: "utterance 流式链路异常", code });
        await chain;
      }
    });
  });

  // M9-a：事件驱动主动播报订阅（admin 全局 / 企业号本厂隔离）
  app.get("/api/stream/events", async (c) => {
    const token = (c.req.query("token") ?? "").trim();
    if (!token) return c.json({ error: "参数缺失" }, 400);
    let factoryFilter: number | null;
    try {
      const { user, factory } = await sessionMe(token);
      factoryFilter = String(user.role) === "admin" ? null : Number(factory.id);
    } catch {
      return c.json({ error: "token 无效或已过期" }, 401);
    }
    c.header("X-Accel-Buffering", "no"); // nginx 反代关缓冲，SSE 实时直达
    c.header("Cache-Control", "no-cache");
    return streamSSE(c, async (stream) => {
      const listener = (msg: StreamBroadcast) => {
        if (factoryFilter !== null && msg.factoryId !== factoryFilter) return; // 企业号只收本厂
        void stream.writeSSE({
          event: "broadcast",
          data: JSON.stringify({
            factoryId: msg.factoryId,
            level: msg.level,
            persona: msg.persona,
            title: msg.title,
            at: msg.at,
          }),
        });
      };
      bus.on(BROADCAST_EVENT, listener);
      // 断连立即摘除 listener 防泄漏（finally 兜底双保险，重复 remove 无副作用）
      stream.onAbort(() => {
        bus.removeListener(BROADCAST_EVENT, listener);
      });
      try {
        while (!stream.aborted) {
          await sleepMs(SSE_HEARTBEAT_MS);
          if (stream.aborted) break;
          await stream.writeln(": hb"); // SSE 注释心跳，防反代空闲断连
        }
      } finally {
        bus.removeListener(BROADCAST_EVENT, listener);
      }
    });
  });
}

// ─── M78c 跨部门委派流式（彭总拍板 delegate 流式化 2026-08-23）────────────────
// 挂载于 registerStreamEndpoints 内（见下）；本区为共用常量。
/** 委派执行心跳间隔（LLM 长任务期间保活，防反代空闲断连） */
export const DELEGATE_HB_MS = 15_000;
