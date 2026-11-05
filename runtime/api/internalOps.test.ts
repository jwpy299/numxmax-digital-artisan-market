/** v180 内部工作台认领回路（纯规则） */
import { describe, expect, it } from "vitest";
import { canClaim, QUEUE_STATION } from "./routers/internalOps";
import { STATION_CODES } from "@contracts/stations"; // R7-c13-①：契约叶直引——路由不再二出口（同 training.test.ts 引 @contracts/distillPool 例，路由只作路由）

describe("认领互斥", () => {
  it("无主可认，有主即拒", () => {
    expect(canClaim(null)).toBe(true);
    expect(canClaim(7)).toBe(false);
  });
});
describe("队列→舱归属", () => {
  it("四类各归其舱", () => {
    expect(QUEUE_STATION.proposal).toBe("x_rel");
    expect(QUEUE_STATION.partner).toBe("x_ch");
    expect(QUEUE_STATION.market).toBe("x_mkt");
    expect(QUEUE_STATION.alert).toBe("x_ops");
  });
  it("四舱编制与超终同源", () => {
    expect(STATION_CODES).toEqual(["x_rel", "x_mkt", "x_fin", "x_ops", "x_runops", "x_law", "x_brand", "x_ch", "x_know"]); // R7-c6-①：九席队列舱典序（原四码断言过期——单源收编 contracts 后同钉全席；第十舱=舱上之舱不占队列位，口径见 contracts/stations.ts 头注）
  });
});
