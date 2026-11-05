/**
 * voiceMedia —— M40 云端语音双引擎：服务端 ASR + 服务端 TTS。
 *
 * 动因（彭总 2026-08-14 实测投诉）：APP 语音在他手机上不能识别、没有播报，
 * 只剩按钮和打字——端侧 sherpa 在部分国产 ROM 上起不来，expo-speech 依赖系统
 * TTS 引擎（多数国产 ROM 无中文引擎）。AI 原生答卷：识别和播报收归云端，
 * 端上只留麦和喇叭，任何手机都可用。
 *
 * voice.asr：base64 音频（m4a/amr/wav）→ ffmpeg 解码 16k s16le → sherpa-onnx
 *   流式 zipformer（热词模型同端侧资产）→ mishearCorrect 确定性误听归一
 *   （热词在该 node 绑定版本实测不生效，归一表是生产+实验室双实证的可靠层）→
 *   返回 {text, rawText, durationMs}。
 * voice.tts：{text, persona} → sha256 缓存命中直回 → miss 走 agent-gw
 *   generate_speech（灵枢=沉稳男声 05Cd…，星云=温暖女声 NLl7…）→ mp3 落
 *   dist/public/tts/ → {url}。TTS 失败/超时 → ok:false（APP 回落端侧 expo-speech）。
 *
 * 安全纪律：
 * - 登录态（sessionMe）+ 音频 2.5MB/45s 双顶 + 文本 120 字顶（播报口径 ≤80 字纪律）；
 * - agent-gw key 仅 env（AGENT_GW_API_KEY/AGENT_GW_BASE），绝不落日志；
 * - TTS 平台日额软顶（默认 3000 次/日，内存计数，防呆不防攻击——攻击面有登录态兜着）；
 * - ffmpeg 子进程 10s 硬顶；音频落 /tmp 即删，绝不持久化用户语音。
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { sessionMe } from "./wbSession";
import { mishearCorrect } from "./mishearMap";
import { sql } from "drizzle-orm";
import { getDb } from "../queries/connection";

// ─── sherpa 单例（懒加载；模型缺失时 asr 明确报不可用，APP 回落端侧） ──────────

interface SherpaRecognizer {
  createStream(): {
    acceptWaveform(w: { samples: Float32Array; sampleRate: number }): void;
    inputFinished(): void;
  };
  isReady(s: unknown): boolean;
  decode(s: unknown): void;
  getResult(s: unknown): { text: string };
}

let recognizerSingleton: SherpaRecognizer | null | undefined;

function asrModelDir(): string {
  return process.env.ASR_MODEL_DIR || path.resolve(process.cwd(), "data", "asr-model");
}

function getRecognizer(): SherpaRecognizer | null {
  if (recognizerSingleton !== undefined) return recognizerSingleton;
  try {
    // 动态 require：依赖未安装（测试/门户形态）时不影响主链启动
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sherpa = require("sherpa-onnx-node") as { OnlineRecognizer: new (c: unknown) => SherpaRecognizer };
    const dir = asrModelDir();
    const need = ["encoder-epoch-99-avg-1.int8.onnx", "decoder-epoch-99-avg-1.onnx", "joiner-epoch-99-avg-1.int8.onnx", "tokens.txt"];
    if (!need.every((f) => fs.existsSync(path.join(dir, f)))) {
      recognizerSingleton = null;
      return null;
    }
    recognizerSingleton = new sherpa.OnlineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: path.join(dir, "encoder-epoch-99-avg-1.int8.onnx"),
          decoder: path.join(dir, "decoder-epoch-99-avg-1.onnx"),
          joiner: path.join(dir, "joiner-epoch-99-avg-1.int8.onnx"),
        },
        tokens: path.join(dir, "tokens.txt"),
        numThreads: 2,
        provider: "cpu",
        debug: 0,
      },
    });
    return recognizerSingleton;
  } catch {
    recognizerSingleton = null;
    return null;
  }
}

/** ffmpeg 解码任意常见音频 → 16k 单声道 s16le PCM（10s 硬顶，临时文件即删） */
async function decodeToPcm(inputBuf: Buffer, format: string): Promise<Float32Array> {
  const tmpIn = path.join("/tmp", `asr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${format}`);
  const tmpOut = `${tmpIn}.pcm`;
  await fsp.writeFile(tmpIn, inputBuf);
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        "ffmpeg",
        ["-y", "-i", tmpIn, "-ar", "16000", "-ac", "1", "-f", "s16le", tmpOut],
        { timeout: 10_000 },
        (err) => (err ? reject(err) : resolve()),
      );
    });
    const pcm = await fsp.readFile(tmpOut);
    const samples = new Float32Array(pcm.length / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
    return samples;
  } finally {
    await fsp.unlink(tmpIn).catch(() => undefined);
    await fsp.unlink(tmpOut).catch(() => undefined);
  }
}

