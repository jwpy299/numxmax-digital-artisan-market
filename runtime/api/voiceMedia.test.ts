/**
 * voiceMedia 口型能量包络（M48）单测。
 *
 * 闸点：
 * 1. 已知结构测试音（静音|正弦|静音）→ 包络帧数 ≈ 时长/40ms；
 * 2. 峰值归一：最大值 = 1；
 * 3. 静音段 ≈ 0、发声段显著 > 0（包络必须反映真实音频能量，而非匀速推演）；
 * 4. 坏文件 / 缺失文件 → null 不抛（端侧降级文本推演的后路永不断）。
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as vm from "./routers/voiceMedia";
import { ENV_FRAME_MS, applyTempoIfNeeded, edgeRateOf, extractEnvelope, resetEdgeAvailCache, ttsTempoOf } from "./routers/voiceMedia";

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((res, rej) =>
    execFile("ffmpeg", args, { timeout: 15_000 }, (err) => (err ? rej(err) : res())));
}

async function makeToneMp3(): Promise<string> {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "env-")), "tone.mp3");
  // 0.5s 静音 + 1s 440Hz 正弦 + 0.5s 静音 = 2s
  await ffmpeg([
    "-v", "error", "-y",
    "-f", "lavfi", "-i", "anullsrc=r=22050:cl=mono:d=0.5",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=22050:d=1",
    "-f", "lavfi", "-i", "anullsrc=r=22050:cl=mono:d=0.5",
    "-filter_complex", "[0:a][1:a][2:a]concat=n=3:v=0:a=1[out]",
    "-map", "[out]", file,
  ]);
  return file;
}

describe("voiceMedia 口型能量包络", () => {
  it("静音|正弦|静音 → 帧数/归一/能量分布全部符合真实音频", async () => {
    const file = await makeToneMp3();
    const amps = await extractEnvelope(file);
    expect(amps).not.toBeNull();
    const a = amps!;
    // 2s / 40ms = 50 帧（mp3 编解码有起止填充，容差 ±6 帧）
    expect(a.length).toBeGreaterThanOrEqual(44);
    expect(a.length).toBeLessThanOrEqual(56);
    // 峰值归一
    expect(Math.max(...a)).toBe(1);
    // 前 0.4s（10 帧）静音 ≈ 0
    const head = a.slice(0, 10);
    expect(Math.max(...head)).toBeLessThan(0.1);
    // 中段（0.7s..1.3s ≈ 帧 17..32）显著发声
    const mid = a.slice(17, 33);
    expect(Math.min(...mid)).toBeGreaterThan(0.3);
    // 尾部 0.4s 回静
    const tail = a.slice(-10);
    expect(Math.max(...tail)).toBeLessThan(0.1);
  }, 30_000);

  it("坏文件 / 缺失文件 → null 不抛", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-"));
    const bad = path.join(dir, "bad.mp3");
    fs.writeFileSync(bad, Buffer.from("not an mp3"));
    expect(await extractEnvelope(bad)).toBeNull();
    expect(await extractEnvelope(path.join(dir, "missing.mp3"))).toBeNull();
  }, 20_000);

  it("帧长常量 = 40ms（端侧 25fps 采样契约）", () => {
    expect(ENV_FRAME_MS).toBe(40);
  });
});

describe("M78 音色定调（视频标准语速旋钮）", () => {
  it("ttsTempoOf：缺省 1.0（行为零变化）", () => {
    expect(ttsTempoOf("lingshu", {} as NodeJS.ProcessEnv)).toBe(1);
  });
  it("ttsTempoOf：单人格覆盖优先于全局；非法值落 1.0", () => {
    expect(ttsTempoOf("lingshu", { TTS_ATEMPO_LINGSHU: "0.68" } as NodeJS.ProcessEnv)).toBe(0.68);
    expect(ttsTempoOf("xingyun", { TTS_ATEMPO_LINGSHU: "0.68" } as NodeJS.ProcessEnv)).toBe(1);
    expect(ttsTempoOf("lingshu", { TTS_ATEMPO: "0.8" } as NodeJS.ProcessEnv)).toBe(0.8);
    expect(ttsTempoOf("lingshu", { TTS_ATEMPO_LINGSHU: "0.68", TTS_ATEMPO: "0.8" } as NodeJS.ProcessEnv)).toBe(0.68);
    expect(ttsTempoOf("lingshu", { TTS_ATEMPO: "abc" } as NodeJS.ProcessEnv)).toBe(1);
    expect(ttsTempoOf("lingshu", { TTS_ATEMPO: "0.2" } as NodeJS.ProcessEnv)).toBe(1); // 越界→1
    expect(ttsTempoOf("lingshu", { TTS_ATEMPO: "5" } as NodeJS.ProcessEnv)).toBe(1);
    expect(ttsTempoOf("lingshu", { TTS_ATEMPO: "0.5" } as NodeJS.ProcessEnv)).toBe(0.5); // 边界合法
  });
  it("applyTempoIfNeeded：factor=1 原样不动（字节一致）", async () => {
    const file = await makeToneMp3();
    const before = fs.readFileSync(file);
    await applyTempoIfNeeded(file, 1);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  }, 30_000);
  it("applyTempoIfNeeded：0.5 倍速 → 包络帧数约翻倍（时长翻倍）", async () => {
    const slow = await makeToneMp3();
    await applyTempoIfNeeded(slow, 0.5);
    const a = await extractEnvelope(slow);
    expect(a).not.toBeNull();
    // 2s→约4s，40ms 帧 → 约 100 帧（容差放宽）
    expect(a!.length).toBeGreaterThanOrEqual(85);
    expect(a!.length).toBeLessThanOrEqual(120);
  }, 30_000);
  it("applyTempoIfNeeded：文件缺失 → 静默不抛", async () => {
    await applyTempoIfNeeded(path.join(os.tmpdir(), "no-such-tts-file.mp3"), 0.68);
  });
});

describe("M80c edge-tts 备用腿（无 Kimi key 的云端神经合成）", () => {
  it("edgeRateOf：tempo 映射与边界", () => {
    expect(edgeRateOf(1)).toBeNull();
    expect(edgeRateOf(0.68)).toBe("-32%");
    expect(edgeRateOf(1.2)).toBe("20%");
    expect(edgeRateOf(0)).toBeNull();
    expect(edgeRateOf(NaN)).toBeNull();
  });
  it("无 AGENT_GW_API_KEY 且 edge-tts 真不在场（沙箱现状）→ null 回落端侧（不炸）", async () => {
    delete process.env.AGENT_GW_API_KEY;
    resetEdgeAvailCache();
    const r = await vm.ttsForReply("测试备用腿", "lingshu");
    expect(r).toBeNull();
  }, 30_000);
  it("edge-tts 在场（PATH 注入假命令）且合成成功 → 出 url+包络", async () => {
    delete process.env.AGENT_GW_API_KEY;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "edgefake-"));
    const tone = await makeToneMp3();
    // 假 edge-tts：--version 出版本；合成时把真音频拷到 --write-media 目标
    const fake = path.join(dir, "edge-tts");
    fs.writeFileSync(fake, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "edge-tts 7.2.8-fake"; exit 0; fi
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--write-media" ]; then out="$a"; fi
  prev="$a"
done
cp "${tone}" "$out"
`);
    fs.chmodSync(fake, 0o755);
    resetEdgeAvailCache();
    const oldPath = process.env.PATH;
    process.env.PATH = `${dir}:${oldPath}`;
    try {
      const r = await vm.ttsForReply("测试备用腿成功" + Date.now(), "lingshu");
      expect(r).not.toBeNull();
      expect(r!.url).toMatch(/^\/tts\//);
      expect(Array.isArray(r!.envelope)).toBe(true);
    } finally {
      process.env.PATH = oldPath;
    }
  }, 30_000);
});

describe("M82c MiniMax TTS 腿（彭总供 key 2026-08-25）", () => {
  it("无 key → false 静默（走下一腿）", async () => {
    delete process.env.MMX_TTS_API_KEY;
    const r = await vm.minimaxTtsToFile("测", "lingshu", 1, path.join(os.tmpdir(), "never.mp3"));
    expect(r).toBe(false);
  });
  it("真链路形态：hex 解码落盘 + speed=tempo 同义下行（0.68→0.68）", async () => {
    process.env.MMX_TTS_API_KEY = "test-key";
    const origFetch = globalThis.fetch;
    const seen: Array<{ body: string }> = [];
    globalThis.fetch = (async (_u: unknown, init: { body?: string }) => {
      seen.push({ body: String(init?.body ?? "") });
      return new Response(JSON.stringify({
        base_resp: { status_code: 0 },
        data: { audio: Buffer.alloc(8000, 7).toString("hex") },
      }), { status: 200 });
    }) as typeof fetch;
    try {
      const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mmx-")), "a.mp3");
      const r = await vm.minimaxTtsToFile("测试精英男声", "lingshu", 0.68, target);
      expect(r).toBe(true);
      expect(fs.statSync(target).size).toBe(8000);
      const req = JSON.parse(seen[0].body);
      expect(req.model).toBe("speech-02-hd");
      expect(req.voice_setting.voice_id).toBe("male-qn-jingying");
      expect(req.voice_setting.speed).toBe(0.68);
      expect(req.audio_setting.format).toBe("mp3");
    } finally {
      globalThis.fetch = origFetch;
      delete process.env.MMX_TTS_API_KEY;
    }
  });
  it("status_code 非 0 → false（套餐/模型未授权不装成功）", async () => {
    process.env.MMX_TTS_API_KEY = "k";
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      base_resp: { status_code: 2061, status_msg: "plan not support" },
    }), { status: 200 })) as typeof fetch;
    try {
      const r = await vm.minimaxTtsToFile("测", "lingshu", 1, path.join(os.tmpdir(), "never2.mp3"));
      expect(r).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
      delete process.env.MMX_TTS_API_KEY;
    }
  });
});
