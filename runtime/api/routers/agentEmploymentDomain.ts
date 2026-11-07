/**
 * 个人 Agent 就业与隔离训练的中立规则。
 *
 * 本文件不接触数据库、支付通道或模型：只定义可独立复核的业务不变量。
 * “训练任务”指隔离环境中的模拟工作交付与独立评分，不代表模型权重训练。
 */
export { WORK_REVIEW_GRACE_DAYS, TRAINING_REVIEW_GRACE_DAYS } from "../../contracts/agentEmploymentRules";
import { createHash } from "node:crypto";
import { isAgentTestEconomy } from "../lib/agentEconomy";
import { JOB_TOKEN_CNY_CENTS, SCORE_MAX, SCORE_MIN } from "../../contracts/agentEmploymentRules";

export { JOB_TOKEN_CNY_CENTS };
export const REGISTRATION_FEE_JOB_TOKENS = 990;
export const RETAKE_FEE_JOB_TOKENS = 10;
export const REGISTRATION_FEE_CENTS = 9900;
export const RETAKE_FEE_CENTS = 100;
export const MAX_TRAINING_ATTEMPTS = 8;
export const TRAINING_CYCLE_DAYS = 7;
export const TRAINING_PASS_SCORE = 80;
export const TRAINING_MIN_TASK_SCORE = 60;

export type RegistrationStatus = "pending_payment" | "training" | "qualified" | "disqualified";
export type CycleStatus = "active" | "reviewing" | "passed" | "failed" | "expired";
export type TrainingOutcome = "qualified" | "awaiting_retake" | "disqualified";

export interface CycleScoreInput {
  scores: number[];
  attemptNo: number;
}

export function attemptFeeJobTokens(attemptNo: number): number {
  if (!Number.isInteger(attemptNo) || attemptNo < 1 || attemptNo > MAX_TRAINING_ATTEMPTS) {
    throw new Error("training_attempt_out_of_range");
  }
  if (!isAgentTestEconomy()) return 0;
  return attemptNo === 1 ? REGISTRATION_FEE_JOB_TOKENS : RETAKE_FEE_JOB_TOKENS;
}

export function attemptFeeCents(attemptNo: number): number {
  attemptFeeJobTokens(attemptNo);
  return attemptNo === 1 ? REGISTRATION_FEE_CENTS : RETAKE_FEE_CENTS;
}

export function validScore(score: number): boolean {
  return Number.isInteger(score) && score >= SCORE_MIN && score <= SCORE_MAX;
}

export const PERMANENT_REFUND_FAILURE_CODES = new Set(["registration_refund_origin_not_paid", "registration_refund_amount_invalid", "registration_refund_closed", "registration_refund_account_abnormal"]);

export const KNOWN_REFUND_FAILURE_CODES = new Set([
  ...PERMANENT_REFUND_FAILURE_CODES,
  "registration_refund_state_changed",
  "registration_refund_origin_state_changed",
]);

/** 数据面只保存稳定错误码；驱动、SQL、主机与连接细节只能留在服务端日志。 */
export function normalizeRefundFailureCode(error: unknown): string {
  if (error instanceof Error && KNOWN_REFUND_FAILURE_CODES.has(error.message)) return error.message;
  return "registration_refund_transient_failure";
}

/** 七项每日任务全部经过独立复核后才结算本周期；任何缺项都不是“达标”。 */
export function evaluateCycle(scores: number[]): { complete: boolean; passed: boolean; score: number | null } {
  if (scores.length !== TRAINING_CYCLE_DAYS || scores.some((s) => !validScore(s))) {
    return { complete: false, passed: false, score: null };
  }
  const score = Math.floor(scores.reduce((sum, value) => sum + value, 0) / TRAINING_CYCLE_DAYS);
  return {
    complete: true,
    passed: score >= TRAINING_PASS_SCORE && scores.every((value) => value >= TRAINING_MIN_TASK_SCORE),
    score,
  };
}

export function outcomeAfterCycle(input: CycleScoreInput & { passed: boolean }): TrainingOutcome {
  if (!Number.isInteger(input.attemptNo) || input.attemptNo < 1 || input.attemptNo > MAX_TRAINING_ATTEMPTS) {
    throw new Error("training_attempt_out_of_range");
  }
  if (input.scores.length !== TRAINING_CYCLE_DAYS) throw new Error("training_cycle_incomplete");
  const evaluation = evaluateCycle(input.scores);
  if (!evaluation.complete) throw new Error("training_cycle_incomplete");
  if (input.passed === false) return outcomeAfterFailedCycle(input.attemptNo);
  if (evaluation.passed) return "qualified";
  return outcomeAfterFailedCycle(input.attemptNo);
}

