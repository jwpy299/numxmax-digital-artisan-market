/** wbDevices 纯逻辑用例（M17b）：状态判定 / 倒计时格式化 / 二维码 payload 解析 / 配对码校验 / 设备凭证与心跳单例 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPairQrPayload,
  clearDeviceCredential,
  deviceHeartbeatRunning,
  deviceStatusOf,
  deviceStatusLabel,
  deviceTypeLabel,
  formatPairRemaining,
  isDeviceToken,
  isPairCode,
  loadDeviceCredential,
  normalizeDeviceCredential,
  parsePairQrPayload,
  pairRemainingSeconds,
  saveDeviceCredential,
  startDeviceHeartbeatSingleton,
  stopDeviceHeartbeat,
  HEARTBEAT_INTERVAL_MS,
  ONLINE_GRACE_MS,
  WB_DEVICE_CREDENTIAL_KEY,
} from "./wbDevices";

const VALID_CODE = `pd_${"a".repeat(48)}`;

describe("isPairCode", () => {
  it("接受 pd_+48hex", () => {
    expect(isPairCode(VALID_CODE)).toBe(true);
    expect(isPairCode(` ${VALID_CODE} `)).toBe(true); // 宽容 trim
  });
  it("拒绝格式不符（长度/前缀/大小写/非 hex）", () => {
    expect(isPairCode(`pd_${"a".repeat(47)}`)).toBe(false);
    expect(isPairCode(`pd_${"A".repeat(48)}`)).toBe(false); // 大写不符后端 regex
    expect(isPairCode(`dt_${"a".repeat(48)}`)).toBe(false); // dt_ 是设备凭证，不是配对码
    expect(isPairCode(`pd_${"g".repeat(48)}`)).toBe(false);
    expect(isPairCode("")).toBe(false);
    expect(isPairCode(null)).toBe(false);
  });
});

describe("pairRemainingSeconds / formatPairRemaining", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  it("剩余秒数向上取整且不为负", () => {
    expect(pairRemainingSeconds(new Date(now.getTime() + 300_000), now)).toBe(300);
    expect(pairRemainingSeconds(new Date(now.getTime() + 61_500), now)).toBe(62);
    expect(pairRemainingSeconds(new Date(now.getTime() - 1_000), now)).toBe(0);
    expect(pairRemainingSeconds("bad-date", now)).toBe(0);
  });
  it("格式化为 m:ss，过期统一「已过期」", () => {
    expect(formatPairRemaining(new Date(now.getTime() + 300_000), now)).toBe("5:00");
    expect(formatPairRemaining(new Date(now.getTime() + 69_000), now)).toBe("1:09");
    expect(formatPairRemaining(new Date(now.getTime() + 9_000), now)).toBe("0:09");
    expect(formatPairRemaining(new Date(now.getTime() - 1), now)).toBe("已过期");
  });
});

describe("parsePairQrPayload / buildPairQrPayload", () => {
  it("解析版本化 JSON 对象与字符串", () => {
    expect(parsePairQrPayload({ t: "pair", c: VALID_CODE, v: 1 })).toBe(VALID_CODE);
    expect(parsePairQrPayload(JSON.stringify({ t: "pair", c: VALID_CODE, v: 1 }))).toBe(VALID_CODE);
  });
  it("非法 payload 一律 null（不泄露原因）", () => {
    expect(parsePairQrPayload({ t: "invite", c: VALID_CODE, v: 1 })).toBeNull(); // 类型不符
    expect(parsePairQrPayload({ t: "pair", c: "pd_short", v: 1 })).toBeNull(); // 码非法
    expect(parsePairQrPayload("not-json")).toBeNull();
    expect(parsePairQrPayload(null)).toBeNull();
    expect(parsePairQrPayload(42)).toBeNull();
  });
  it("build 与 parse 互逆；非法码不生成 payload", () => {
    const p = buildPairQrPayload(VALID_CODE);
    expect(p).toEqual({ t: "pair", c: VALID_CODE, v: 1 });
    expect(parsePairQrPayload(p)).toBe(VALID_CODE);
    expect(buildPairQrPayload("pd_bad")).toBeNull();
  });
});

describe("deviceStatusOf", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  it("90s 宽限边界：≤90s 在线，>90s 离线，从未心跳离线", () => {
    expect(deviceStatusOf({ lastSeenAt: new Date(now.getTime() - ONLINE_GRACE_MS) }, now)).toBe("online");
    expect(deviceStatusOf({ lastSeenAt: new Date(now.getTime() - ONLINE_GRACE_MS - 1) }, now)).toBe("offline");
    expect(deviceStatusOf({ lastSeenAt: null }, now)).toBe("offline");
    expect(deviceStatusOf({}, now)).toBe("offline");
  });
  it("revoked 优先于一切（即使刚心跳过）", () => {
    expect(
      deviceStatusOf({ lastSeenAt: new Date(now.getTime() - 1_000), revokedAt: new Date(now.getTime() - 500) }, now),
    ).toBe("revoked");
  });
  it("非法 lastSeenAt 按离线处理；标签映射稳定", () => {
    expect(deviceStatusOf({ lastSeenAt: "bad-date" }, now)).toBe("offline");
    expect(deviceStatusLabel("online")).toBe("在线");
    expect(deviceStatusLabel("offline")).toBe("离线");
    expect(deviceStatusLabel("revoked")).toBe("已解绑");
    expect(deviceTypeLabel("tablet")).toBe("平板");
    expect(deviceTypeLabel("unknown")).toBe("unknown");
  });
});

// ─── M17b REVISE：设备凭证存取 + 心跳单例 ────────────────────────────────────

const VALID_DT = `dt_${"b".repeat(48)}`;

function memStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

describe("isDeviceToken / normalizeDeviceCredential", () => {
  it("dt_+48hex 合法；pd_/畸形拒绝", () => {
    expect(isDeviceToken(VALID_DT)).toBe(true);
    expect(isDeviceToken(`pd_${"a".repeat(48)}`)).toBe(false);
    expect(isDeviceToken(`dt_${"b".repeat(47)}`)).toBe(false);
    expect(isDeviceToken(null)).toBe(false);
  });
  it("凭证形状校验：deviceId 正整数 + dt_ 合法；篡改一律 null", () => {
    expect(normalizeDeviceCredential({ deviceId: 7, deviceToken: VALID_DT })).toEqual({
      deviceId: 7,
      deviceToken: VALID_DT,
    });
    expect(normalizeDeviceCredential({ deviceId: 0, deviceToken: VALID_DT })).toBeNull();
    expect(normalizeDeviceCredential({ deviceId: 1.5, deviceToken: VALID_DT })).toBeNull();
    expect(normalizeDeviceCredential({ deviceId: 7, deviceToken: "dt_bad" })).toBeNull();
    expect(normalizeDeviceCredential("dt_xxx")).toBeNull();
    expect(normalizeDeviceCredential(null)).toBeNull();
  });
});

describe("设备凭证存取（localStorage wb_device_credential）", () => {
  it("保存→读取往返一致；清除后为空", () => {
    const s = memStorage();
    expect(saveDeviceCredential({ deviceId: 42, deviceToken: VALID_DT }, s)).toBe(true);
    expect(s.getItem(WB_DEVICE_CREDENTIAL_KEY)).toBeTruthy();
    expect(loadDeviceCredential(s)).toEqual({ deviceId: 42, deviceToken: VALID_DT });
    clearDeviceCredential(s);
    expect(loadDeviceCredential(s)).toBeNull();
  });
  it("非法凭证不落盘；损坏 JSON 读取为 null", () => {
    const s = memStorage();
    expect(saveDeviceCredential({ deviceId: 42, deviceToken: "not-a-token" }, s)).toBe(false);
    expect(loadDeviceCredential(s)).toBeNull();
    s.setItem(WB_DEVICE_CREDENTIAL_KEY, "{broken json");
    expect(loadDeviceCredential(s)).toBeNull();
    s.setItem(WB_DEVICE_CREDENTIAL_KEY, JSON.stringify({ deviceId: 42, deviceToken: "x" }));
    expect(loadDeviceCredential(s)).toBeNull();
  });
});

describe("心跳循环单例", () => {
  afterEach(() => {
    stopDeviceHeartbeat();
    vi.useRealTimers();
  });
  it("30s 周期打拍；重复启动仅保留一条循环", async () => {
    vi.useFakeTimers();
    const beat1 = vi.fn().mockResolvedValue({ ok: true });
    const beat2 = vi.fn().mockResolvedValue({ ok: true });
    startDeviceHeartbeatSingleton({ beat: beat1, isUnauthorized: () => false, onUnauthorized: () => {} });
    expect(deviceHeartbeatRunning()).toBe(true);
    startDeviceHeartbeatSingleton({ beat: beat2, isUnauthorized: () => false, onUnauthorized: () => {} });
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2 + 10);
    expect(beat1).toHaveBeenCalledTimes(1); // 旧循环已停：仅启动时那一拍
    expect(beat2).toHaveBeenCalledTimes(1 + 2); // 立即一拍 + 两个周期
    expect(HEARTBEAT_INTERVAL_MS).toBe(30_000);
  });
  it("UNAUTHORIZED → 停止循环并回调（清除凭证）；其它错误静默续跑", async () => {
    vi.useFakeTimers();
    let fail: unknown = null;
    const beat = vi.fn().mockImplementation(() => (fail ? Promise.reject(fail) : Promise.resolve({ ok: true })));
    const onUnauthorized = vi.fn();
    startDeviceHeartbeatSingleton({
      beat,
      isUnauthorized: (e) => e === "UNAUTHORIZED",
      onUnauthorized,
    });
    await vi.advanceTimersByTimeAsync(0);
    fail = new Error("network"); // 非失效错误：静默重试
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(deviceHeartbeatRunning()).toBe(true);
    expect(onUnauthorized).not.toHaveBeenCalled();
    fail = "UNAUTHORIZED"; // 凭证失效：停 + 回调
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(deviceHeartbeatRunning()).toBe(false);
    const calls = beat.mock.calls.length;
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2);
    expect(beat.mock.calls.length).toBe(calls); // 不再打拍
  });
});
