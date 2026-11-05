/**
 * 四层四锁·吊销台账测试（批七-b）：指纹口径 + 台账行为钉死（mock 库层）。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

let execLog: string[] = [];
let selectRows: Array<Record<string, unknown>> = [];
let probeRow: Record<string, unknown> = { markerN: 1, totalN: 1, legacyN: 0 }; // R7-c160-⑧：探针行旋钮（矛盾态注入用）

vi.mock("../queries/connection", () => ({
  getDb: () => ({
    execute: async (stmt: unknown) => {
      // drizzle sql`` 对象不 stringify（[object Object]）——取 queryChunks 文本段拼 SQL 原文
      execLog.push(JSON.stringify(stmt)); // drizzle sql`` 不 stringify——整对象序列化留痕（参数在内部）
      if (JSON.stringify(stmt).includes("markerN")) return [[probeRow], []] as never; // R7-c134-⑨/R7-c160-⑧：探针行走旋钮（健康/矛盾两态可注——fail-loud 解包钉配套）
      return [selectRows, []] as never; // drizzle execute 元组形
    },
  }),
}));

import { isRevoked, recordRevocation, tokenFingerprint, probeLedgerScheme, isLedgerContradictory } from "./revocation";

beforeEach(() => { execLog = []; selectRows = []; probeRow = { markerN: 1, totalN: 1, legacyN: 0 }; }); // R7-c160-⑧：旋钮同复位

describe("tokenFingerprint", () => {
  it("sha256 hex 稳定且不落明文", () => {
    const fp = tokenFingerprint("nt_abc123");
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(fp).not.toContain("nt_abc123");
    expect(tokenFingerprint("nt_abc123")).toBe(fp); // 同入同出（幂等）
    expect(tokenFingerprint("nt_other")).not.toBe(fp);
  });

  it("归一化钉（R7-c96-⑨ security）：大小写/空白变体同指纹——变体重放穿透面不回开（生产者/消费者同走本点，摘除归一化=两侧仍互洽无测试红=洞静默复活，故钉死在单点上）", () => {
    expect(tokenFingerprint("NT_ABC")).toBe(tokenFingerprint("nt_abc")); // 大小写变体
    expect(tokenFingerprint(" nt_abc ")).toBe(tokenFingerprint("nt_abc")); // 空白变体
    expect(tokenFingerprint("nt_ábc")).toBe(tokenFingerprint("nt_abc")); // R7-c99-⑧：口音变体（ai_ci 列等价类对齐）
  });

  it("变体闭环钉：isRevoked 按归一化指纹查台账（变体重放即命中——穿透面钉死在产线）", async () => {
    selectRows = [{ id: 1 }]; // 台账命中行在场
    expect(await isRevoked("NT_abc")).toBe(true); // 大写变体重放——按归一化指纹命中
    expect(JSON.stringify(execLog.join())).toContain(tokenFingerprint("nt_abc")); // 查询指纹=归一化值（实证单点生效）
    selectRows = [];
    expect(await isRevoked("nt_other")).toBe(false); // 台账无此行→不命中
  });
});

describe("recordRevocation", () => {
  it("写台账返指纹，SQL 携指纹+操作者+原因", async () => {
    const r = await recordRevocation("nt_x", "boss-admin", "离岗吊销");
    expect(r.fingerprint).toBe(tokenFingerprint("nt_x"));
    expect(execLog.length).toBe(1);
    // drizzle sql`` 文本段在 queryChunks（StringChunk.value 为 string[]），参数在末段——序列化整对象断言指纹入参
    expect(JSON.stringify(execLog[0])).toContain(tokenFingerprint("nt_x"));
  });
});

describe("isRevoked", () => {
  it("命中台账 true / 未命中 false", async () => {
    selectRows = [];
    expect(await isRevoked("nt_none")).toBe(false);
    selectRows = [{ id: 1 }];
    expect(await isRevoked("nt_hit")).toBe(true);
  });
});

describe("probeLedgerScheme（R7-c136-②：口径体检原语可测化钉）", () => {
  const fakeDb = (rows: unknown) => ({ execute: async () => [rows, []] });
  it("正常行 → {legacy, hasMarker, total} 事实出口（R7-c154-⑥：total 增列——无标记态判定归它）", async () => {
    expect(await probeLedgerScheme(fakeDb([{ legacyN: 2, markerHit: 1, totalN: 5 }]) as never)).toEqual({ legacy: 2, hasMarker: true, total: 5 });
    expect(await probeLedgerScheme(fakeDb([{ legacyN: 0, markerHit: 0, totalN: 0 }]) as never)).toEqual({ legacy: 0, hasMarker: false, total: 0 });
  });
  it("封套/别名漂移 → fail-loud 抛（不静默归零=「无发现」假报告面钉死）", async () => {
    await expect(probeLedgerScheme(fakeDb([{ legacyN: 1 }]) as never)).rejects.toThrow("解包失败"); // markerHit 别名漂移
    await expect(probeLedgerScheme(fakeDb([]) as never)).rejects.toThrow("解包失败"); // 零行封套漂移
    await expect(probeLedgerScheme(fakeDb([{ legacyN: "x", markerHit: 1 }]) as never)).rejects.toThrow("解包失败"); // 非数值漂移
  });
});

describe("isLedgerContradictory（R7-c158-⑦：启动闸与运行期 fail-closed 判据单源钉）", () => {
  it("全状态面逐格钉", () => {
    expect(isLedgerContradictory({ legacy: 0, hasMarker: true, total: 5 })).toBe(false); // 健康
    expect(isLedgerContradictory({ legacy: 0, hasMarker: true, total: 0 })).toBe(false); // 空表有标记=健康
    expect(isLedgerContradictory({ legacy: 0, hasMarker: false, total: 0 })).toBe(false); // 空表无标记=良性放行（无吊销可解）
    expect(isLedgerContradictory({ legacy: 2, hasMarker: true, total: 5 })).toBe(true); // 异口径行在场=拒
    expect(isLedgerContradictory({ legacy: 0, hasMarker: false, total: 3 })).toBe(true); // 有行无标记=拒
    expect(isLedgerContradictory({ legacy: 1, hasMarker: false, total: 4 })).toBe(true); // 双并发=拒
  });
});

describe("isRevoked 矛盾台账 fail-closed wiring（R7-c160-⑧/R7-c162-② test low）", () => {
  // 谓词 isLedgerContradictory 已有全状态面单测，但接线面（探针行→判据→抛 500）此前零钉——
  //  换序/未取反/字段接错类接线错在旧套件绿灯；本钉把接线面锁死。
  //  R7-c162-②：memo TTL 窗整面摘除——未命中即探（fail-closed 逐请求全覆），旋钮即换即效（无需 resetModules）
  it("探针报矛盾（有行无标记）→ isRevoked 抛 500 不放行", async () => {
    probeRow = { markerN: 0, totalN: 1, legacyN: 0 }; // 有行无标记=矛盾态
    selectRows = []; // 未命中快路→支付探针
    await expect(isRevoked("nt_drift1")).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  });
  it("探针报矛盾（标记在场+异口径行）→ isRevoked 抛 500 不放行", async () => {
    probeRow = { markerN: 1, totalN: 3, legacyN: 2 }; // 标记在场+无标签行=矛盾态（逃生门/旧码错峰面）
    selectRows = [];
    await expect(isRevoked("nt_drift2")).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  });
  it("探针报健康 → isRevoked 未命中照常 false（接线钉不误伤良性径）", async () => {
    probeRow = { markerN: 1, totalN: 1, legacyN: 0 };
    selectRows = [];
    await expect(isRevoked("nt_healthy")).resolves.toBe(false);
  });
});