/** 服务端转写：sherpa 流式解码 + 确定性误听归一 */
export async function transcribeServer(audio: Buffer, format: string): Promise<{ text: string; rawText: string; durationMs: number } | null> {
  const rec = getRecognizer();
  if (!rec) return null;
  const t0 = Date.now();
  const samples = await decodeToPcm(audio, format);
  if (samples.length < 1600) throw new TRPCError({ code: "BAD_REQUEST", message: "语音太短，按住说一句话再松开" });
  if (samples.length > 16000 * 45) throw new TRPCError({ code: "BAD_REQUEST", message: "一句话最多 45 秒，分段说更准" });
  const stream = rec.createStream();
  stream.acceptWaveform({ samples, sampleRate: 16000 });
  stream.inputFinished();
  while (rec.isReady(stream)) rec.decode(stream);
  const rawText = rec.getResult(stream).text.trim();
  return { text: mishearCorrect(rawText), rawText, durationMs: Date.now() - t0 };
}


// ─── M80c edge-tts 备用腿（2026-08-24，彭总：TTS 你想办法解决）────────────────
// 免 key 神经 TTS（微软 Edge 大声读接口，S2 已装 edge-tts 7.8）。
// 定位：AGENT_GW key 缺席/失败时的云端合成腿，端侧 sherpa 兜底仍在最后。
// 音色定调（视频标准实测）：灵枢=云扬新闻男声（专业沉稳）；星云=晓晓（温暖）；
// 语速旋钮复用 M78 tempo：tempo 0.68 → --rate=-32%（合成期整速，不再二次 atempo）。

const EDGE_VOICE: Record<string, string> = {
  lingshu: "zh-CN-YunyangNeural", // 专业可靠男声（实测 F0 中位 106Hz vs 视频标准 97Hz）
  xingyun: "zh-CN-XiaoxiaoNeural", // 温暖女声
};

/** v162 性别换声（彭总令）：灵枢按用户性别换声——男用户男声/女用户女声；星云恒女。 */
export function voicePersonaFor(persona: string, gender: string | null | undefined): string {
  if (persona === "lingshu" && gender === "female") return "xingyun"; // 灵枢对女用户用女声
  return persona;
}

/** tempo 旋钮 → edge-tts --rate 参数（0.68 → "-32%"）；1.0 附近不出参 */
export function edgeRateOf(tempo: number): string | null {
  if (!Number.isFinite(tempo) || tempo <= 0) return null;
  const pct = Math.round((tempo - 1) * 100);
  return pct === 0 ? null : `${pct}%`;
}

/** edge-tts 合成到指定文件；任何失败 ok:false（调用方继续回落链） */
export async function edgeTtsToFile(text: string, persona: string, tempo: number, file: string): Promise<boolean> {
  try {
    const voice = EDGE_VOICE[persona] ?? EDGE_VOICE.lingshu;
    const rate = edgeRateOf(tempo);
    const args = ["--voice", voice, "--text", text, "--write-media", file];
    if (rate) args.push("--rate=" + rate);
    await new Promise<void>((res, rej) =>
      execFile("edge-tts", args, { timeout: 20_000 }, (err) => (err ? rej(err) : res())));
    return fs.existsSync(file) && fs.statSync(file).size > 500;
  } catch {
    return false;
  }
}