export function outcomeAfterFailedCycle(attemptNo: number): TrainingOutcome {
  if (!Number.isInteger(attemptNo) || attemptNo < 1 || attemptNo > MAX_TRAINING_ATTEMPTS) {
    throw new Error("training_attempt_out_of_range");
  }
  return attemptNo === MAX_TRAINING_ATTEMPTS ? "disqualified" : "awaiting_retake";
}

export function canAccessEmployment(status: RegistrationStatus): boolean {
  return status === "qualified";
}

export function evidenceSha256(deliverable: string): string {
  if (deliverable.trim().length === 0) throw new Error("delivery_evidence_required");
  return createHash("sha256").update(deliverable, "utf8").digest("hex");
}

export const TASK_CLAIM_TRANSITIONS = {
  claimed: ["submitted", "revoked"],
  submitted: ["accepted", "rejected", "revoked"],
  rejected: ["submitted", "claimed", "revoked"], // 同 Agent 返工、重新打开或释放给市场改派。
  accepted: [],
  revoked: [],
} as const;

export type TaskClaimStatus = keyof typeof TASK_CLAIM_TRANSITIONS;

export function canTransitionClaim(from: TaskClaimStatus, to: TaskClaimStatus): boolean {
  if (!Object.prototype.hasOwnProperty.call(TASK_CLAIM_TRANSITIONS, from)) return false;
  if (!Object.prototype.hasOwnProperty.call(TASK_CLAIM_TRANSITIONS, to)) return false;
  return (TASK_CLAIM_TRANSITIONS[from] as readonly string[]).includes(to);
}

export interface TrainingTaskDefinition {
  taskKey: string;
  title: string;
  brief: string;
  rubric: readonly string[];
}

/** 版本化模拟工作题库；由服务端按日释放，客户端不能自行挑选题目或改写评分标准。 */
export const TRAINING_TASK_BANK: readonly TrainingTaskDefinition[] = [
  {
    taskKey: "sandbox-v1-day1-requirements",
    title: "第 1 天：需求澄清与验收口径",
    brief: "阅读模拟企业需求，输出目标、非目标、约束、风险和可核验的验收标准。",
    rubric: ["目标与非目标分离", "验收标准可观察", "风险与依赖完整"],
  },
  {
    taskKey: "sandbox-v1-day2-plan",
    title: "第 2 天：任务拆解与执行计划",
    brief: "把模拟工作拆成有序步骤，说明输入、输出、回滚点和需要人工审批的动作。",
    rubric: ["步骤顺序合理", "每步输出明确", "审批与回滚边界明确"],
  },
  {
    taskKey: "sandbox-v1-day3-evidence",
    title: "第 3 天：执行记录与证据链",
    brief: "提交一份模拟执行记录，区分已执行、待复核和已验收，并给出证据哈希或回读值。",
    rubric: ["状态语义准确", "证据可复核", "不将执行等同交付"],
  },
  {
    taskKey: "sandbox-v1-day4-exception",
    title: "第 4 天：异常恢复与幂等",
    brief: "针对超时、重复回调和并发领取三个异常，设计恢复步骤并说明如何防止重复副作用。",
    rubric: ["覆盖三类异常", "幂等键与状态约束正确", "恢复不会重复结算"],
  },
  {
    taskKey: "sandbox-v1-day5-isolation",
    title: "第 5 天：权限与跨企业隔离",
    brief: "审查一份跨部门协作方案，指出越权风险并给出最小权限、租户隔离和撤销方案。",
    rubric: ["最小权限", "租户边界", "撤销后不可继续执行"],
  },
  {
    taskKey: "sandbox-v1-day6-delivery",
    title: "第 6 天：模拟工作交付",
    brief: "完成给定的模拟业务交付物，附自测结果、已知局限和独立复核所需材料。",
    rubric: ["交付物满足题目", "自测与局限真实", "复核材料完整"],
  },
  {
    taskKey: "sandbox-v1-day7-review",
    title: "第 7 天：复核响应与最终陈述",
    brief: "根据模拟复核意见修订交付，逐项回应发现，并明确哪些事项仍未完成。",
    rubric: ["逐项回应发现", "修订可验证", "未完成事项不隐瞒"],
  },
] as const;

export function trainingTaskForDay(dayNo: number): TrainingTaskDefinition {
  if (!Number.isInteger(dayNo) || dayNo < 1 || dayNo > TRAINING_CYCLE_DAYS) throw new Error("training_day_out_of_range");
  const task = TRAINING_TASK_BANK[dayNo - 1];
  if (!task) throw new Error("training_task_bank_incomplete");
  return task;
}
