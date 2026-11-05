import { useMemo, useRef, useState } from "react";
import { RefreshCw, ShieldCheck } from "lucide-react";
import {
  callWb,
  clearWbSession,
  isWbAuthError,
  useWbQuery,
  useWbSession,
  wbErrorMessage,
} from "@/lib/wbSession";
import {
  WbEmpty,
  WbError,
  WbLoading,
  WbNotice,
  WbPageHeader,
  WbPanel,
} from "@/components/wb/ui";
import { DeliveryDetail } from "@/components/wb/DeliveryDetail";
import { useModalFocusTrap } from "@/lib/useModalFocusTrap";
import {
  isDeterministicReviewRejection,
  reconcileCompletedReviewIds,
  type ReconciliationResult,
  pruneIds,
  AGENT_TRAINING_REVIEW_QUEUE_PATH,
  AGENT_TRAINING_REVIEW_TASK_PATH,
} from "@/lib/agentTrainingReviewQueue";
import {
  MIN_REVIEW_NOTE_LENGTH,
  REVIEW_NOTE_MAX_LENGTH,
  SCORE_MAX,
  SCORE_MIN,
} from "@contracts/agentEmploymentRules";
import type {
  AgentTrainingCycleOutcome as CycleOutcome,
  AgentTrainingRefundSettlement as RefundSettlement,
  AgentTrainingReviewItem,
  AgentTrainingReviewQueue,
} from "@contracts/agentEmploymentReview";

const OUTCOME_LABEL: Record<"qualified" | "awaiting_retake", string> = {
  qualified: "本周期已达标",
  awaiting_retake: "本周期未达标，可补考",
};
const REVIEW_READBACK_TIMEOUT_MS = 10_000;
const REFUND_LABEL: Partial<Record<RefundSettlement, string>> = {
  succeeded: "报名费已原路退回",
  pending_provider: "退款等待支付通道",
  pending_retry: "退款失败，等待重试",
  failed: "退款失败，需要人工核查",
};

function formatReviewDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString("zh-CN", { hour12: false });
}

function explicitScore(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isInteger(value) && value >= SCORE_MIN && value <= SCORE_MAX
    ? value
    : null;
}