// ─── M82c MiniMax TTS 腿（彭总 2026-08-25 供 key）────────────────────────────
/**
 * MiniMax speech-02 系（t2a_v2）：套餐实测授权 speech-02-hd/turbo。
 * 音色实测选型（视频标准 F0 97Hz）：灵枢=male-qn-jingying（精英男声 109Hz 最近）；
 * 星云=female-yujie（御姐温暖女声）。speed 参数与 M78 tempo 同义（<1 放慢）。
 * env：MMX_TTS_API_KEY / MMX_TTS_MODEL（缺省 speech-02-hd）/ MMX_VOICE_LINGSHU / MMX_VOICE_XINGYUN。
 * 响应 data.audio=hex 音频。凭证只走 env，绝不落日志。
 */
export async function minimaxTtsToFile(text: string, persona: string, tempo: number, file: string): Promise<boolean> {
  try {
    const key = (process.env.MMX_TTS_API_KEY ?? "").trim();
    if (!key) return false;
    const model = (process.env.MMX_TTS_MODEL ?? "speech-02-hd").trim();
    // v174：音色注册表驱动（粤普双轨多音色；未知人格回落灵枢）
    const voice = resolveVoice(persona).def.mmx.trim();
    const speed = Number.isFinite(tempo) && tempo > 0 ? Math.min(2, Math.max(0.5, Math.round(tempo * 100) / 100)) : 1;
    const res = await fetch("https://api.minimaxi.com/v1/t2a_v2", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model, text,
        voice_setting: { voice_id: voice, speed },
        audio_setting: { format: "mp3", sample_rate: 32000, bitrate: 128000 },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const j = (await res.json().catch(() => null)) as { data?: { audio?: string }; base_resp?: { status_code?: number } } | null;
    const hex = j?.data?.audio;
    if (!res.ok || !hex || (j?.base_resp?.status_code ?? 0) !== 0) return false;
    const buf = Buffer.from(hex, "hex");
    if (buf.length < 500) return false;
    await fsp.writeFile(file, buf);
    return true;
  } catch {
    return false;
  }
}

/** edge-tts 在场探测（1min 缓存，防每请求 spawn 试探） */
let edgeAvail: { ok: boolean; at: number } | null = null;
/** 测试用：清探测缓存（生产路径不调） */
export function resetEdgeAvailCache(): void { edgeAvail = null; }
export async function edgeTtsAvailable(): Promise<boolean> {
  if (edgeAvail && Date.now() - edgeAvail.at < 60_000) return edgeAvail.ok;
  const ok = await new Promise<boolean>((res) =>
    execFile("edge-tts", ["--version"], { timeout: 5_000 }, (err, stdout) =>
      res(!err && String(stdout).trim().length > 0)));
  edgeAvail = { ok, at: Date.now() };
  return ok;
}

// ─── TTS（agent-gw generate_speech + sha256 缓存） ────────────────────────────

const PERSONA_VOICE: Record<string, string> = {
  lingshu: "05Cdh2gw2NMzDvykn1nm", // 沉稳中年男声（M78 视频标准实测：F0 中位 101Hz vs 标准 97Hz，选型确认）
  xingyun: "NLl76XZRVj1RVeXptX3h", // 温暖女声
};

/**
 * v174 音色注册表（彭总三轮试听拍板 2026-08-29）。
 * 法律纪律：全用 MiniMax 官方系统音色，原创人设命名，绝不模仿/克隆真实人物嗓音（民法典声音权红线）。
 * mmx = MiniMax 官方 voice_id（env 可覆盖）；gwFallback = agent-gw 腿无对应音色时回落的基础人格。
 */
export interface VoiceDef { mmx: string; gwFallback: "lingshu" | "xingyun"; label: string; lang: "zh" | "yue"; gender: "male" | "female" }
export const VOICE_REGISTRY: Record<string, VoiceDef> = {
  // 现役默认（不动）
  lingshu:      { mmx: process.env.MMX_VOICE_LINGSHU ?? "male-qn-jingying",              gwFallback: "lingshu", label: "灵枢·标准男声", lang: "zh", gender: "male" },
  xingyun:      { mmx: process.env.MMX_VOICE_XINGYUN ?? "female-yujie",                  gwFallback: "xingyun", label: "星云·标准女声", lang: "zh", gender: "female" },
  // 拍板阵容：男声三将 + 女声双姝
  lingshu_yue:  { mmx: process.env.MMX_VOICE_LINGSHU_YUE ?? "Cantonese_PlayfulMan",          gwFallback: "lingshu", label: "灵枢·粤语「广仔」", lang: "yue", gender: "male" },
  lingshu_ba:   { mmx: process.env.MMX_VOICE_LINGSHU_BA ?? "male-qn-badao",                  gwFallback: "lingshu", label: "灵枢·普通话「震堂」", lang: "zh", gender: "male" },
  lingshu_dj:   { mmx: process.env.MMX_VOICE_LINGSHU_DJ ?? "Chinese (Mandarin)_Radio_Host",  gwFallback: "lingshu", label: "灵枢·普通话「夜航」", lang: "zh", gender: "male" },
  xingyun_yue:  { mmx: process.env.MMX_VOICE_XINGYUN_YUE ?? "Cantonese_GentleLady",          gwFallback: "xingyun", label: "星云·粤语「静岚」", lang: "yue", gender: "female" },
  xingyun_warm: { mmx: process.env.MMX_VOICE_XINGYUN_WARM ?? "Chinese (Mandarin)_Warm_Girl", gwFallback: "xingyun", label: "星云·普通话「暖意」", lang: "zh", gender: "female" },
};

/** 音色合法性判定（纯函数可测）：注册表内才放行，否则回落基础人格 */
export function resolveVoice(persona: string): { key: string; def: VoiceDef } {
  const k = Object.prototype.hasOwnProperty.call(VOICE_REGISTRY, persona) ? persona : "lingshu";
  return { key: k, def: VOICE_REGISTRY[k] };
}

/**
 * M78 音色定调（用户视频标准 2026-08-23）：TTS 语速旋钮。
 * 视频标准 = 沉稳慢节奏（实测约 3.3 音节/s；TTS 原声 5.5/s）→ atempo 保音高减速对齐。
 * env：TTS_ATEMPO（全局）/ TTS_ATEMPO_<PERSONA大写>（单人格覆盖）；缺省 1.0 = 行为零变化。
 * 合法区间 0.5–2.0（ffmpeg atempo 单实例域）；非法值静默落 1.0。
 */
export function ttsTempoOf(persona: string, env: NodeJS.ProcessEnv = process.env): number {
  const per = Number(env[`TTS_ATEMPO_${String(persona).toUpperCase()}`]);
  const glob = Number(env.TTS_ATEMPO);
  const f = Number.isFinite(per) && per > 0 ? per : Number.isFinite(glob) && glob > 0 ? glob : 1;
  if (f < 0.5 || f > 2) return 1;
  return Math.round(f * 100) / 100;
}

/**
 * 合成后整速：factor≈1 不动；否则 ffmpeg atempo 保音高变速，失败保留原文件（绝不阻塞主链）。
 * 必须在 extractEnvelope 之前调用——包络从最终音频提取，口型同步天然对齐。
 */
export async function applyTempoIfNeeded(file: string, factor: number): Promise<void> {
  if (!Number.isFinite(factor) || Math.abs(factor - 1) < 0.01) return;
  const tmp = `${file}.tmpo.mp3`;
  try {
    await new Promise<void>((res, rej) =>
      execFile(
        "ffmpeg",
        ["-y", "-v", "error", "-i", file, "-af", `atempo=${factor}`, tmp],
        { timeout: 10_000 },
        (err) => (err ? rej(err) : res()),
      ));
    await fsp.rename(tmp, file);
  } catch {
    await fsp.unlink(tmp).catch(() => {});
  }
}

let ttsDayCount = 0;
let ttsDayKey = "";
const TTS_DAILY_CAP = Number(process.env.TTS_DAILY_CAP) || 3000;

function ttsBudgetOk(): boolean {
  const key = new Date().toISOString().slice(0, 10);
  if (key !== ttsDayKey) {
    ttsDayKey = key;
    ttsDayCount = 0;
  }
  return ttsDayCount < TTS_DAILY_CAP;
}

function ttsDir(): string {
  return process.env.TTS_CACHE_DIR || path.resolve(process.cwd(), "dist", "public", "tts");
}

/** TTS 缓存 7 天 TTL（内容寻址可再生，绝不让缓存吃磁盘）；每次写入顺手 lazy 清理 */
const TTS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ─── 口型能量包络（M48：口型与真实音频严格对齐，告别匀速猜字） ────────────────
/** 包络帧长：40ms（25fps，端侧每帧采样一次，跟随嘴型开合足够细腻） */
export const ENV_FRAME_MS = 40;

/**
 * mp3 → RMS 能量包络：ffmpeg 解码 8kHz mono s16le → 逐帧 RMS → 峰值归一 0..1（两位小数）。
 * 与 ASR 同款 ffmpeg 子进程纪律：10s 硬顶；任何失败返回 null（调用方降级文本推演口型）。
 */
export async function extractEnvelope(file: string): Promise<number[] | null> {
  try {
    const stdout = await new Promise<Buffer>((res, rej) =>
      execFile(
        "ffmpeg",
        ["-v", "error", "-i", file, "-ac", "1", "-ar", "8000", "-f", "s16le", "-"],
        { timeout: 10_000, maxBuffer: 32 * 1024 * 1024, encoding: "buffer" as never },
        (err, out) => (err ? rej(err) : res(out as Buffer)),
      ));
    const samplesPerFrame = Math.round(8000 * (ENV_FRAME_MS / 1000)); // 320
    const frames = Math.floor(stdout.length / 2 / samplesPerFrame);
    if (frames < 2) return null;
    const pcm = new Int16Array(stdout.buffer, stdout.byteOffset, frames * samplesPerFrame);
    const raws: number[] = [];
    let peak = 0;
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      const off = i * samplesPerFrame;
      for (let j = 0; j < samplesPerFrame; j++) {
        const s = pcm[off + j];
        sum += s * s;
      }
      const rms = Math.sqrt(sum / samplesPerFrame) / 32768;
      raws.push(rms);
      if (rms > peak) peak = rms;
    }
    if (peak <= 0) return null;
    return raws.map((r) => Math.round((r / peak) * 100) / 100);
  } catch {
    return null;
  }
}

