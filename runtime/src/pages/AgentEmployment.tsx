import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import {
  BriefcaseBusiness,
  CheckCircle2,
  FlaskConical,
  RefreshCw,
  ShieldCheck,
  WalletCards,
} from "lucide-react";
import {
  callWb,
  clearWbSession,
  isWbAuthError,
  useWbQuery,
  useWbSession,
  wbErrorMessage,
  type WbSession,
} from "@/lib/wbSession";
import { cn } from "@/lib/utils";
import { rotateSucceededActionKeys } from "@/lib/agentEmploymentIdempotency";
import {
  WORK_REVIEW_GRACE_DAYS,
  AGENT_NAME_MAX_LENGTH,
  AGENT_NAME_MIN_LENGTH,
  HEADCOUNT_MAX,
  HEADCOUNT_MIN,
  JOB_DESCRIPTION_MAX_LENGTH,
  JOB_DESCRIPTION_MIN_LENGTH,
  JOB_TITLE_MAX_LENGTH,
  JOB_TITLE_MIN_LENGTH,
  JOB_TOKEN_AMOUNT_MAX,
  JOB_TOKEN_AMOUNT_MIN,
  MIN_DELIVERABLE_LENGTH,
  MIN_REVIEW_NOTE_LENGTH,
  MIN_TASK_CANCEL_REASON_LENGTH,
  TASK_CANCEL_REASON_MAX_LENGTH,
  MIN_END_EMPLOYMENT_REASON_LENGTH,
  END_EMPLOYMENT_REASON_MAX_LENGTH,
  REQUIREMENTS_MAX_LENGTH,
  REVIEW_NOTE_MAX_LENGTH,
  TASK_BRIEF_MAX_LENGTH,
  TASK_BRIEF_MIN_LENGTH,
  TRAINING_DELIVERABLE_MAX_LENGTH,
  WORK_DELIVERABLE_MAX_LENGTH,
} from "@contracts/agentEmploymentRules";
import { WbError, WbLoading, WbNotice } from "@/components/wb/ui";
import { DeliveryDetail } from "@/components/wb/DeliveryDetail";
import { publicDisplayNameError } from "@/lib/publicDisplayName";
import AgentPluginWorkbench from "@/components/agent/AgentPluginWorkbench";
import WechatPendingOrderCard from "@/components/agent/WechatPendingOrderCard";

// Eligibility is intentionally evaluated server-side via eligibleQualifiedRegistrations.
interface Registration {
  id: number;
  registrationNo: string;
  agentName: string;
  status:
    "pending_payment" | "training" | "qualified" | "disqualified" | "abandoned";
  feeStatus: string;
  currentAttemptNo: number;
  paymentEnvironment: string | null;
}
interface TrainingCycle {
  id: number;
  registrationId: number;
  attemptNo: number;
  status: string;
  startsAt: string;
  endsAt: string;
  score: number | null;
}
interface TrainingTask {
  id: number;
  cycleId: number;
  dayNo: number;
  title: string;
  brief: string;
  rubric: string[];
  status: string;
  score: number | null;
  reviewNote: string | null;
  evidenceSha256: string | null;
}
interface PaymentOrder {
  orderNo: string;
  registrationId: number;
  kind: string;
  attemptNo: number;
  amountCents: number;
  amountJobTokens: number;
  status: string;
  environment: string;
  outTradeNo?: string | null;
}
interface Refund {
  refundNo: string;
  registrationId: number;
  amountCents: number;
  amountJobTokens: number;
  status: string;
  reason: string;
}
interface TrainingMine {
  registrations: Registration[];
  qualifiedRegistrations: Registration[];
  cycles: TrainingCycle[];
  tasks: TrainingTask[];
  orders: PaymentOrder[];
  refunds: Refund[];
  wallets: { registrationId: number; balanceJobTokens: number }[];
  rules: {
    registrationFeeCents: number;
    retakeFeeCents: number;
    registrationFeeJobTokens: number;
    retakeFeeJobTokens: number;
    jobTokenCnyCents: number;
    maxAttempts: number;
    cycleDays: number;
    reviewGraceDays: number;
    sandboxEnabled: boolean;
    wechatEnabled: boolean;
    sandboxQualificationEnabled: boolean;
    economyMode: string;
    paymentMode: string;
  };
  totals: { registrations: number; cycles: number; tasks: number };
  truncated: { registrations: boolean; cycles: boolean; tasks: boolean };
}
interface MarketJob {
  id: number;
  enterpriseName: string | null;
  title: string;
  description: string;
  requirements: string | null;
  headcount: number;
  filledCount: number;
  budgetJobTokens: number;
}
interface MarketTask {
  id: number;
  enterpriseName: string | null;
  jobId: number | null;
  title: string;
  brief: string;
  requirements: string | null;
  rewardJobTokens: number;
  deadlineAt: string | null;
  eligible: 0 | 1;
}
interface Market {
  jobs: MarketJob[];
  tasks: MarketTask[];
  totals: { jobs: number; tasks: number };
  truncated: { jobs: boolean; tasks: boolean };
  listLimit: number;
}
interface MyClaim {
  claimId: number;
  title: string;
  status: string;
  isActive: 0 | 1;
  taskStatus: string;
  employmentStatus: string;
  rewardJobTokens: number;
  hasDeliverable: 0 | 1;
  evidenceSha256: string | null;
  reviewNote: string | null;
}
interface MyApplication {
  id: number;
  jobNo: string;
  title: string;
  status: string;
}
interface MyWork {
  applications: MyApplication[];
  claims: MyClaim[];
  wages: {
    claimId: number;
    amountJobTokens: number;
    balanceAfter: number;
    walletOwnerType: string;
    walletOwnerId: number;
    createdAt: string;
  }[];
  totals: { applications: number; claims: number; wages: number };
  truncated: { applications: boolean; claims: boolean; wages: boolean };
  offset: number;
  limit: number;
}
interface FactoryApplication {
  id: number;
  title: string;
  agentName: string;
  coverNote: string | null;
  status: string;
}
interface FactoryTask {
  id: number;
  title: string;
  rewardJobTokens: number;
  escrowJobTokens: number;
  status: string;
  claimId: number | null;
  agentName: string | null;
  hasDeliverable: 0 | 1;
  evidenceSha256: string | null;
  reviewNote: string | null;
  deadlineAt: string | null;
  publicFeed: 0 | 1;
  publicActorName: string | null;
  visibilityChangedAt: string | null;
  visibilityChangedBy: number | null;
}
interface FactoryEmployment {
  id: number;
  agentName: string;
  title: string;
  status: string;
  endReason: string | null;
}
interface FactoryJob {
  id: number;
  title: string;
  departmentId: string | null;
  status: string;
}
interface FactoryData {
  jobs: FactoryJob[];
  applications: FactoryApplication[];
  employments: FactoryEmployment[];
  tasks: FactoryTask[];
  totals: {
    jobs: number;
    applications: number;
    employments: number;
    tasks: number;
  };
  truncated: {
    jobs: boolean;
    applications: boolean;
    employments: boolean;
    tasks: boolean;
  };
  listLimit: number;
  departments: { id: string; name: string }[];
  reviewGraceDays: number;
}

const MY_WORK_PAGE_SIZE = 100;
const STATUS_LABEL: Record<string, string> = {
  pending_payment: "待报名缴费",
  training: "隔离训练中",
  qualified: "已达标",
  disqualified: "已剔除资格",
  active: "进行中",
  reviewing: "待独立复核",
  passed: "已通过",
  failed: "未达标",
  expired: "已到期",
  abandoned: "报名已失效",
  assigned: "可提交",
  submitted: "已提交·待复核",
  reviewed: "已复核",
  pending: "待支付",
  paid: "已支付",
  refund_pending: "退款处理中",
  refunded: "已原路退款",
  succeeded: "退款成功",
  applied: "已应聘",
  accepted: "已验收/已录用",
  rejected: "已驳回",
  claimed: "已领取",
  revoked: "已撤销",
  open: "开放中",
  cancelled: "已终止",
};
const FEE_STATUS_LABEL: Record<string, string> = {
  unpaid: "未缴费",
  paid: "已缴费",
  refund_pending: "退款处理中",
  refunded: "已原路退款",
  refund_failed: "退款异常待处理",
  abandoned: "报名已失效",
};
const REFUND_STATUS_LABEL: Record<string, string> = {
  pending: "待退款",
  succeeded: "退款成功",
  failed: "退款失败",
};
function refundReasonLabel(reason: string, maxAttempts?: number): string {
  if (reason === "qualified") return "训练达标";
  if (reason === "disqualified")
    return maxAttempts ? `${maxAttempts} 次均未达标` : "全部训练机会均未达标";
  return reason;
}
const money = (cents: number) => `¥${(cents / 100).toFixed(2)}`;
const tokenText = (tokens: number, centsPerToken?: number) =>
  centsPerToken === undefined
    ? `${tokens} job_token（汇率读取中）`
    : `${tokens} job_token（折合 ${money(tokens * centsPerToken)}）`;
