export const AGENT_TRAINING_REVIEW_QUEUE_PATH =
  "agentTrainingReview.reviewQueue";
export const AGENT_TRAINING_REVIEW_TASK_PATH = "agentTrainingReview.reviewTask";
export interface ReconciliationResult {
  reactivate: number[];
  finished: number[];
}

/** 成功回读后的完成项对账：仍在队列必须恢复可操作，已消失才可清理编辑状态。 */
export function reconcileCompletedReviewIds(
  completed: ReadonlySet<number>,
  visible: ReadonlySet<number>,
) {
  const reactivate: number[] = [];
  const finished: number[] = [];
  for (const id of completed)
    (visible.has(id) ? reactivate : finished).push(id);
  return { reactivate, finished };
}

const DETERMINISTIC_REVIEW_CODES = new Set([
  "BAD_REQUEST",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "PRECONDITION_FAILED",
  "UNPROCESSABLE_CONTENT",
]);
const DETERMINISTIC_REVIEW_HTTP_STATUS = new Set([
  400, 403, 404, 409, 412, 422,
]);

export function isDeterministicReviewRejection(error: unknown): boolean {
  const data = (
    error as { data?: { code?: string; httpStatus?: number } } | null
  )?.data;
  if (data?.code && DETERMINISTIC_REVIEW_CODES.has(data.code)) return true;
  return (
    typeof data?.httpStatus === "number" &&
    DETERMINISTIC_REVIEW_HTTP_STATUS.has(data.httpStatus)
  );
}

export function pruneIds<T>(
  record: Record<number, T>,
  ids: readonly number[],
): Record<number, T> {
  const next = { ...record };
  for (const id of ids) delete next[id];
  return next;
}