/** 包络缓存文件（与 mp3 同键不同后缀，TTL 同生命周期） */
function envelopePath(dir: string, key: string): string {
  return path.join(dir, `${key}.env.json`);
}

async function readEnvelopeCache(dir: string, key: string): Promise<number[] | null> {
  try {
    const raw = await fsp.readFile(envelopePath(dir, key), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.length >= 2 && parsed.every((n) => typeof n === "number")) {
      return parsed as number[];
    }
    return null;
  } catch {
    return null;
  }
}

async function sweepTtsCache(dir: string): Promise<void> {
  try {
    const entries = await fsp.readdir(dir);
    const now = Date.now();
    for (const name of entries) {
      if (!name.endsWith(".mp3") && !name.endsWith(".env.json")) continue;
      try {
        const st = await fsp.stat(path.join(dir, name));
        if (now - st.mtimeMs > TTS_TTL_MS) await fsp.unlink(path.join(dir, name));
      } catch {
        /* 单文件失败不阻塞 */
      }
    }
  } catch {
    /* 目录不存在等：静默 */
  }
}

/** 服务端合成结果：url + 口型能量包络（envelope 可能为 null，端侧降级文本推演） */
export interface TtsReply {
  url: string;
  envelope: number[] | null;
}

/** 服务端合成语音：命中缓存直回；miss 调 agent-gw 落盘；失败/超顶返回 null（调用方回落） */
export async function ttsForReply(text: string, persona: string): Promise<TtsReply | null> {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (!clean) return null;
  const tempo = ttsTempoOf(persona);
  const key = createHash("sha256").update(`${persona}:${tempo}:${clean}`).digest("hex");
  const dir = ttsDir();
  const file = path.join(dir, `${key}.mp3`);
  const rel = `/tts/${key}.mp3`;
  if (fs.existsSync(file)) {
    // 命中：优先读包络缓存；老缓存无包络则补提取（失败不阻塞主链）
    let env = await readEnvelopeCache(dir, key);
    if (!env) {
      env = await extractEnvelope(file);
      if (env) await fsp.writeFile(envelopePath(dir, key), JSON.stringify(env)).catch(() => {});
    }
    return { url: rel, envelope: env };
  }
  if (!ttsBudgetOk()) return null;

  // M80c/M82c 备用腿收口：MiniMax（合成期 speed 整速）→ edge-tts（rate 整速）
  const fallbackLeg = async (): Promise<TtsReply | null> => {
    await fsp.mkdir(dir, { recursive: true }); // 先建仓（合成写盘用）
    let ok = await minimaxTtsToFile(clean, persona, tempo, file);
    if (!ok) {
      if (!(await edgeTtsAvailable())) return null;
      ok = await edgeTtsToFile(clean, persona, tempo, file);
    }
    if (!ok) return null;
    const env = await extractEnvelope(file);
    if (env) await fsp.writeFile(envelopePath(dir, key), JSON.stringify(env)).catch(() => {});
    void sweepTtsCache(dir);
    ttsDayCount += 1;
    return { url: rel, envelope: env };
  };

  const apiKey = (process.env.AGENT_GW_API_KEY ?? "").trim();
  if (!apiKey) return fallbackLeg();
  const base = (process.env.AGENT_GW_BASE ?? "https://agent-gw.kimi.com/coding").trim();
  try {
    const res = await fetch(`${base}/v1/tools`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        method: "generate_speech",
        params: { text: clean, voice_id: PERSONA_VOICE[persona] ?? PERSONA_VOICE[resolveVoice(persona).def.gwFallback] },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const j = (await res.json()) as { media?: { url?: string } };
    const mediaUrl = j?.media?.url;
    if (mediaUrl) {
      const audio = await fetch(mediaUrl, { signal: AbortSignal.timeout(15_000) });
      if (audio.ok) {
        const buf = Buffer.from(await audio.arrayBuffer());
        if (buf.length >= 200) {
          await fsp.mkdir(dir, { recursive: true });
          await fsp.writeFile(file, buf);
          // M78：音色定调整速在包络提取之前——口型与最终音频严格对齐
          await applyTempoIfNeeded(file, tempo);
          // M48：落盘即提口型能量包络并缓存（失败不阻塞——端侧可降级文本推演）
          const env = await extractEnvelope(file);
          if (env) await fsp.writeFile(envelopePath(dir, key), JSON.stringify(env)).catch(() => {});
          void sweepTtsCache(dir); // M43-fix：写即顺手清 7 天前缓存（后台，不阻塞）
          ttsDayCount += 1;
          return { url: rel, envelope: env };
        }
      }
    }
    return fallbackLeg(); // M80c/M82c：agent-gw 空响应/失败 → MiniMax/edge-tts 备用腿
  } catch {
    return fallbackLeg();
  }
}

// ─── 路由 ────────────────────────────────────────────────────────────────────

export const voiceMediaRouter = createRouter({
  /** voice.asr（mutation）：云端语音识别；模型不可用 → ok:false（APP 回落端侧 sherpa） */
  asr: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        audioBase64: z.string().min(100).max(3_500_000), // ≈2.5MB 顶
        format: z.enum(["m4a", "wav", "amr", "aac", "mp3"]).default("m4a"),
      }),
    )
    .mutation(async ({ input }) => {
      const { user, factory } = await sessionMe(input.token);
      const audio = Buffer.from(input.audioBase64, "base64");
      if (audio.length < 200) throw new TRPCError({ code: "BAD_REQUEST", message: "没收到声音，请按住再说一次" });
      const r = await transcribeServer(audio, input.format);
      if (!r) return { ok: false as const, reason: "server_asr_unavailable" };
      // M45/E2 金矿：rawText 与归一文本的差 = 误听新词条证据 → 信号总线（E2 提案数据源）
      if (r.text !== r.rawText) {
        const { emitEvoSignal } = await import("./evoSignals");
        void emitEvoSignal({
          kind: "mishear_diff",
          factoryId: factory.id,
          actor: String(user.username),
          payload: { raw: r.rawText.slice(0, 200), corrected: r.text.slice(0, 200) },
        });
      }
      if (!r.text) return { ok: true as const, text: "", rawText: "", durationMs: r.durationMs, empty: true as const };
      return { ok: true as const, text: r.text, rawText: r.rawText, durationMs: r.durationMs };
    }),

  /** voice.tts（mutation）：服务端合成播报；失败/超顶 → ok:false（APP 回落端侧引擎）。
   *  M48：响应附带 envelope（40ms 帧 RMS 能量包络，峰值归一），APP 播放时按包络驱动口型，
   *  与真实音频严格对齐；envelope 为 null 时 APP 降级 speechCue 文本推演。 */
  tts: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        text: z.string().trim().min(1).max(120),
        // v174：persona 放开为字符串（注册表 resolveVoice 校验，非法回落基础人格）——多音色粤普双轨
        persona: z.string().trim().max(24).default("lingshu"),
      }),
    )
    .mutation(async ({ input }) => {
      const session = await sessionMe(input.token);
      // v174 用户音色偏好优先（wb_users.voice_pref，APP「我的-音色设置」写入）；未设 → 人格+性别默认
      const u = session.user as unknown as { gender?: string | null; voice_pref?: string | null };
      const pref = u.voice_pref && Object.prototype.hasOwnProperty.call(VOICE_REGISTRY, u.voice_pref) ? u.voice_pref : null;
      const persona = pref ?? voicePersonaFor(resolveVoice(input.persona).key, u.gender);
      const r = await ttsForReply(input.text, persona);
      if (!r) return { ok: false as const };
      return { ok: true as const, url: r.url, envelope: r.envelope, voice: persona };
    }),

  /** voice.voiceList（query）：音色注册表（APP 音色设置页数据源；公开只读） */
  voiceList: publicQuery.input(z.object({ token: z.string().optional() }).optional()).query(() => ({
    voices: Object.entries(VOICE_REGISTRY).map(([key, v]) => ({ key, label: v.label, lang: v.lang, gender: v.gender })),
  })),

  /** voice.setVoicePref（mutation）：写入用户音色偏好（登录态） */
  setVoicePref: publicQuery
    .input(z.object({ token: z.string().trim().min(1), voice: z.string().trim().max(24) }))
    .mutation(async ({ input }) => {
      const session = await sessionMe(input.token);
      const uid = Number((session.user as unknown as { id?: number }).id ?? 0);
      const clearing = input.voice === "" || input.voice === "default";
      if (!clearing && !Object.prototype.hasOwnProperty.call(VOICE_REGISTRY, input.voice)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "音色不存在" });
      }
      // voice_pref 列由 sync-voice-pref 幂等建立；缺列静默失败不挡主链
      await getDb().execute(sql`UPDATE wb_users SET voice_pref=${clearing ? null : input.voice} WHERE id=${uid}`).catch(() => undefined);
      return { ok: true as const, voice: clearing ? null : input.voice };
    }),
});