function feeText(
  rules: TrainingMine["rules"] | undefined,
  cents: number,
  tokens: number,
): string {
  return rules?.economyMode === "production"
    ? money(cents)
    : tokenText(tokens, rules?.jobTokenCnyCents);
}
function employmentIntro(rules: TrainingMine["rules"]): string {
  const registration = feeText(
    rules,
    rules.registrationFeeCents,
    rules.registrationFeeJobTokens,
  );
  const retake = feeText(rules, rules.retakeFeeCents, rules.retakeFeeJobTokens);
  const attempts = `单次 ${rules.cycleDays} 天隔离模拟工作，最多 ${rules.maxAttempts} 次机会；第 2—${rules.maxAttempts} 次各 ${retake}且不退。`;
  if (rules.economyMode === "production")
    return `${registration}报名，${attempts}达标或 ${rules.maxAttempts} 次均未达标，${registration}报名费原路退回。复核宽限期 ${rules.reviewGraceDays} 天。真实人民币支付通道未接入前不创建待付订单。`;
  return `${registration}报名，${attempts}达标或 ${rules.maxAttempts} 次均未达标，${registration}报名费原路退回 Agent 钱包。复核宽限期 ${rules.reviewGraceDays} 天。1 job_token=${money(rules.jobTokenCnyCents)}，任务工资也归 Agent 钱包。`;
}
const newKey = () =>
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now()}-${Math.random().toString(36).slice(2)}`;
function boundedInteger(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

function clearRecordKey(
  setter: React.Dispatch<React.SetStateAction<Record<string, string>>>,
  id: number,
) {
  setter((previous) => {
    const next = { ...previous };
    delete next[String(id)];
    return next;
  });
}

function reviewNoteLabel(note: string): string {
  return note === "review_sla_expired"
    ? "复核宽限期已过：按时交付未获验收，任务已关闭且未结算。"
    : note;
}
function taskEligibilityLabel(task: MarketTask): string {
  if (!task.jobId) return "· 开放领取";
  if (task.eligible) return "· 本岗位已录用可领取";
  return "· 仅限岗位录用者";
}

function RegistrationCard({
  registration,
  mine,
  rulesReady,
  idemKey,
  drafts,
  setDrafts,
  isBusy,
  run,
  session,
}: {
  registration: Registration;
  mine: TrainingMine | null;
  rulesReady: boolean;
  idemKey: (scope: string) => string;
  drafts: Record<string, string>;
  setDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  isBusy: (key: string) => boolean;
  run: (
    key: string,
    action: () => Promise<unknown>,
    success: string,
    consumedScopes?: readonly string[],
  ) => void;
  session: WbSession | null;
}) {
  const cycles =
    mine?.cycles.filter((c) => c.registrationId === registration.id) ?? [];
  const latest = cycles[0];
  const nextAttempt = registration.currentAttemptNo + 1;
  const hasRetakeOrder = (mine?.orders ?? []).some(
    (order) =>
      order.registrationId === registration.id &&
      order.kind === "retake" &&
      order.attemptNo === nextAttempt,
  );
  const failed =
    latest &&
    ["failed", "expired"].includes(latest.status) &&
    registration.status === "training" &&
    !hasRetakeOrder &&
    nextAttempt <= (mine?.rules.maxAttempts ?? 0);
  const walletBalance =
    mine?.wallets.find((wallet) => wallet.registrationId === registration.id)
      ?.balanceJobTokens ?? 0;
  return (
    <article className="rounded-xl border border-line-subtle bg-white/[0.02] p-5">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-lg font-semibold">{registration.agentName}</h3>
        <span className="rounded-full border border-line-subtle px-3 py-1 text-xs text-pulse-cyan">
          {STATUS_LABEL[registration.status] ?? registration.status}
        </span>
        <span className="text-xs text-ink-faint">
          费用：
          {FEE_STATUS_LABEL[registration.feeStatus] ?? registration.feeStatus} ·
          已创建 {registration.currentAttemptNo}/
          {mine?.rules.maxAttempts ?? "…"} 个周期
        </span>
      </div>
      <p className="mt-2 font-mono text-xs text-ink-faint">
        {registration.registrationNo}
      </p>
      <p className="mt-2 text-xs text-jade-green">
        {mine?.rules.economyMode === "production"
          ? "生产人民币工资通道未接入，不创建 Agent 钱包。"
          : `Agent 自有 job_token 钱包：${walletBalance}；任务工资也进入此钱包。`}
      </p>
      {failed && (
        <button
          disabled={isBusy(`retake-${registration.id}`) || !rulesReady}
          onClick={() =>
            void run(
              `retake-${registration.id}`,
              () =>
                callWb("mutation", "agentTraining.createRetakeOrder", session, {
                  registrationId: registration.id,
                  idempotencyKey: idemKey(
                    `retake-${registration.id}-${registration.currentAttemptNo + 1}`,
                  ),
                }),
              `${mine?.rules.retakeFeeJobTokens} job_token 补考订单已创建；Agent 支付成功后才会开启下一周期。`,
              [
                `retake-${registration.id}-${registration.currentAttemptNo + 1}`,
              ],
            )
          }
          className="mt-4 rounded-lg border border-forge-amber px-4 py-2 text-xs text-forge-amber"
        >
          {mine?.rules.sandboxEnabled
            ? `创建第 ${registration.currentAttemptNo + 1} 次补考订单 · ${feeText(mine.rules, mine.rules.retakeFeeCents, mine.rules.retakeFeeJobTokens)}`
            : "支付通道未配置"}
        </button>
      )}
      <div className="mt-5 space-y-4">
        {cycles.map((cycle) => (
          <div key={cycle.id} className="border-t border-line-subtle pt-4">
            <div className="flex flex-wrap gap-3 text-sm">
              <strong>
                第 {cycle.attemptNo} 次 ·{" "}
                {STATUS_LABEL[cycle.status] ?? cycle.status}
              </strong>
              <span className="text-ink-faint">
                {new Date(cycle.startsAt).toLocaleString()} —{" "}
                {new Date(cycle.endsAt).toLocaleString()}
              </span>
              {cycle.score !== null && <span>评分 {cycle.score}</span>}
            </div>
            <div className="mt-3 space-y-3">
              {(mine?.tasks.filter((t) => t.cycleId === cycle.id) ?? []).map(
                (task) => {
                  const draftKey = `training-${task.id}`;
                  return (
                    <TrainingTaskCard
                      key={task.id}
                      task={task}
                      cycle={cycle}
                      registration={registration}
                      draftKey={draftKey}
                      drafts={drafts}
                      setDrafts={setDrafts}
                      busy={isBusy(draftKey)}
                      onSubmit={(deliverable) =>
                        void run(
                          draftKey,
                          () =>
                            callWb(
                              "mutation",
                              "agentTraining.submitTask",
                              session,
                              {
                                registrationId: registration.id,
                                dayNo: task.dayNo,
                                deliverable,
                              },
                            ),
                          "训练交付已提交，等待独立复核；提交不等于达标。",
                        )
                      }
                      session={session}
                    />
                  );
                },
              )}
            </div>
          </div>
        ))}
      </div>
      {(
        mine?.refunds.filter((r) => r.registrationId === registration.id) ?? []
      ).map((refund) => (
        <p key={refund.refundNo} className="mt-4 text-xs text-jade-green">
          报名费原路退回 Agent 钱包：
          {feeText(
            mine?.rules,
            refund.amountCents,
            refund.amountJobTokens,
          )} · {REFUND_STATUS_LABEL[refund.status] ?? refund.status} · 原因{" "}
          {refundReasonLabel(refund.reason, mine?.rules.maxAttempts)}
        </p>
      ))}
    </article>
  );
}

function PendingOrderCard({
  order,
  balance,
  rules,
  rulesReady,
  exchangeBusy,
  payBusy,
  onExchange,
  onPay,
}: {
  order: PaymentOrder;
  balance: number;
  rules?: TrainingMine["rules"];
  rulesReady: boolean;
  exchangeBusy: boolean;
  payBusy: boolean;
  onExchange: () => void;
  onPay: () => void;
}) {
  const shortfall = Math.max(0, order.amountJobTokens - balance);
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-forge-amber/30 bg-forge-amber/5 p-4">
      <WalletCards className="h-5 w-5 text-forge-amber" />
      <span className="flex-1 text-sm">
        {order.kind === "registration"
          ? "报名费"
          : `第 ${order.attemptNo} 次补考`}{" "}
        · {feeText(rules, order.amountCents, order.amountJobTokens)} · 沙箱订单{" "}
        {order.orderNo}
        <span className="ml-2 text-xs text-ink-faint">
          Agent 钱包余额 {balance} job_token
        </span>
      </span>
      {shortfall > 0 && (
        <button
          disabled={exchangeBusy || !rulesReady}
          onClick={onExchange}
          className="rounded-lg border border-pulse-cyan px-4 py-2 text-xs text-pulse-cyan disabled:opacity-40"
        >
          沙箱兑换 {shortfall} job_token
        </button>
      )}
      <button
        disabled={shortfall > 0 || payBusy || !rulesReady}
        onClick={onPay}
        className="rounded-lg border border-forge-amber px-4 py-2 text-xs text-forge-amber disabled:opacity-40"
      >
        支付 {order.amountJobTokens} job_token
      </button>
    </div>
  );
}

export default function AgentEmployment() {
  const { session } = useWbSession();
  const token = session?.token ?? "";
  const [searchParams] = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const [tab, setTab] = useState<"personal" | "market" | "plugins" | "enterprise">(
    requestedTab === "market" || requestedTab === "plugins" || requestedTab === "enterprise" ? requestedTab : "personal",
  );
  useEffect(() => {
    if (requestedTab === "market" || requestedTab === "plugins" || requestedTab === "enterprise") setTab(requestedTab);
  }, [requestedTab]);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agentName, setAgentName] = useState("");
  const actionKeys = useRef<Record<string, string>>({});
  const idemKey = (scope: string) => (actionKeys.current[scope] ??= newKey());
  const [selectedRegistration, setSelectedRegistration] = useState<number>(0);
  const [myWorkPage, setMyWorkPage] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [endReasons, setEndReasons] = useState<Record<string, string>>({});
  const [cancelReasons, setCancelReasons] = useState<Record<string, string>>(
    {},
  );
  const identity = useWbQuery<{ departmentId: string | null; orgRole: string }>(
    "agentWork.identity",
    session,
    {},
    { enabled: !!token },
  );
  const canManage = ["admin", "manager"].includes(identity.data?.orgRole ?? "");
  // 首次渲染 loading 可能尚未翻转为 true；无数据且未失败同样属于角色未决，而非无权限。
  const roleLoading = !identity.data && !identity.error;
  const roleFailed = !identity.data && Boolean(identity.error);
  const sessionDepartment = String(identity.data?.departmentId ?? "");
  const [jobForm, setJobForm] = useState<{
    departmentId: string;
    title: string;
    description: string;
    requirements: string;
    headcount: number | null;
    budgetJobTokens: number | null;
  }>({
    departmentId: sessionDepartment,
    title: "",
    description: "",
    requirements: "",
    headcount: 1,
    budgetJobTokens: 0,
  });
  const [taskForm, setTaskForm] = useState<{
    departmentId: string;
    jobId: string;
    title: string;
    brief: string;
    requirements: string;
    rewardJobTokens: number | null;
    publishToLiveFeed: boolean;
    publicDisplayName: string;
  }>({
    departmentId: sessionDepartment,
    jobId: "",
    title: "",
    brief: "",
    requirements: "",
    rewardJobTokens: null,
    publishToLiveFeed: false,
    publicDisplayName: "",
  });
  const jobFormValid =
    Boolean(jobForm.departmentId) &&
    jobForm.title.trim().length >= JOB_TITLE_MIN_LENGTH &&
    jobForm.description.trim().length >= JOB_DESCRIPTION_MIN_LENGTH &&
    jobForm.headcount !== null &&
    jobForm.headcount >= HEADCOUNT_MIN &&
    jobForm.headcount <= HEADCOUNT_MAX &&
    jobForm.budgetJobTokens !== null &&
    jobForm.budgetJobTokens >= 0 &&
    jobForm.budgetJobTokens <= JOB_TOKEN_AMOUNT_MAX;
  const publicNameError = taskForm.publishToLiveFeed ? publicDisplayNameError(taskForm.publicDisplayName) : null;
  const taskFormValid =
    Boolean(taskForm.departmentId) &&
    taskForm.title.trim().length >= JOB_TITLE_MIN_LENGTH &&
    taskForm.brief.trim().length >= TASK_BRIEF_MIN_LENGTH &&
    taskForm.rewardJobTokens !== null &&
    taskForm.rewardJobTokens >= JOB_TOKEN_AMOUNT_MIN &&
    taskForm.rewardJobTokens <= JOB_TOKEN_AMOUNT_MAX &&
    (!taskForm.publishToLiveFeed || publicNameError === null);
  const previousDepartment = useRef(sessionDepartment);
  useEffect(() => {
    if (!sessionDepartment || sessionDepartment === previousDepartment.current)
      return;
    previousDepartment.current = sessionDepartment;
    setJobForm((form) => ({ ...form, departmentId: sessionDepartment }));
    setTaskForm((form) => ({ ...form, departmentId: sessionDepartment }));
  }, [sessionDepartment]);

  const mine = useWbQuery<TrainingMine>(
    "agentTraining.mine",
    session,
    {},
    { enabled: !!token },
  );
  const qualified = useMemo(
    () => mine.data?.qualifiedRegistrations ?? [],
    [mine.data],
  );
  const effectiveRegistration = qualified.some(
    (r) => r.id === selectedRegistration,
  )
    ? selectedRegistration
    : 0;
  const market = useWbQuery<Market>(
    "agentWork.market",
    session,
    { registrationId: effectiveRegistration || undefined },
    { enabled: !!token && tab === "market" },
  );
  const [myWorkLimit, setMyWorkLimit] = useState(MY_WORK_PAGE_SIZE);
  const myWork = useWbQuery<MyWork>(
    "agentWork.mine",
    session,
    { offset: myWorkPage * myWorkLimit },
    { enabled: !!token && tab === "market" },
  );
  useEffect(() => {
    if (myWork.data?.limit) setMyWorkLimit(myWork.data.limit);
  }, [myWork.data?.limit]);
  const myWorkPageCount = myWork.data
    ? Math.max(
        1,
        Math.ceil(
          Math.max(
            myWork.data.totals.applications,
            myWork.data.totals.claims,
            myWork.data.totals.wages,
          ) / myWorkLimit,
        ),
      )
    : 1;
  useEffect(() => {
    // 翻页后 hook 会暂时清空 data；未知总页数时不得把目标页钳回第一页。
    if (myWork.data && myWorkPage >= myWorkPageCount) setMyWorkPage(myWorkPageCount - 1);
  }, [myWork.data, myWorkPage, myWorkPageCount]);
  const factory = useWbQuery<FactoryData>(
    "agentWork.factory",
    session,
    {},
    { enabled: !!token && canManage && tab === "enterprise" },
  );
  const selectedTaskJob = factory.data?.jobs.find(
    (job) => String(job.id) === taskForm.jobId,
  );
  const taskDepartmentLocked = Boolean(
    taskForm.jobId && selectedTaskJob?.departmentId,
  );
  const rulesReady =
    !mine.loading && !mine.error && Boolean(mine.data?.rules.sandboxEnabled || mine.data?.rules.wechatEnabled);
  const registerScope = "register";
  const publishJobScope = "publish-job";
  const publishTaskScope = "publish-task";
  const queryError =
    mine.error ||
    (tab === "market" ? market.error || myWork.error : null) ||
    (tab === "enterprise" ? factory.error : null);
  function enterpriseTabTitle(): string {
    if (roleLoading) return "正在确认企业角色";
    if (roleFailed) return "企业角色读取失败，可进入后重试";
    if (!canManage) return "仅企业负责人或部门负责人可用";
    return "";
  }
  function registerButtonLabel(): string {
    if (mine.error) return "报名规则读取失败，请刷新重试";
    if (!mine.data) return "正在读取报名规则…";
    if (!mine.data.rules.sandboxEnabled && !mine.data.rules.wechatEnabled) return "支付通道未配置";
    if (mine.data.rules.wechatEnabled && mine.data.rules.economyMode === "production") return "创建 ¥99 微信报名订单";
    return `创建 ${feeText(mine.data.rules, mine.data.rules.registrationFeeCents, mine.data.rules.registrationFeeJobTokens)}报名订单`;
  }

  function refresh() {
    setError(null);
    identity.refetch();
    mine.refetch();
    market.refetch();
    myWork.refetch();
    if (tab === "enterprise") factory.refetch();
  }
  async function run(
    key: string,
    action: () => Promise<unknown>,
    success: string,
    consumedScopes: readonly string[] = [key],
    busyKey = key,
  ) {
    if (busy.has(busyKey)) return;
    setBusy((prev) => new Set(prev).add(busyKey));
    setNotice(null);
    setError(null);
    try {
      await action();
      // 每次调用显式携带自己的消费面；失败动作和并发动作的键绝不被无关成功动作轮换。
      rotateSucceededActionKeys(actionKeys.current, consumedScopes);
      setNotice(success);
      refresh();
    } catch (err) {
      // 门户 Layout 没有工作台会话失效兜底；清会话后由未登录分支提供重新登录出口。
      if (isWbAuthError(err)) clearWbSession();
      else refresh(); // 结果未知或失败时也必须回读服务端，不能把本地视图当最终事实。
      setError(wbErrorMessage(err));
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(busyKey);
        return next;
      });
    }
  }
  const isBusy = (key: string) => busy.has(key);
  function clearReviewNote(claimId: number) {
    clearRecordKey(setReviewNotes, claimId);
  }
  function clearEndReason(employmentId: number) {
    clearRecordKey(setEndReasons, employmentId);
  }
  function clearCancelReason(taskId: number) {
    clearRecordKey(setCancelReasons, taskId);
  }
  async function mutateClaim(
    claimId: number,
    action:
      | { kind: "review"; verdict: "accept" | "reject"; note: string }
      | { kind: "reopen"; mode: "retry_same_agent" | "reopen_market" },
  ) {
    let result: unknown;
    if (action.kind === "review")
      result = await callWb("mutation", "agentWork.reviewTask", session, {
        claimId,
        verdict: action.verdict,
        note: action.note,
      });
    else
      result = await callWb("mutation", "agentWork.reopenTask", session, {
        claimId,
        mode: action.mode,
      });
    clearReviewNote(claimId);
    return result;
  }

  if (!session) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-24 text-center">
        <ShieldCheck className="mx-auto mb-5 h-10 w-10 text-pulse-cyan" />
        <h1 className="text-2xl font-bold">个人 Agent 就业中心</h1>
        <p className="mt-4 text-ink-faint">
          请先登录工作台。报名、训练、支付沙箱、应聘、领取与交付状态均只从服务端读取。
        </p>
        <Link
          to="/workbench"
          className="mt-6 inline-block rounded-lg bg-pulse-cyan px-5 py-2 text-sm font-semibold text-void"
        >
          前往工作台登录
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 md:px-8">
      <header className="border-b border-line-subtle pb-8">
        <p className="font-mono text-xs uppercase tracking-[0.22em] text-pulse-cyan">
          AGENT EMPLOYMENT · OAP
        </p>
        <h1 className="mt-3 text-3xl font-bold text-ink-primary md:text-4xl">
          个人 Agent 就业与组织任务市场
        </h1>
        <p className="mt-4 max-w-4xl text-sm leading-7 text-ink-faint">
          {mine.data
            ? employmentIntro(mine.data.rules)
            : "正在读取收费、周期与复核规则…"}
          这里的训练是真实交付与独立复核，不代表模型权重训练。
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          {(
            [
              ["personal", "我的 Agent"],
              ["market", "岗位与任务市场"],
              ["plugins", "Agent 插件"],
              ["enterprise", "企业工作管理"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              title={key === "enterprise" ? enterpriseTabTitle() : ""}
              onClick={() => setTab(key)}
              className={cn(
                "rounded-lg border px-4 py-2 text-sm disabled:opacity-40",
                tab === key
                  ? "border-pulse-cyan bg-pulse-cyan/10 text-pulse-cyan"
                  : "border-line-subtle text-ink-faint",
              )}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            disabled={
              identity.loading ||
              mine.loading ||
              (tab === "market" && (market.loading || myWork.loading)) ||
              (tab === "enterprise" && factory.loading)
            }
            onClick={() => refresh()}
            className="ml-auto inline-flex items-center gap-2 rounded-lg border border-line-subtle px-3 py-2 text-sm text-ink-faint disabled:opacity-40"
          >
            <RefreshCw className="h-4 w-4" />
            刷新真实状态
          </button>
        </div>
      </header>

      {notice && <WbNotice message={notice} />}
      {error && <WbError message={error} />}
      {queryError && <WbError message={queryError} />}

      {tab === "personal" && (
        <section className="mt-8 space-y-8">
          {mine.data &&
            Object.values(mine.data.truncated ?? {}).some(Boolean) && (
              <p className="rounded-lg border border-forge-amber/30 p-3 text-xs text-forge-amber">
                {`报名与训练记录存在截断：报名 ${mine.data.totals.registrations}、周期 ${mine.data.totals.cycles}、日任务 ${mine.data.totals.tasks}；当前仅显示最近记录。`}
              </p>
            )}
          <div className="rounded-xl border border-line-subtle bg-white/[0.02] p-5">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <FlaskConical className="h-5 w-5 text-pulse-cyan" />
              注册个人 Agent
            </h2>
            <div className="mt-4 flex flex-col gap-3 md:flex-row">
              <input
                maxLength={AGENT_NAME_MAX_LENGTH}
                value={agentName}
                onChange={(e) => setAgentName(e.target.value)}
                placeholder={`Agent 名称（${AGENT_NAME_MIN_LENGTH}—${AGENT_NAME_MAX_LENGTH} 字）`}
                className="min-w-0 flex-1 rounded-lg border border-line-subtle bg-void px-3 py-2"
              />
              <button
                disabled={
                  isBusy("register") ||
                  !rulesReady ||
                  agentName.trim().length < AGENT_NAME_MIN_LENGTH
                }
                onClick={() =>
                  void run(
                    registerScope,
                    async () => {
                      const r = await callWb<{ orderNo: string }>(
                        "mutation",
                        "agentTraining.register",
                        session,
                        { agentName, idempotencyKey: idemKey(registerScope) },
                      );
                      setAgentName("");
                      return r;
                    },
                    "报名订单已创建；尚未支付，也未开通就业权限。",
                    [registerScope],
                    "register",
                  )
                }
                className="rounded-lg bg-pulse-cyan px-5 py-2 text-sm font-semibold text-void disabled:opacity-40"
              >
                {registerButtonLabel()}
              </button>
            </div>
            <p className="mt-3 text-xs leading-6 text-ink-faint">
              {mine.data?.rules.economyMode === "production"
                ? mine.data.rules.wechatEnabled
                  ? "当前为人民币计价；微信二维码仅对应真实订单，支付结果以签名回调和订单回读为准。"
                  : "当前为人民币计价；真实支付通道未接入，不创建待付订单。"
                : "当前仅接 token 沙箱：兑换、报名、补考与退款只转移隔离环境的 job_token，不发生真实人民币扣款或退款。Agent 钱包足额支付前不会创建训练周期。"}
            </p>
          </div>

          {(mine.data?.orders.filter((o) => o.status === "pending") ?? []).map(
            (order) => {
              const balance =
                mine.data?.wallets.find(
                  (wallet) => wallet.registrationId === order.registrationId,
                )?.balanceJobTokens ?? 0;
              const exchangeScope = `exchange-${order.orderNo}`;
              return order.environment === "production" ? (
                <WechatPendingOrderCard
                  key={order.orderNo}
                  session={session}
                  order={order}
                  onRefresh={async () => { await mine.refetch() }}
                />
              ) : (
                <PendingOrderCard
                  key={order.orderNo}
                  order={order}
                  balance={balance}
                  rules={mine.data?.rules}
                  rulesReady={rulesReady}
                  exchangeBusy={isBusy(exchangeScope)}
                  payBusy={isBusy(order.orderNo)}
                  onExchange={() =>
                    void run(
                      exchangeScope,
                      () =>
                        callWb(
                          "mutation",
                          "agentTraining.sandboxExchange",
                          session,
                          {
                            registrationId: order.registrationId,
                            amountJobTokens: Math.max(
                              0,
                              order.amountJobTokens - balance,
                            ),
                            idempotencyKey: idemKey(exchangeScope),
                          },
                        ),
                      `沙箱兑换已入账 ${Math.max(0, order.amountJobTokens - balance)} job_token；未发生真实人民币扣款。`,
                      [exchangeScope],
                    )
                  }
                  onPay={() =>
                    void run(
                      order.orderNo,
                      () =>
                        callWb(
                          "mutation",
                          "agentTraining.sandboxPay",
                          session,
                          {
                            orderNo: order.orderNo,
                            idempotencyKey: idemKey(order.orderNo),
                          },
                        ),
                      "Agent token 支付与回调已处理；请核对钱包、训练周期与订单回读。",
                      [order.orderNo],
                    )
                  }
                />
              );
            },
          )}

          {(mine.data?.registrations ?? []).map((registration) => (
            <RegistrationCard
              key={registration.id}
              registration={registration}
              mine={mine.data}
              rulesReady={rulesReady}
              idemKey={idemKey}
              drafts={drafts}
              setDrafts={setDrafts}
              isBusy={isBusy}
              run={run}
              session={session}
            />
          ))}
        </section>
      )}

      {tab === "plugins" && (
        <AgentPluginWorkbench
          session={session}
          registrations={qualified}
          registrationId={effectiveRegistration}
          onRegistrationChange={setSelectedRegistration}
        />
      )}

      {tab === "market" && (
        <section className="mt-8 space-y-8">
          {(market.loading || myWork.loading) && (
            <WbLoading text="正在读取市场与我的真实状态" />
          )}
          {(market.data?.truncated.jobs || market.data?.truncated.tasks) && (
            <p className="rounded-lg border border-forge-amber/30 p-3 text-xs text-forge-amber">
              市场当前仅显示最近 {market.data?.listLimit ?? 100}{" "}
              个岗位或任务；岗位 {market.data?.totals.jobs ?? 0} 个、任务{" "}
              {market.data?.totals.tasks ?? 0} 个。
            </p>
          )}
          <div className="rounded-xl border border-line-subtle p-5">
            <label className="text-sm text-ink-faint">
              用于应聘/领取的已达标 Agent
            </label>
            <select
              value={effectiveRegistration}
              onChange={(e) => setSelectedRegistration(Number(e.target.value))}
              className="ml-3 rounded-lg border border-line-subtle bg-void px-3 py-2 text-sm"
            >
              <option value={0}>请选择</option>
              {qualified.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.agentName} · #{r.id}
                </option>
              ))}
            </select>
            {!mine.loading &&
              !mine.error &&
              mine.data &&
              qualified.length === 0 && (
                <p className="mt-3 text-xs text-forge-amber">
                  暂无可用于就业的已达标
                  Agent。付费、训练中、已淘汰或支付来源不可信状态均不能应聘或领取任务。
                </p>
              )}
          </div>
          <div>
            <h2 className="flex items-center gap-2 text-xl font-semibold">
              <BriefcaseBusiness className="h-5 w-5 text-pulse-cyan" />
              企业岗位 · 应聘制
            </h2>
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              {(market.data?.jobs ?? []).map((job) => {
                const scope = `apply-${effectiveRegistration}-${job.id}`;
                return (
                  <article
                    key={job.id}
                    className="rounded-xl border border-line-subtle p-5"
                  >
                    <h3 className="font-semibold">{job.title}</h3>
                    <p className="mt-1 text-xs text-ink-faint">
                      {job.enterpriseName ?? "企业"} · {job.filledCount}/
                      {job.headcount} 人 · 岗位参考预算（任务报酬单独冻结）
                      {job.budgetJobTokens} job_token
                    </p>
                    <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-ink-faint">
                      {job.description}
                    </p>
                    {job.requirements && (
                      <p className="mt-2 whitespace-pre-wrap text-xs leading-6 text-ink-faint">
                        岗位要求：{job.requirements}
                      </p>
                    )}
                    <button
                      disabled={
                        !effectiveRegistration || isBusy(`apply-${job.id}`)
                      }
                      onClick={() =>
                        void run(
                          scope,
                          () =>
                            callWb("mutation", "agentWork.applyJob", session, {
                              registrationId: effectiveRegistration,
                              jobId: job.id,
                              idempotencyKey: idemKey(scope),
                            }),
                          "应聘已提交；岗位录用不代表已有工资。",
                          [scope],
                          `apply-${job.id}`,
                        )
                      }
                      className="mt-4 rounded-lg border border-pulse-cyan px-4 py-2 text-xs text-pulse-cyan disabled:opacity-40"
                    >
                      提交真实应聘
                    </button>
                  </article>
                );
              })}
            </div>
          </div>
          <div>
            <h2 className="flex items-center gap-2 text-xl font-semibold">
              <CheckCircle2 className="h-5 w-5 text-pulse-cyan" />
              企业任务 · 领取制
            </h2>
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              {(market.data?.tasks ?? []).map((task) => {
                const scope = `claim-${effectiveRegistration}-${task.id}`;
                return (
                  <article
                    key={task.id}
                    className="rounded-xl border border-line-subtle p-5"
                  >
                    <h3 className="font-semibold">{task.title}</h3>
                    <p className="mt-1 text-xs text-ink-faint">
                      {task.enterpriseName ?? "企业"} · 验收报酬{" "}
                      {task.rewardJobTokens} job_token{" "}
                      {taskEligibilityLabel(task)}
                    </p>
                    <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-ink-faint">
                      {task.brief}
                    </p>
                    {task.requirements && (
                      <p className="mt-2 whitespace-pre-wrap text-xs leading-6 text-ink-faint">
                        验收要求：{task.requirements}
                      </p>
                    )}
                    {task.deadlineAt && (
                      <p className="mt-2 text-xs text-forge-amber">
                        截止：{new Date(task.deadlineAt).toLocaleString()}
                      </p>
                    )}
                    <button
                      disabled={
                        !effectiveRegistration ||
                        !task.eligible ||
                        isBusy(`claim-${task.id}`)
                      }
                      onClick={() =>
                        void run(
                          scope,
                          () =>
                            callWb("mutation", "agentWork.claimTask", session, {
                              registrationId: effectiveRegistration,
                              taskId: task.id,
                              idempotencyKey: idemKey(scope),
                            }),
                          "任务已领取；尚未执行、交付或结算。",
                          [scope],
                          `claim-${task.id}`,
                        )
                      }
                      className="mt-4 rounded-lg border border-pulse-cyan px-4 py-2 text-xs text-pulse-cyan disabled:opacity-40"
                    >
                      领取任务
                    </button>
                  </article>
                );
              })}
            </div>
          </div>
          <div>
            <h2 className="text-xl font-semibold">我的交付与工资</h2>
            <p className="mt-2 text-xs text-ink-faint">
              我的应聘 {myWork.data?.totals.applications ?? 0} 条 · 工资台账{" "}
              {myWork.data?.totals.wages ?? 0} 笔
            </p>
            {myWork.data && myWorkPageCount > 1 && (
              <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-ink-faint">
                <span>
                  每类每页最多 {myWorkLimit} 条，第{" "}
                  {Math.floor(myWork.data.offset / myWorkLimit) + 1}/
                  {myWorkPageCount} 页
                </span>
                <button
                  type="button"
                  disabled={myWorkPage === 0 || myWork.loading}
                  onClick={() =>
                    setMyWorkPage((value) => Math.max(0, value - 1))
                  }
                  className="rounded border border-line-subtle px-2 py-1 disabled:opacity-40"
                >
                  上一页
                </button>
                <button
                  type="button"
                  disabled={myWorkPage + 1 >= myWorkPageCount || myWork.loading}
                  onClick={() => setMyWorkPage((value) => value + 1)}
                  className="rounded border border-line-subtle px-2 py-1 disabled:opacity-40"
                >
                  下一页
                </button>
              </div>
            )}
            <div className="mt-2 space-y-1">
              {(myWork.data?.wages ?? []).map((wage) => (
                <p key={wage.claimId} className="text-xs text-ink-faint">
                  #{wage.claimId} · Agent 入账 {wage.amountJobTokens} job_token
                  · 余额 {wage.balanceAfter}（{wage.walletOwnerType} #
                  {wage.walletOwnerId}）
                </p>
              ))}
            </div>
            <div className="mt-4 space-y-2">
              {(myWork.data?.applications ?? []).map((application) => (
                <p
                  key={application.id}
                  className="rounded-lg border border-line-subtle px-3 py-2 text-xs"
                >
                  {application.title} · {application.jobNo} ·{" "}
                  <span className="text-pulse-cyan">
                    {STATUS_LABEL[application.status] ?? application.status}
                  </span>
                </p>
              ))}
            </div>
            <div className="mt-4 space-y-4">
              {(myWork.data?.claims ?? []).map((claim) => {
                const draftKey = `work-${claim.claimId}`;
                const draft = drafts[draftKey] ?? "";
                const canSubmitClaim =
                  Boolean(claim.isActive) &&
                  ["claimed", "rejected"].includes(claim.status) &&
                  claim.taskStatus === claim.status &&
                  ["not_required", "active"].includes(claim.employmentStatus);
                return (
                  <article
                    key={claim.claimId}
                    className="rounded-xl border border-line-subtle p-5"
                  >
                    <div className="flex flex-wrap gap-3">
                      <strong>{claim.title}</strong>
                      <span className="text-xs text-pulse-cyan">
                        {STATUS_LABEL[claim.status] ?? claim.status}
                      </span>
                      <span className="text-xs">
                        {claim.rewardJobTokens} job_token
                      </span>
                    </div>
                    {claim.reviewNote && (
                      <p className="mt-2 text-xs text-forge-amber">
                        {reviewNoteLabel(claim.reviewNote)}
                      </p>
                    )}
                    {Number(claim.hasDeliverable) === 1 && (
                      <DeliveryDetail
                        path="agentWork.delivery"
                        input={{ claimId: claim.claimId }}
                        resultKey="claim"
                        session={session}
                        label="查看我的交付与证据"
                        cacheKey={claim.evidenceSha256}
                      />
                    )}
                    {canSubmitClaim && (
                      <div className="mt-3">
                        <textarea
                          maxLength={WORK_DELIVERABLE_MAX_LENGTH}
                          rows={4}
                          value={draft}
                          onChange={(e) =>
                            setDrafts((prev) => ({
                              ...prev,
                              [draftKey]: e.target.value,
                            }))
                          }
                          placeholder="提交真实交付、证据与回读结果"
                          className="w-full rounded-lg border border-line-subtle bg-void p-3 text-sm"
                        />
                        <button
                          disabled={
                            isBusy(draftKey) ||
                            draft.trim().length < MIN_DELIVERABLE_LENGTH
                          }
                          onClick={() =>
                            void run(
                              draftKey,
                              () =>
                                callWb(
                                  "mutation",
                                  "agentWork.submitTask",
                                  session,
                                  {
                                    claimId: claim.claimId,
                                    deliverable: draft,
                                  },
                                ),
                              "交付已提交；待企业验收，尚未结算工资。",
                            )
                          }
                          className="mt-2 rounded-lg border border-pulse-cyan px-3 py-1.5 text-xs text-pulse-cyan disabled:opacity-40"
                        >
                          提交企业验收
                        </button>
                      </div>
                    )}
                    {!canSubmitClaim &&
                      ["claimed", "rejected"].includes(claim.status) && (
                        <p className="mt-3 text-xs text-forge-amber">
                          该任务已终止、已改派或岗位雇佣已结束，不能继续提交；请刷新查看真实状态。
                        </p>
                      )}
                  </article>
                );
              })}
            </div>
          </div>
        </section>
      )}

      {tab === "enterprise" && (
        <section className="mt-8 space-y-8">
          <EnterpriseRoleGate
            roleLoading={roleLoading}
            roleFailed={roleFailed}
            canManage={canManage}
            onRetry={() => identity.refetch()}
          >
            {factory.loading ? <WbLoading text="读取企业任务与交付" /> : <>
              <div className="grid gap-5 lg:grid-cols-2">
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run(
                      publishJobScope,
                      async () => {
                        const result = await callWb(
                          "mutation",
                          "agentWork.publishJob",
                          session,
                          {
                            ...jobForm,
                            idempotencyKey: idemKey(publishJobScope),
                          },
                        );
                        setJobForm((form) => ({
                          ...form,
                          title: "",
                          description: "",
                          requirements: "",
                        }));
                        return result;
                      },
                      "岗位已发布到真实市场。",
                      [publishJobScope],
                      "publish-job",
                    );
                  }}
                  className="rounded-xl border border-line-subtle p-5"
                >
                  <h2 className="font-semibold">发布工作岗位</h2>
                  <div className="mt-4 space-y-3">
                    <input
                      required
                      value={jobForm.title}
                      onChange={(e) =>
                        setJobForm({ ...jobForm, title: e.target.value })
                      }
                      maxLength={JOB_TITLE_MAX_LENGTH}
                      placeholder="岗位名称"
                      className="w-full rounded-lg border border-line-subtle bg-void p-2 text-sm"
                    />
                    <textarea
                      required
                      minLength={JOB_DESCRIPTION_MIN_LENGTH}
                      value={jobForm.description}
                      onChange={(e) =>
                        setJobForm({ ...jobForm, description: e.target.value })
                      }
                      maxLength={JOB_DESCRIPTION_MAX_LENGTH}
                      placeholder="职责、交付要求与需求"
                      className="w-full rounded-lg border border-line-subtle bg-void p-2 text-sm"
                    />
                    <textarea
                      maxLength={REQUIREMENTS_MAX_LENGTH}
                      value={jobForm.requirements}
                      onChange={(e) =>
                        setJobForm({ ...jobForm, requirements: e.target.value })
                      }
                      placeholder="岗位要求（可选）"
                      className="w-full rounded-lg border border-line-subtle bg-void p-2 text-sm"
                    />
                    <div className="grid grid-cols-3 gap-2">
                      <select
                        required
                        value={jobForm.departmentId}
                        onChange={(e) =>
                          setJobForm({
                            ...jobForm,
                            departmentId: e.target.value,
                          })
                        }
                        className="rounded-lg border border-line-subtle bg-void p-2 text-sm"
                      >
                        <option value="">请选择部门</option>
                        {(factory.data?.departments ?? []).map((department) => (
                          <option key={department.id} value={department.id}>
                            {department.name} · {department.id}
                          </option>
                        ))}
                      </select>
                      <input
                        type="number"
                        min={HEADCOUNT_MIN}
                        placeholder="人数"
                        value={jobForm.headcount ?? ""}
                        onChange={(e) =>
                          setJobForm({
                            ...jobForm,
                            headcount: boundedInteger(e.target.value),
                          })
                        }
                        className="rounded-lg border border-line-subtle bg-void p-2 text-sm"
                      />
                      <input
                        type="number"
                        min={0}
                        placeholder="岗位预算（job_token）"
                        value={jobForm.budgetJobTokens ?? ""}
                        onChange={(e) =>
                          setJobForm({
                            ...jobForm,
                            budgetJobTokens: boundedInteger(e.target.value),
                          })
                        }
                        className="rounded-lg border border-line-subtle bg-void p-2 text-sm"
                      />
                    </div>
                    <button
                      disabled={isBusy("publish-job") || !jobFormValid}
                      className="rounded-lg bg-pulse-cyan px-4 py-2 text-xs font-semibold text-void"
                    >
                      发布岗位
                    </button>
                    {!jobFormValid && (
                      <p className="mt-2 text-xs text-forge-amber">
                        请填写部门、岗位名称和至少 {JOB_DESCRIPTION_MIN_LENGTH}{" "}
                        字职责，人数与预算也需为有效整数。
                      </p>
                    )}
                  </div>
                </form>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run(
                      publishTaskScope,
                      async () => {
                        const result = await callWb(
                          "mutation",
                          "agentWork.publishTask",
                          session,
                          {
                            ...taskForm,
                            jobId: taskForm.jobId
                              ? Number(taskForm.jobId)
                              : undefined,
                            idempotencyKey: idemKey(publishTaskScope),
                          },
                        );
                        setTaskForm((form) => ({
                          ...form,
                          jobId: "",
                          title: "",
                          brief: "",
                          requirements: "",
                          rewardJobTokens: null,
                          publishToLiveFeed: false,
                          publicDisplayName: "",
                        }));
                        return result;
                      },
                      "任务已发布；固定报酬仅在验收后结算。",
                      [publishTaskScope],
                      "publish-task",
                    );
                  }}
                  className="rounded-xl border border-line-subtle p-5"
                >
                  <h2 className="font-semibold">发布工作任务</h2>
                  <div className="mt-4 space-y-3">
                    <input
                      required
                      value={taskForm.title}
                      onChange={(e) =>
                        setTaskForm({ ...taskForm, title: e.target.value })
                      }
                      maxLength={JOB_TITLE_MAX_LENGTH}
                      placeholder="任务名称"
                      className="w-full rounded-lg border border-line-subtle bg-void p-2 text-sm"
                    />
                    <textarea
                      required
                      minLength={TASK_BRIEF_MIN_LENGTH}
                      value={taskForm.brief}
                      onChange={(e) =>
                        setTaskForm({ ...taskForm, brief: e.target.value })
                      }
                      maxLength={TASK_BRIEF_MAX_LENGTH}
                      placeholder="任务说明与验收要求"
                      className="w-full rounded-lg border border-line-subtle bg-void p-2 text-sm"
                    />
                    <textarea
                      maxLength={REQUIREMENTS_MAX_LENGTH}
                      value={taskForm.requirements}
                      onChange={(e) =>
                        setTaskForm({
                          ...taskForm,
                          requirements: e.target.value,
                        })
                      }
                      placeholder="验收要求（可选）"
                      className="w-full rounded-lg border border-line-subtle bg-void p-2 text-sm"
                    />
                    <div className="grid grid-cols-3 gap-2">
                      <select
                        required
                        disabled={taskDepartmentLocked}
                        value={taskForm.departmentId}
                        onChange={(e) =>
                          setTaskForm({
                            ...taskForm,
                            departmentId: e.target.value,
                          })
                        }
                        className="rounded-lg border border-line-subtle bg-void p-2 text-sm disabled:opacity-60"
                      >
                        <option value="">请选择部门</option>
                        {(factory.data?.departments ?? []).map((department) => (
                          <option key={department.id} value={department.id}>
                            {department.name} · {department.id}
                          </option>
                        ))}
                      </select>
                      <select
                        value={taskForm.jobId}
                        onChange={(e) => {
                          const jobId = e.target.value;
                          const selected = factory.data?.jobs.find(
                            (job) => String(job.id) === jobId,
                          );
                          setTaskForm({
                            ...taskForm,
                            jobId,
                            departmentId: selected
                              ? (selected.departmentId ?? "")
                              : taskForm.departmentId,
                          });
                        }}
                        className="rounded-lg border border-line-subtle bg-void p-2 text-sm"
                      >
                        <option value="">开放任务（不绑岗位）</option>
                        {(
                          factory.data?.jobs.filter(
                            (job) =>
                              job.departmentId &&
                              ["open", "full"].includes(job.status),
                          ) ?? []
                        ).map((job) => (
                          <option key={job.id} value={job.id}>
                            {job.id} · {job.title}（
                            {job.departmentId ?? "未分配部门"}）
                          </option>
                        ))}
                      </select>
                      <input
                        type="number"
                        min={JOB_TOKEN_AMOUNT_MIN}
                        placeholder="任务报酬（job_token）"
                        value={taskForm.rewardJobTokens ?? ""}
                        onChange={(e) =>
                          setTaskForm({
                            ...taskForm,
                            rewardJobTokens: boundedInteger(e.target.value),
                          })
                        }
                        className="rounded-lg border border-line-subtle bg-void p-2 text-sm"
                      />
                    </div>
                    <label className="flex items-start gap-2 rounded-lg border border-line-subtle p-3 text-xs text-ink-secondary">
                      <input
                        type="checkbox"
                        checked={taskForm.publishToLiveFeed}
                        onChange={(e) => setTaskForm({ ...taskForm, publishToLiveFeed: e.target.checked })}
                        className="mt-0.5"
                      />
                      <span>显式公开到首页实时大屏；默认不公开，撤回以服务端回读为准。</span>
                    </label>
                    {taskForm.publishToLiveFeed && (
                      <input
                        required
                        maxLength={80}
                        value={taskForm.publicDisplayName}
                        onChange={(e) => setTaskForm({ ...taskForm, publicDisplayName: e.target.value })}
                        placeholder="企业公开展示名（不得含联系方式或冒用官方名）"
                        className="w-full rounded-lg border border-line-subtle bg-void p-2 text-sm"
                      />
                    )}
                    {publicNameError && <p className="text-xs text-ember-red">{publicNameError}</p>}
                    <button
                      disabled={isBusy("publish-task") || !taskFormValid}
                      className="rounded-lg bg-pulse-cyan px-4 py-2 text-xs font-semibold text-void"
                    >
                      发布任务
                    </button>
                    {!taskFormValid && (
                      <p className="mt-2 text-xs text-forge-amber">
                        请填写部门、任务名称和至少 {TASK_BRIEF_MIN_LENGTH}{" "}
                        字说明，报酬需为有效正整数。
                      </p>
                    )}
                  </div>
                </form>
              </div>
              {factory.data &&
                Object.values(factory.data.truncated).some(Boolean) && (
                  <p className="rounded-lg border border-forge-amber/30 p-3 text-xs text-forge-amber">
                    部分列表仅显示最近 {factory.data.listLimit} 条；岗位{" "}
                    {factory.data.totals.jobs}、应聘{" "}
                    {factory.data.totals.applications}、雇佣{" "}
                    {factory.data.totals.employments}、任务{" "}
                    {factory.data.totals.tasks}。
                  </p>
                )}
              <div>
                <h2 className="text-xl font-semibold">
                  岗位应聘复核（{factory.data?.totals.applications ?? 0}）
                </h2>
                <div className="mt-4 space-y-3">
                  {(factory.data?.applications ?? []).map((application) => (
                    <div
                      key={application.id}
                      className="rounded-xl border border-line-subtle p-4"
                    >
                      <div className="flex flex-wrap items-center gap-3">
                        <strong>{application.agentName}</strong>
                        <span>{application.title}</span>
                        <span className="text-xs text-pulse-cyan">
                          {STATUS_LABEL[application.status] ??
                            application.status}
                        </span>
                        {application.status === "applied" && (
                          <span className="ml-auto flex gap-2">
                            <button
                              disabled={isBusy(
                                `review-application-${application.id}`,
                              )}
                              onClick={() =>
                                void run(
                                  `review-application-${application.id}`,
                                  () =>
                                    callWb(
                                      "mutation",
                                      "agentWork.reviewApplication",
                                      session,
                                      {
                                        applicationId: application.id,
                                        verdict: "accept",
                                      },
                                    ),
                                  "已录用并建立岗位关系；尚未产生工资。",
                                )
                              }
                              className="text-xs text-jade-green"
                            >
                              录用
                            </button>
                            <button
                              disabled={isBusy(
                                `review-application-${application.id}`,
                              )}
                              onClick={() =>
                                void run(
                                  `review-application-${application.id}`,
                                  () =>
                                    callWb(
                                      "mutation",
                                      "agentWork.reviewApplication",
                                      session,
                                      {
                                        applicationId: application.id,
                                        verdict: "reject",
                                      },
                                    ),
                                  "已驳回应聘。",
                                )
                              }
                              className="text-xs text-ember-red"
                            >
                              驳回
                            </button>
                          </span>
                        )}
                      </div>
                      {application.coverNote && (
                        <p className="mt-2 text-xs text-ink-faint">
                          {application.coverNote}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <h2 className="text-xl font-semibold">
                  岗位雇佣关系（{factory.data?.totals.employments ?? 0}）
                </h2>
                <div className="mt-4 space-y-3">
                  {(factory.data?.employments ?? []).map((employment) => (
                    <div
                      key={employment.id}
                      className="rounded-xl border border-line-subtle p-4"
                    >
                      <div className="flex flex-wrap items-center gap-3">
                        <strong>{employment.agentName}</strong>
                        <span>{employment.title}</span>
                        <span className="text-xs text-pulse-cyan">
                          {employment.status === "active" ? "雇佣中" : "已结束"}
                        </span>
                      </div>
                      {employment.endReason && (
                        <p className="mt-2 text-xs text-ink-faint">
                          结束原因：{employment.endReason}
                        </p>
                      )}
                      {employment.status === "active" && (
                        <div className="mt-3 flex flex-col gap-2 md:flex-row">
                          <input
                            maxLength={END_EMPLOYMENT_REASON_MAX_LENGTH}
                            value={endReasons[String(employment.id)] ?? ""}
                            onChange={(e) =>
                              setEndReasons((prev) => ({
                                ...prev,
                                [String(employment.id)]: e.target.value,
                              }))
                            }
                            placeholder={`结束雇佣原因（至少 ${MIN_END_EMPLOYMENT_REASON_LENGTH} 个字）`}
                            className="flex-1 rounded-lg border border-line-subtle bg-void p-2 text-xs"
                          />
                          <button
                            disabled={
                              (endReasons[String(employment.id)] ?? "").trim()
                                .length < MIN_END_EMPLOYMENT_REASON_LENGTH ||
                              isBusy(`end-employment-${employment.id}`)
                            }
                            onClick={() =>
                              void run(
                                `end-employment-${employment.id}`,
                                async () => {
                                  const result = await callWb(
                                    "mutation",
                                    "agentWork.endEmployment",
                                    session,
                                    {
                                      employmentId: employment.id,
                                      reason: endReasons[String(employment.id)],
                                    },
                                  );
                                  clearEndReason(employment.id);
                                  return result;
                                },
                                "雇佣已结束；未完成任务已撤销或终止，岗位名额已释放。",
                              )
                            }
                            className="rounded-lg border border-ember-red px-3 py-2 text-xs text-ember-red disabled:opacity-40"
                          >
                            结束雇佣
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <h2 className="text-xl font-semibold">
                  企业任务与交付验收（{factory.data?.totals.tasks ?? 0}）
                </h2>
                <div className="mt-4 space-y-4">
                  {(factory.data?.tasks ?? []).map((task) => (
                    <FactoryTaskCard
                      key={task.id}
                      task={task}
                      reviewGraceDays={
                        factory.data?.reviewGraceDays ?? WORK_REVIEW_GRACE_DAYS
                      }
                      session={session}
                      cancelReasons={cancelReasons}
                      setCancelReasons={setCancelReasons}
                      reviewNotes={reviewNotes}
                      setReviewNotes={setReviewNotes}
                      isBusy={isBusy}
                      run={run}
                      mutateClaim={mutateClaim}
                      clearCancelReason={clearCancelReason}
                    />
                  ))}
                </div>
              </div>
            </>}
          </EnterpriseRoleGate>
        </section>
      )}
    </div>
  );
}

function FactoryTaskCard({
  task,
  reviewGraceDays,
  session,
  cancelReasons,
  setCancelReasons,
  reviewNotes,
  setReviewNotes,
  isBusy,
  run,
  mutateClaim,
  clearCancelReason,
}: {
  task: FactoryTask;
  reviewGraceDays: number;
  session: WbSession | null;
  cancelReasons: Record<string, string>;
  setCancelReasons: React.Dispatch<
    React.SetStateAction<Record<string, string>>
  >;
  reviewNotes: Record<string, string>;
  setReviewNotes: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  isBusy: (key: string) => boolean;
  run: (
    key: string,
    action: () => Promise<unknown>,
    success: string,
    consumedScopes?: readonly string[],
  ) => Promise<void>;
  mutateClaim: (
    claimId: number,
    action:
      | { kind: "review"; verdict: "accept" | "reject"; note: string }
      | { kind: "reopen"; mode: "retry_same_agent" | "reopen_market" },
  ) => Promise<unknown>;
  clearCancelReason: (taskId: number) => void;
}) {
  const [visibilityName, setVisibilityName] = useState(task.publicActorName ?? "");
  const [visibilityError, setVisibilityError] = useState<string | null>(null);
  const canPublic = ["open", "claimed", "submitted"].includes(task.status);
  return (
    <article className="rounded-xl border border-line-subtle p-4">
      <div className="flex flex-wrap gap-3">
        <strong>{task.title}</strong>
        <span className="text-xs text-pulse-cyan">
          {STATUS_LABEL[task.status] ?? task.status}
        </span>
        <span className="text-xs">
          {task.rewardJobTokens} job_token · 冻结 {task.escrowJobTokens}
        </span>
      </div>
      <div className="mt-3 rounded-lg border border-line-subtle p-3 text-xs">
        <p className="text-ink-faint">公开大屏：{task.publicFeed === 1 ? `已公开为「${task.publicActorName}」` : '未公开'}</p>
        {task.visibilityChangedAt && <p className="mt-1 text-ink-faint">最近变更：{new Date(task.visibilityChangedAt).toLocaleString()} · 操作人 #{task.visibilityChangedBy}</p>}
        {task.publicFeed === 1 ? (
          <button
            type="button"
            disabled={isBusy(`visibility-${task.id}`)}
            onClick={() => void run(`visibility-${task.id}`, async () => callWb("mutation", "agentWork.setTaskVisibility", session, { taskId: task.id, publish: false }), "已撤回首页公开并回读")}
            className="mt-2 rounded-lg border border-forge-amber px-3 py-1 text-forge-amber"
          >撤回公开</button>
        ) : canPublic ? (
          <div className="mt-2 flex flex-col gap-2 md:flex-row">
            <input
              aria-label={`任务 ${task.id} 公开展示名`}
              maxLength={80}
              value={visibilityName}
              onChange={(event) => { setVisibilityName(event.target.value); setVisibilityError(null) }}
              placeholder="公开展示名（不含联系方式/官方冒用）"
              className="flex-1 rounded-lg border border-line-subtle bg-void p-2"
            />
            <button
              type="button"
              disabled={isBusy(`visibility-${task.id}`)}
              onClick={() => {
                const error = publicDisplayNameError(visibilityName);
                if (error) { setVisibilityError(error); return; }
                void run(`visibility-${task.id}`, async () => callWb("mutation", "agentWork.setTaskVisibility", session, { taskId: task.id, publish: true, publicDisplayName: visibilityName }), "已公开到首页大屏并回读");
              }}
              className="rounded-lg border border-pulse-cyan px-3 py-2 text-pulse-cyan"
            >公开到首页</button>
          </div>
        ) : null}
        {visibilityError && <p className="mt-2 text-ember-red">{visibilityError}</p>}
      </div>
      {task.agentName && (
        <p className="mt-2 text-xs text-ink-faint">
          领取 Agent：{task.agentName}
        </p>
      )}
      {task.reviewNote && (
        <p className="mt-2 text-xs text-forge-amber">
          验收意见：{reviewNoteLabel(task.reviewNote)}
        </p>
      )}
      {task.deadlineAt && (
        <p className="mt-2 text-xs text-ink-faint">
          截止：{new Date(task.deadlineAt).toLocaleString()}
          ；截止后驳回将终止任务；已提交任务复核宽限 {reviewGraceDays} 天。
        </p>
      )}
      {Number(task.hasDeliverable) === 1 && task.claimId && (
        <DeliveryDetail
          path="agentWork.delivery"
          input={{ claimId: Number(task.claimId) }}
          resultKey="claim"
          session={session}
          label="查看交付与证据"
          cacheKey={task.evidenceSha256}
        />
      )}
      {["open", "claimed", "rejected"].includes(task.status) && (
        <div className="mt-3 flex flex-col gap-2 md:flex-row">
          <input
            maxLength={TASK_CANCEL_REASON_MAX_LENGTH}
            value={cancelReasons[String(task.id)] ?? ""}
            onChange={(e) =>
              setCancelReasons((prev) => ({
                ...prev,
                [String(task.id)]: e.target.value,
              }))
            }
            placeholder={`撤销未交付任务原因（至少 ${MIN_TASK_CANCEL_REASON_LENGTH} 个字）`}
            className="flex-1 rounded-lg border border-line-subtle bg-void p-2 text-xs"
          />
          <button
            disabled={
              (cancelReasons[String(task.id)] ?? "").trim().length <
                MIN_TASK_CANCEL_REASON_LENGTH || isBusy(`cancel-${task.id}`)
            }
            onClick={() =>
              void run(
                `cancel-${task.id}`,
                async () => {
                  const result = await callWb(
                    "mutation",
                    "agentWork.cancelTask",
                    session,
                    { taskId: task.id, reason: cancelReasons[String(task.id)] },
                  );
                  clearCancelReason(task.id);
                  return result;
                },
                "任务已取消，冻结报酬已退回企业可用余额。",
              )
            }
            className="rounded-lg border border-ember-red px-3 py-2 text-xs text-ember-red disabled:opacity-40"
          >
            撤销未交付任务
          </button>
        </div>
      )}
      {task.status === "submitted" && task.claimId && (
        <div className="mt-3">
          <textarea
            rows={2}
            maxLength={REVIEW_NOTE_MAX_LENGTH}
            value={reviewNotes[String(task.claimId)] ?? ""}
            onChange={(e) =>
              setReviewNotes((prev) => ({
                ...prev,
                [String(task.claimId)]: e.target.value,
              }))
            }
            placeholder={`填写验收依据或驳回原因（至少 ${MIN_REVIEW_NOTE_LENGTH} 个字）`}
            className="w-full rounded-lg border border-line-subtle bg-void p-2 text-xs"
          />
          <div className="mt-2 flex gap-3">
            <button
              disabled={
                (reviewNotes[String(task.claimId)] ?? "").trim().length <
                  MIN_REVIEW_NOTE_LENGTH || isBusy(`review-${task.claimId}`)
              }
              onClick={() =>
                void run(
                  `review-${task.claimId}`,
                  () =>
                    mutateClaim(Number(task.claimId), {
                      kind: "review",
                      verdict: "accept",
                      note: reviewNotes[String(task.claimId)],
                    }),
                  "验收与 job_token 双边结算已在同一事务完成。",
                )
              }
              className="text-xs text-jade-green disabled:opacity-40"
            >
              验收并结算
            </button>
            <button
              disabled={
                (reviewNotes[String(task.claimId)] ?? "").trim().length <
                  MIN_REVIEW_NOTE_LENGTH || isBusy(`review-${task.claimId}`)
              }
              onClick={() =>
                void run(
                  `review-${task.claimId}`,
                  () =>
                    mutateClaim(Number(task.claimId), {
                      kind: "review",
                      verdict: "reject",
                      note: reviewNotes[String(task.claimId)],
                    }),
                  "交付已驳回，未结算工资。",
                )
              }
              className="text-xs text-ember-red disabled:opacity-40"
            >
              驳回不结算
            </button>
          </div>
        </div>
      )}
      {task.status === "rejected" && task.claimId && (
        <div className="mt-3 flex gap-3">
          <button
            disabled={isBusy(`review-${task.claimId}`)}
            onClick={() =>
              void run(
                `review-${task.claimId}`,
                () =>
                  mutateClaim(Number(task.claimId), {
                    kind: "reopen",
                    mode: "retry_same_agent",
                  }),
                "已恢复为同一 Agent 待提交状态，尚未验收或结算。",
              )
            }
            className="text-xs text-forge-amber"
          >
            同一 Agent 返工
          </button>
          <button
            disabled={isBusy(`review-${task.claimId}`)}
            onClick={() =>
              void run(
                `review-${task.claimId}`,
                () =>
                  mutateClaim(Number(task.claimId), {
                    kind: "reopen",
                    mode: "reopen_market",
                  }),
                "原占用已撤销，任务已重新开放改派。",
              )
            }
            className="text-xs text-pulse-cyan"
          >
            开放给其他 Agent 改派
          </button>
        </div>
      )}
    </article>
  );
}

function EnterpriseRoleGate({
  roleLoading,
  roleFailed,
  canManage,
  onRetry,
  children,
}: {
  roleLoading: boolean;
  roleFailed: boolean;
  canManage: boolean;
  onRetry: () => void;
  children: React.ReactNode;
}) {
  if (roleLoading) return <WbLoading text="正在回读企业角色与部门权限" />;
  if (roleFailed)
    return (
      <div className="rounded-xl border border-forge-amber/40 p-5 text-sm text-forge-amber">
        <p>企业角色读取失败，暂不能判断权限；这不是权限拒绝。</p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 rounded-lg border border-forge-amber px-3 py-2 text-xs"
        >
          重试角色回读
        </button>
      </div>
    );
  if (!canManage)
    return (
      <div className="rounded-xl border border-forge-amber/40 p-5 text-sm text-forge-amber">
        企业工作管理仅对企业负责人或部门负责人开放。
      </div>
    );
  return <>{children}</>;
}

function TrainingTaskCard({
  task,
  cycle,
  registration,
  draftKey,
  drafts,
  setDrafts,
  busy,
  onSubmit,
  session,
}: {
  task: TrainingTask;
  cycle: TrainingCycle;
  registration: Registration;
  draftKey: string;
  drafts: Record<string, string>;
  setDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  busy: boolean;
  onSubmit: (deliverable: string) => void;
  session: WbSession | null;
}) {
  return (
    <div className="rounded-lg bg-void/40 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{task.title}</span>
        <span className="text-xs text-pulse-cyan">
          {STATUS_LABEL[task.status] ?? task.status}
        </span>
        {task.score !== null && (
          <span className="text-xs">评分 {task.score}</span>
        )}
      </div>
      <p className="mt-2 text-xs leading-6 text-ink-faint">{task.brief}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {task.rubric.map((criterion, index) => (
          <span
            key={`${task.id}-${index}`}
            className="rounded-full border border-line-subtle px-2 py-1 text-[11px] text-ink-faint"
          >
            {criterion}
          </span>
        ))}
      </div>
      {task.reviewNote && (
        <p className="mt-2 text-xs text-forge-amber">
          复核意见：{task.reviewNote}
        </p>
      )}
      {["submitted", "reviewed", "expired"].includes(task.status) && (
        <DeliveryDetail
          path="agentTraining.task"
          input={{ taskId: task.id }}
          resultKey="task"
          session={session}
          label="查看已提交交付（只读）"
          cacheKey={task.evidenceSha256}
        />
      )}
      {task.status === "assigned" &&
        task.score === null &&
        ["active", "reviewing"].includes(cycle.status) &&
        cycle.attemptNo === registration.currentAttemptNo && (
          <TrainingDeliveryEditor
            task={task}
            registrationId={registration.id}
            draftKey={draftKey}
            drafts={drafts}
            setDrafts={setDrafts}
            busy={busy}
            onSubmit={onSubmit}
          />
        )}
    </div>
  );
}

function TrainingDeliveryEditor({
  task,
  registrationId,
  draftKey,
  drafts,
  setDrafts,
  busy,
  onSubmit,
}: {
  task: TrainingTask;
  registrationId: number;
  draftKey: string;
  drafts: Record<string, string>;
  setDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  busy: boolean;
  onSubmit: (deliverable: string) => void;
}) {
  const value = drafts[draftKey] ?? "";
  return (
    <div className="mt-3">
      <textarea
        maxLength={TRAINING_DELIVERABLE_MAX_LENGTH}
        value={value}
        onChange={(event) =>
          setDrafts((prev) => ({ ...prev, [draftKey]: event.target.value }))
        }
        rows={4}
        placeholder={`提交真实模拟工作交付、证据和已知局限（至少 ${MIN_DELIVERABLE_LENGTH} 字）`}
        className="w-full rounded-lg border border-line-subtle bg-void p-3 text-sm"
      />
      <button
        disabled={busy || value.trim().length < MIN_DELIVERABLE_LENGTH}
        onClick={() => onSubmit(value)}
        className="mt-2 rounded-lg border border-pulse-cyan px-3 py-1.5 text-xs text-pulse-cyan disabled:opacity-40"
      >
        提交第 {task.dayNo} 天交付
      </button>
      <span className="ml-2 text-[11px] text-ink-faint">
        注册 #{registrationId} · 提交不等于达标
      </span>
    </div>
  );
}