export default function AgentTrainingReview() {
  const { session } = useWbSession();
  const queue = useWbQuery<AgentTrainingReviewQueue>(
    AGENT_TRAINING_REVIEW_QUEUE_PATH,
    session,
    {},
    { enabled: !!session?.token },
  );
  const [scores, setScores] = useState<Record<number, string>>({});
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<ReadonlySet<number>>(new Set());
  const [events, setEvents] = useState<
    { id: number; message: string; taskId?: number }[]
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] =
    useState<AgentTrainingReviewItem | null>(null);
  const [completedIds, setCompletedIds] = useState<ReadonlySet<number>>(
    new Set(),
  );
  const completedRef = useRef<ReadonlySet<number>>(new Set());
  const readbackGenerationRef = useRef(0);
  const readbackPromiseRef =
    useRef<Promise<ReconciliationResult | null> | null>(null);
  const [readbackPending, setReadbackPending] = useState(false);
  const validatedScores = useMemo<Record<number, number | null | undefined>>(
    () =>
      Object.fromEntries(
        Object.entries(scores).map(([id, raw]) => [
          Number(id),
          explicitScore(raw),
        ]),
      ),
    [scores],
  );
  const dialogRef = useRef<HTMLElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const refreshButtonRef = useRef<HTMLButtonElement>(null);
  const eventIdRef = useRef(0);
  useModalFocusTrap({
    open: Boolean(confirmation),
    containerRef: dialogRef,
    initialFocusRef: cancelButtonRef,
    restoreFocusRef: refreshButtonRef,
    onClose: () => setConfirmation(null),
  });

  function unlockIds(ids: readonly number[]): void {
    setBusy((previous) => {
      const next = new Set(previous);
      for (const id of ids) next.delete(id);
      return next;
    });
  }

  function updateCompleted(next: ReadonlySet<number>): void {
    completedRef.current = next;
    setCompletedIds(next);
  }

  /** 必须由调用方在 mutation 之后显式发起查询；queue.data 不作为请求代际证明。 */
  async function refreshAndReconcile(
    options: { afterMutation?: boolean } = {},
  ): Promise<ReconciliationResult | null> {
    // 手动连点共享在途请求；mutation 后必须发起新一代回读，旧请求只能作废。
    if (readbackPromiseRef.current && !options.afterMutation)
      return readbackPromiseRef.current;
    const generation = ++readbackGenerationRef.current;
    const promise = (async (): Promise<ReconciliationResult | null> => {
      setReadbackPending(true);
      const controller = new AbortController();
      const timeout = window.setTimeout(
        () => controller.abort(),
        REVIEW_READBACK_TIMEOUT_MS,
      );
      try {
        const fresh = await callWb<AgentTrainingReviewQueue>(
          "query",
          AGENT_TRAINING_REVIEW_QUEUE_PATH,
          session,
          {},
          { signal: controller.signal },
        );
        if (generation !== readbackGenerationRef.current) return null;
        queue.replaceData(fresh);
        const completed = completedRef.current;
        const visible = new Set(fresh.tasks.map((item) => item.id));
        const { reactivate, finished } = reconcileCompletedReviewIds(
          completed,
          visible,
        );
        const finishedForRemoval = fresh.truncated ? [] : finished;
        const reactivateSet = new Set(reactivate);
        const finishedSet = new Set(finishedForRemoval);
        if (reactivateSet.size > 0 || finishedSet.size > 0) {
          updateCompleted(
            new Set(
              [...completed].filter(
                (id) => !reactivateSet.has(id) && !finishedSet.has(id),
              ),
            ),
          );
          unlockIds([...reactivate, ...finished]);
        }
        if (reactivate.length > 0) {
          setScores((previous) => pruneIds(previous, reactivate));
          setNotes((previous) => pruneIds(previous, reactivate));
          setError(
            "回读显示部分任务仍在队列，已清空旧评分和意见，请重新确认后再提交。",
          );
        }
        if (finishedForRemoval.length > 0) {
          setScores((previous) => pruneIds(previous, finishedForRemoval));
          setNotes((previous) => pruneIds(previous, finishedForRemoval));
        }
        return { reactivate, finished: finishedForRemoval };
      } finally {
        window.clearTimeout(timeout);
        if (generation === readbackGenerationRef.current) {
          setReadbackPending(false);
          window.requestAnimationFrame(() => {
            const active = document.activeElement;
            if (
              !active ||
              active === document.body ||
              !document.contains(active)
            )
              refreshButtonRef.current?.focus();
          });
        }
      }
    })();
    readbackPromiseRef.current = promise;
    try {
      return await promise;
    } finally {
      if (readbackPromiseRef.current === promise)
        readbackPromiseRef.current = null;
    }
  }

  // queue.error 只提示回读失败；已成功评分保持锁定和隐藏，等待手动刷新确认服务端状态。

  async function review(item: AgentTrainingReviewItem) {
    const subject = `${item.agentName} · 第 ${item.attemptNo} 次 · 第 ${item.dayNo} 天：`;
    if (busy.has(item.id)) return;
    const score = validatedScores[item.id] ?? null;
    if (typeof score !== "number") {
      setError(
        `请显式填写 ${SCORE_MIN}—${SCORE_MAX} 的整数评分；空值不默认给分。`,
      );
      return;
    }
    setBusy((prev) => new Set(prev).add(item.id));
    setError(null);
    let result: {
      cycleOutcome: CycleOutcome;
      refundSettlement: RefundSettlement;
    };
    try {
      result = await callWb<typeof result>(
        "mutation",
        AGENT_TRAINING_REVIEW_TASK_PATH,
        session,
        {
          taskId: item.id,
          score,
          note: notes[item.id] ?? "",
        },
      );
    } catch (err) {
      if (isWbAuthError(err) || isDeterministicReviewRejection(err)) {
        if (isWbAuthError(err)) clearWbSession();
        setBusy((prev) => {
          const next = new Set(prev);
          next.delete(item.id);
          return next;
        });
        setError(`${subject}${wbErrorMessage(err)}`);
        void refreshAndReconcile({ afterMutation: true }).catch(
          (readbackError) => {
            if (isWbAuthError(readbackError)) clearWbSession();
            setError(
              `${subject}${wbErrorMessage(err)}；队列回读失败：${wbErrorMessage(readbackError)}`,
            );
          },
        );
        return;
      }
      // 仅网络中断/超时/5xx 属于结果未知：先按最新队列对账，不能直接解锁重复提交。
      setError(
        `${item.agentName} 的提交结果未知，正在按最新队列对账：${wbErrorMessage(err)}`,
      );
      updateCompleted(new Set(completedRef.current).add(item.id));
      try {
        const reconciliation = await refreshAndReconcile({
          afterMutation: true,
        });
        if (reconciliation === null) {
          setError(
            `${subject}提交结果未知，本次回读已被更新请求取代，请手动刷新核对最终状态。`,
          );
        } else if (reconciliation.reactivate.length === 0) {
          setError(
            `${subject}提交结果未知，已按最新队列对账，请核对队列状态。`,
          );
        }
      } catch (readbackError) {
        if (isWbAuthError(readbackError)) clearWbSession();
        setError(
          `${item.agentName} 的提交结果未知且回读失败，卡片保持锁定：${wbErrorMessage(readbackError)}`,
        );
      }
      return;
    }

    const completed = new Set(completedRef.current).add(item.id);
    updateCompleted(completed);
    let outcomeText: string | undefined;
    if (result.cycleOutcome === "disqualified") {
      outcomeText = queue.data?.rules.maxAttempts
        ? `${queue.data.rules.maxAttempts} 次均未达标，已剔除资格`
        : "全部训练机会均未达标，已剔除资格";
    } else if (result.cycleOutcome)
      outcomeText = OUTCOME_LABEL[result.cycleOutcome];
    const outcomeNotice = result.cycleOutcome
      ? `${outcomeText ?? "本周期状态已更新"}。`
      : "评分已留痕；本周期仍有其他日任务待复核。";
    const refundNote =
      result.refundSettlement === "not_requested"
        ? undefined
        : (REFUND_LABEL[result.refundSettlement] ?? "退款状态未知，请人工核查");
    const message = `${subject}${refundNote ? `${outcomeNotice}退款状态：${refundNote}。` : outcomeNotice}`;
    eventIdRef.current += 1;
    setEvents((previous) =>
      [{ id: eventIdRef.current, taskId: item.id, message }, ...previous].slice(
        0,
        5,
      ),
    );
    try {
      const reconciliation = await refreshAndReconcile({ afterMutation: true });
      if (reconciliation?.reactivate.includes(item.id)) {
        setEvents((previous) =>
          previous.filter((event) => event.taskId !== item.id),
        );
      }
    } catch (err) {
      if (isWbAuthError(err)) clearWbSession();
      setError(
        `${item.agentName} 的评分已提交，但队列回读失败：${wbErrorMessage(err)}。请使用刷新按钮完成核对。`,
      );
    }
  }

  if (!session?.token)
    return (
      <div className="p-6">
        <WbError message="需要有效的平台复核席会话，请重新登录。" />
      </div>
    );
  const rules = queue.data?.rules;
  const passRule = rules
    ? `周期达标线：${rules.cycleDays} 项平均分 ≥ ${rules.passScore}，且任一单日不得低于 ${rules.minTaskScore}。`
    : "正在读取周期达标线…";
  function reviewButtonText(item: AgentTrainingReviewItem): string {
    if (busy.has(item.id)) return "正在提交评分…";
    return "提交独立评分";
  }
  const visibleTasks = (queue.data?.tasks ?? []).filter(
    (item) => !completedIds.has(item.id),
  );
  function queueCounterText(): string {
    if (!queue.data) return "正在读取待审数量…";
    if (queue.data.truncated)
      return `待审 ${queue.data.total} 项（当前显示 ${visibleTasks.length} 条，最多 ${rules?.reviewQueueLimit ?? queue.data.tasks.length} 条）`;
    return `待审 ${visibleTasks.length} 项`;
  }
  return (
    <>
      <div
        className="space-y-6 p-6"
        inert={confirmation ? true : undefined}
        aria-hidden={confirmation ? true : undefined}
      >
        <WbPageHeader
          hud="PERSONAL AGENT · INDEPENDENT REVIEW"
          title="个人 Agent 隔离训练复核"
          desc={`${rules?.cycleDays ?? "若干"} 个日任务全部独立评分后才计算周期结果；${passRule}复核宽限期 ${rules?.reviewGraceDays ?? "若干"} 天。执行或提交不等于达标；本页不做模型权重训练，也不展示虚假自动评分。`}
        />
        <div className="flex items-center gap-3">
          <button
            ref={refreshButtonRef}
            aria-busy={readbackPending}
            onClick={() => {
              setError(null);
              void refreshAndReconcile().catch((err) => {
                if (isWbAuthError(err)) clearWbSession();
                setError(`队列回读失败：${wbErrorMessage(err)}`);
              });
            }}
            className="inline-flex items-center gap-2 rounded-lg border border-line-subtle px-3 py-2 text-xs"
          >
            <RefreshCw className="h-4 w-4" />
            {readbackPending ? "正在回读队列…" : "刷新待审队列"}
          </button>
          <span className="text-xs text-ink-faint">{queueCounterText()}</span>
        </div>
        <div role="status" aria-live="polite">
          {events.map((event) => (
            <WbNotice key={event.id} message={event.message} />
          ))}
        </div>
        <div role="alert" aria-live="assertive">
          {error && <WbError message={error} />}
        </div>
        {queue.error && <WbError message={queue.error} />}
        {queue.loading && <WbLoading text="读取真实训练交付" />}
        {queue.data &&
          !queue.loading &&
          !queue.error &&
          visibleTasks.length === 0 && (
            <WbEmpty
              text={
                completedIds.size > 0
                  ? "评分已提交，等待队列回读核对"
                  : "暂无待复核训练交付"
              }
              hint="个人 Agent 提交后才会进入本队列；未提交不预生成评分。"
            />
          )}
        {visibleTasks.map((item) => (
          <WbPanel key={item.id}>
            <div className="flex flex-wrap items-center gap-3">
              <ShieldCheck className="h-5 w-5 text-pulse-cyan" />
              <h2 className="font-semibold">
                {item.agentName} · 第 {item.attemptNo} 次 · 第 {item.dayNo} 天
              </h2>
              <span className="text-xs text-ink-faint">
                注册 #{item.registrationId} · 提交人 #{item.ownerUserId} · 提交{" "}
                {formatReviewDate(item.submittedAt)} · 周期截止{" "}
                {formatReviewDate(item.endsAt)}
              </span>
            </div>
            <h3 className="mt-4 text-sm font-medium">{item.title}</h3>
            <p className="mt-2 text-xs leading-6 text-ink-faint">
              {item.brief}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {item.rubric.map((rubric, index) => (
                <span
                  key={`${item.id}-${index}`}
                  className="rounded-full border border-line-subtle px-2 py-1 text-[11px] text-ink-faint"
                >
                  {rubric}
                </span>
              ))}
            </div>
            {Number(item.hasDeliverable) === 1 && (
              <DeliveryDetail
                path="agentTrainingReview.reviewDelivery"
                input={{ taskId: item.id }}
                resultKey="task"
                session={session}
                label="查看交付与证据"
                cacheKey={item.evidenceSha256}
              />
            )}
            <p className="mt-2 break-all font-mono text-[10px] text-ink-faint">
              证据 SHA-256：{item.evidenceSha256}
            </p>
            <p className="mt-3 text-xs text-forge-amber">{passRule}</p>
            <div className="mt-4 grid gap-3 md:grid-cols-[120px_1fr_auto]">
              <label className="text-xs text-ink-faint">
                评分（{SCORE_MIN}—{SCORE_MAX}）
                <input
                  type="number"
                  min={SCORE_MIN}
                  max={SCORE_MAX}
                  disabled={busy.has(item.id)}
                  value={scores[item.id] ?? ""}
                  onChange={(e) =>
                    setScores((prev) => ({
                      ...prev,
                      [item.id]: e.target.value,
                    }))
                  }
                  className="mt-1 w-full rounded-lg border border-line-subtle bg-void p-2 text-sm"
                />
                {(scores[item.id] ?? "") !== "" &&
                  typeof validatedScores[item.id] !== "number" && (
                    <span className="mt-1 block text-xs text-ember-red">
                      请输入 {SCORE_MIN}—{SCORE_MAX} 的整数；不默认给分。
                    </span>
                  )}
              </label>
              <label className="text-xs text-ink-faint">
                独立复核意见
                <textarea
                  rows={2}
                  maxLength={REVIEW_NOTE_MAX_LENGTH}
                  disabled={busy.has(item.id)}
                  value={notes[item.id] ?? ""}
                  onChange={(e) =>
                    setNotes((prev) => ({ ...prev, [item.id]: e.target.value }))
                  }
                  placeholder={`逐项说明评分依据（至少 ${MIN_REVIEW_NOTE_LENGTH} 个字）`}
                  className="mt-1 w-full rounded-lg border border-line-subtle bg-void p-2 text-sm"
                />
                {(notes[item.id] ?? "").trim().length > 0 &&
                  (notes[item.id] ?? "").trim().length <
                    MIN_REVIEW_NOTE_LENGTH && (
                    <span className="mt-1 block text-xs text-ember-red">
                      复核意见至少 {MIN_REVIEW_NOTE_LENGTH} 个字。
                    </span>
                  )}
              </label>
              <button
                disabled={
                  busy.has(item.id) ||
                  typeof validatedScores[item.id] !== "number" ||
                  (notes[item.id] ?? "").trim().length < MIN_REVIEW_NOTE_LENGTH
                }
                onClick={() => setConfirmation(item)}
                className="self-end rounded-lg bg-pulse-cyan px-4 py-2 text-xs font-semibold text-void disabled:opacity-40"
              >
                {reviewButtonText(item)}
              </button>
            </div>
          </WbPanel>
        ))}
      </div>
      {confirmation && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="取消独立复核确认"
            onClick={() => setConfirmation(null)}
            className="absolute inset-0 bg-black/70"
          />
          <section
            ref={dialogRef}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="agent-review-confirm-title"
            aria-describedby="agent-review-confirm-desc"
            className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-forge-amber/40 bg-panel p-5 shadow-2xl"
          >
            <h2
              id="agent-review-confirm-title"
              className="text-lg font-semibold"
            >
              确认提交不可撤回的独立评分
            </h2>
            <div id="agent-review-confirm-desc">
              <p className="mt-2 text-sm">
                {confirmation.agentName} · 第 {confirmation.attemptNo} 次 · 第{" "}
                {confirmation.dayNo} 天 · {confirmation.title}
              </p>
              <p className="mt-2 text-sm">
                评分：<strong>{validatedScores[confirmation.id]}</strong>
                ；复核意见：{notes[confirmation.id]}
              </p>
              <p className="mt-2 text-xs text-forge-amber">
                {passRule}
                提交后不能修改评分，可能直接改变就业资格并触发退款。请确认没有选错
                Agent 或任务。
              </p>
            </div>
            <div className="mt-4 flex gap-3">
              <button
                onClick={() => {
                  const item = confirmation;
                  setConfirmation(null);
                  void review(item);
                }}
                className="rounded-lg bg-pulse-cyan px-4 py-2 text-xs font-semibold text-void"
              >
                确认提交评分
              </button>
              <button
                ref={cancelButtonRef}
                onClick={() => setConfirmation(null)}
                className="rounded-lg border border-line-subtle px-4 py-2 text-xs"
              >
                取消
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
