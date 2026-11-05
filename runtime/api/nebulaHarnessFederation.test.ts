/**
 * M74 环路联邦（大小环互联互通）纯函数测试。
 *
 * 覆盖：
 * 上行 escalateClusters：
 * 1. E1 共鸣：同 kind 同厂 ≥2 部门达阈 → 升企业环（合并 depts、totalCount 求和）；
 * 2. E2 烈度：单部门 ≥阈×3 → 升企业环；共鸣已吸收部门不重复升级；
 * 3. 留环：单部门达阈未达烈度 → stay_dept（部门环自治）；
 * 4. 未达阈聚集静默（不产生任何判定）；跨厂不合并（factoryId 隔离红线）；
 * 下行 planPropagation：
 * 5. 全厂成果 → 分发该厂全部部门（排序稳定）；部门定向 → targeted_only 不外溢；
 * 6. 无 skillKey 成果不产生分发动作。
 */
import { describe, expect, it } from "vitest";
import {
  escalateClusters, planPropagation, ESCALATE_FACTOR, RESONANCE_DEPTS,
  type DeptCluster,
} from "./harness/federation";

const TH = 4; // 例：crash 企业阈 3 → 部门阈 2；此处统一用 4 便于演算
const thOf = () => TH;
const F = 6290209;

describe("M74 上行：共鸣与烈度", () => {
  it("E1 共鸣：两部门同 kind 达阈 → 一次升级，depts 合并排序", () => {
    const clusters: DeptCluster[] = [
      { factoryId: F, deptKey: "ops", kind: "skill_fail", count: 5 },
      { factoryId: F, deptKey: "tech", kind: "skill_fail", count: 4 },
    ];
    const out = escalateClusters(clusters, thOf);
    expect(out).toEqual([
      { kind: "escalate_factory", factoryId: F, signalKind: "skill_fail", reason: "resonance",
        depts: ["ops", "tech"], totalCount: 9 },
    ]);
  });

  it("E2 烈度：单部门 ≥阈×3 升级；阈~阈×3 之间留部门环（异 kind 隔离共鸣）", () => {
    const clusters: DeptCluster[] = [
      { factoryId: F, deptKey: "gm", kind: "crash", count: TH * ESCALATE_FACTOR }, // 烈度
      { factoryId: F, deptKey: "legal", kind: "dag_fail", count: TH }, // 异 kind → 不共鸣，留环
    ];
    const out = escalateClusters(clusters, thOf);
    expect(out).toContainEqual(
      { kind: "escalate_factory", factoryId: F, signalKind: "crash", reason: "intensity", depts: ["gm"], totalCount: TH * ESCALATE_FACTOR },
    );
    expect(out).toContainEqual(
      { kind: "stay_dept", factoryId: F, deptKey: "legal", signalKind: "dag_fail", count: TH },
    );
  });

  it("共鸣优先：三部门达阈共鸣升级后不再单部门烈度重复", () => {
    const clusters: DeptCluster[] = [
      { factoryId: F, deptKey: "a", kind: "api_error", count: TH * ESCALATE_FACTOR + 5 },
      { factoryId: F, deptKey: "b", kind: "api_error", count: TH },
      { factoryId: F, deptKey: "c", kind: "api_error", count: TH },
    ];
    const out = escalateClusters(clusters, thOf);
    const esc = out.filter((e) => e.kind === "escalate_factory");
    expect(esc).toHaveLength(1); // 只有共鸣一次
    expect(esc[0]).toMatchObject({ reason: "resonance", depts: ["a", "b", "c"] });
    expect(out.filter((e) => e.kind === "stay_dept")).toHaveLength(0);
  });

  it("未达阈静默；跨厂同 kind 各自判定不合并（强隔离红线）", () => {
    const clusters: DeptCluster[] = [
      { factoryId: F, deptKey: "ops", kind: "tts_fail", count: TH - 1 }, // 未达阈
      { factoryId: F, deptKey: "ops", kind: "crash", count: TH },
      { factoryId: 9999999, deptKey: "x", kind: "crash", count: TH }, // 他厂
    ];
    const out = escalateClusters(clusters, thOf);
    // 两厂各自单部门达阈 → 各自 stay_dept，绝不跨厂共鸣
    expect(out).toEqual([
      { kind: "stay_dept", factoryId: F, deptKey: "ops", signalKind: "crash", count: TH },
      { kind: "stay_dept", factoryId: 9999999, deptKey: "x", signalKind: "crash", count: TH },
    ]);
    expect(RESONANCE_DEPTS).toBe(2);
  });
});

describe("M74 下行：成果分发", () => {
  const deptsOf = (f: number) => (f === F ? ["tech", "ops", "gm"] : []);

  it("全厂成果分发该厂全部部门（排序）；定向成果不外溢", () => {
    const out = planPropagation([
      { factoryId: F, skillKey: "voice-tune", deptKey: null },
      { factoryId: F, skillKey: "legal-faq", deptKey: "legal" },
    ], deptsOf);
    expect(out).toEqual([
      { kind: "propagate", factoryId: F, skillKey: "voice-tune", targetDepts: ["gm", "ops", "tech"] },
      { kind: "targeted_only", factoryId: F, skillKey: "legal-faq", deptKey: "legal" },
    ]);
  });

  it("无 skillKey 成果（纯调查结论）不产生分发动作", () => {
    const out = planPropagation([{ factoryId: F, skillKey: "", deptKey: null }], deptsOf);
    expect(out).toEqual([]);
  });
});
