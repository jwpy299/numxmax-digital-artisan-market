/**
 * Nebula Harness · 双运行时注册表（M69）—— DSH × Codex 组织版融合的事实源。
 *
 * 两个开源运行时全量内嵌（GitHub 全量源码，沙箱同构验证，生产同钉版服役）：
 * - DSH（DeepSeek Harness，deepseek-ai/deepseek-harness @ 47f9438）：
 *   重型智能体运行时——headless spawn 多步 DAG/长任务，经 dshClient（DSH_RUNTIME_URL 环回面）驱动；
 * - Codex Harness（openai/codex @ rust-v0.149.0）：
 *   施工智能体运行时——代码读取/改写/diff 产出，经 evoArm 施工臂（fail-closed）驱动，
 *   推理端点恒指海禛云统一网关（wire_api=responses 真钻实证），三端零直连外网。
 *
 * 组织版语义：两个运行时不各自为战，统一注册、统一健康面、统一台账（st_harness_runs）、
 * 统一自进化回路（信号→提案→draft→施工→C 级双签→verified）。本文件只做描述与路由建议，
 * 不改任何运行时内部行为（原来系统的功能不变）。
 */
import { DSH_RUNTIME_URL } from "../routers/dshClient"; // 端点单源（门禁 wb#71 钉）

import { armExecutorKind } from "../routers/evoArm";

export type RuntimeId = "dsh" | "codex";

export interface RuntimeHealth {
  /** 配置齐（env 在位） */
  configured: boolean;
  /** 可接任务（组织版口径：fail-closed 关闭时 ready=false 是正常态，不是故障） */
  ready: boolean;
  /** 人类可读一行说明（无密钥值） */
  detail: string;
}

export interface RuntimeDescriptor {
  id: RuntimeId;
  name: string;
  /** GitHub 全量源码出处 + 钉版 */
  origin: string;
  versionPin: string;
  /** 组织版分工 */
  role: string;
  /** 挂载的执行链 */
  lane: "dsh-runtime" | "codex-runtime";
  capabilities: readonly string[];
  health: () => RuntimeHealth;
}

/** DSH 运行时：重型级（多步 DAG / 长任务），经 DSH_RUNTIME_URL 服务化封装 spawn */
function dshHealth(): RuntimeHealth {
  const configured = Boolean((process.env.DSH_SERVICE_TOKEN ?? "").trim());
  return {
    configured,
    ready: configured,
    detail: configured
      ? `DSH 服务化封装在位（${DSH_RUNTIME_URL}，headless profile，忙线排队）` // 端点文案从 dshClient 单源引（门禁 wb#71 钉：类型非空=兜永不到=重复面删）
      : "缺 DSH_SERVICE_TOKEN——重型链不可用（历史事故 M67 已刻档）",
  };
}

/** Codex 运行时：施工级（代码任务），经 evoArm 施工臂，生产默认 fail-closed */
function codexHealth(): RuntimeHealth {
  const enabled = (process.env.EVO_ARM_ENABLED ?? "").trim() === "1";
  const executor = armExecutorKind();
  return {
    configured: enabled,
    ready: enabled,
    detail: enabled
      ? `施工臂开放（executor=${executor}，隔离工作区 /tmp 前缀强制）`
      : "fail-closed 关闭态（生产默认；EVO_ARM_ENABLED=1 才开放，且只接 st_releases draft 提案）",
  };
}

export const RUNTIME_REGISTRY: readonly RuntimeDescriptor[] = [
  {
    id: "dsh",
    name: "DeepSeek Harness",
    origin: "github.com/deepseek-ai/deepseek-harness",
    versionPin: "47f9438",
    role: "重型智能体运行时：多步 DAG、长任务、巡检批处理；NumX Max APP/工作台的重活底座",
    lane: "dsh-runtime",
    capabilities: ["dag", "long-task", "multi-step", "headless-spawn", "factory-isolation"],
    health: dshHealth,
  },
  {
    id: "codex",
    name: "Codex Harness",
    origin: "github.com/openai/codex",
    versionPin: "rust-v0.149.0",
    role: "施工智能体运行时：代码读取/改写/diff 产出；自进化回路的施工臂，AI 永不持扳机",
    lane: "codex-runtime",
    capabilities: ["code-edit", "repo-loop", "diff-output", "workspace-isolation", "proposal-gated"],
    health: codexHealth,
  },
] as const;

export function listRuntimes(): RuntimeDescriptor[] {
  return [...RUNTIME_REGISTRY];
}

export function getRuntime(id: RuntimeId): RuntimeDescriptor | undefined {
  return RUNTIME_REGISTRY.find((r) => r.id === id);
}

// ─── auto 路由建议（纯函数，四端调用方共用同一口径） ─────────────────────────

export interface RouteSuggestion {
  tier: "interactive" | "heavy" | "construction";
  runtime: RuntimeId | null;
  reason: string;
}

const CONSTRUCTION_HINTS = [
  "改代码", "修改代码", "修 bug", "修bug", "修复", "补丁", "重构", "施工", "改码",
  "diff", "refactor", "fix", "patch", "implement", "code",
] as const;
const HEAVY_HINTS = [
  "dag", "巡检", "长任务", "批处理", "批量", "多步", "编排执行", "流水线执行",
  "cron", "batch", "workflow",
] as const;

/**
 * 任务 → 执行链建议（不执行，只给口径；缺省 interactive 最保守）。
 * 关键词命中 construction 优先于 heavy——代码类任务必须进提案闸，宁严勿宽。
 */
export function routeTask(text: string): RouteSuggestion {
  const t = text.toLowerCase();
  if (CONSTRUCTION_HINTS.some((h) => t.includes(h.toLowerCase()))) {
    return {
      tier: "construction",
      runtime: "codex",
      reason: "命中代码/施工语义 → Codex 运行时（必须挂 st_releases draft 提案，C 级双签）",
    };
  }
  if (HEAVY_HINTS.some((h) => t.includes(h.toLowerCase()))) {
    return {
      tier: "heavy",
      runtime: "dsh",
      reason: "命中 DAG/长任务语义 → DSH 运行时（headless spawn，factoryId 下行隔离）",
    };
  }
  return {
    tier: "interactive",
    runtime: null,
    reason: "缺省交互级 → modelGateway 五槽直推（保首字时延）",
  };
}
