/**
 * corps —— iter91 熊猫军团流水线（企业侧 wb）：
 * 行业编制模板 → 组建（forming/training）→ 沙箱训练（ops/corps-train.py 写 st_corps_training）
 * → 毕业（≥2 轮且通过率 ≥95%）→ 驻场（deployed，成员 enabled=1）→ 见习期 14 天高危强制 l2_tenant。
 *
 * 安全边界：
 * - 所有查询/写入强制 factory_id=本厂（sessionMe 工厂上下文），跨租户隔离；
 * - corps.form 幂等：一厂一团（st_corps.factory_id 唯一键），已有军团直接返回；
 * - 成员未毕业 enabled=0 不上岗；训练成绩只写 st_corps_training，不碰生产任务表。
 */
import type { DeptTeamSpec } from "./packages"; // 部门包编制面型引（type-only 不拉运行值——战区② 2.4 钩子面同构钉）
import { z } from "zod";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { stQuery } from "./terminal";
import { sessionMe } from "./wbSession";

// ─── 行业编制模板（12 行业，industryGroup 中文枚举；角色仅 co/ex/va/ev）────────
export interface CorpsMemberSpec {
  role: "co" | "ex" | "va" | "ev";
  deptKey: string;
  duty: string;
  skillHints: string[];
}

const DEFAULT_TEMPLATE: CorpsMemberSpec[] = [
  { role: "co", deptKey: "coord", duty: "军团协调：任务分派与进度统筹", skillHints: ["任务拆解", "进度跟踪", "跨部门协同"] },
  { role: "ex", deptKey: "ops", duty: "业务执行：日常运营任务落地", skillHints: ["流程执行", "文档撰写"] },
  { role: "ex", deptKey: "support", duty: "业务执行：专项支撑与数据处理", skillHints: ["数据整理", "报表输出"] },
  { role: "va", deptKey: "quality", duty: "质量校验：产出复核与合规检查", skillHints: ["质量校验", "合规检查"] },
  { role: "ev", deptKey: "eval", duty: "效果评估：成果度量与改进建议", skillHints: ["效果评估", "复盘改进"] },
];

export const CORPS_TEMPLATES: Record<string, CorpsMemberSpec[]> = {
  工业制造: [
    { role: "co", deptKey: "production", duty: "生产协调：排产统筹与跨车间协同", skillHints: ["生产排程", "工单管理", "产线协调"] },
    { role: "va", deptKey: "quality", duty: "质检：来料/过程/出厂检验与不良归因", skillHints: ["质量检验", "不良分析", "抽检报告"] },
    { role: "ex", deptKey: "supply", duty: "供应链执行：采购跟单与库存盘点", skillHints: ["采购跟单", "库存管理", "供应商协同"] },
    { role: "ex", deptKey: "report", duty: "报表执行：生产日报/周报与数据台账", skillHints: ["生产报表", "数据台账"] },
    { role: "ev", deptKey: "eval", duty: "评估：产能/良品率度量与改进建议", skillHints: ["产能分析", "良率评估"] },
  ],
  跨境电商: [
    { role: "co", deptKey: "operation", duty: "运营协调：店铺运营节奏与活动统筹", skillHints: ["店铺运营", "活动策划", "平台规则"] },
    { role: "ex", deptKey: "selection", duty: "选品执行：市场调研与竞品分析", skillHints: ["选品调研", "竞品分析", "关键词"] },
    { role: "ex", deptKey: "service", duty: "客服执行：售前售后应答与工单处理", skillHints: ["客服话术", "工单处理", "差评安抚"] },
    { role: "ex", deptKey: "logistics", duty: "物流执行：头程尾程跟踪与异常处理", skillHints: ["物流跟踪", "清关异常", "海外仓"] },
    { role: "ev", deptKey: "eval", duty: "评估：转化率/动销/ROI 度量复盘", skillHints: ["转化分析", "ROI 复盘"] },
  ],
  设计创意: [
    { role: "co", deptKey: "creative", duty: "创意协调：需求拆解与排期统筹", skillHints: ["需求拆解", "创意简报", "排期管理"] },
    { role: "ex", deptKey: "design", duty: "设计执行：视觉稿产出与改稿迭代", skillHints: ["视觉设计", "版式规范", "品牌调性"] },
    { role: "ex", deptKey: "copy", duty: "文案执行：slogan/详情页/社媒文案", skillHints: ["文案撰写", "品牌叙事"] },
    { role: "va", deptKey: "review", duty: "稿件校验：规范/版权/错漏复核", skillHints: ["设计规范", "版权核查"] },
    { role: "ev", deptKey: "eval", duty: "评估：提案命中率与客户反馈复盘", skillHints: ["提案复盘", "客户反馈"] },
  ],
  财税服务: [
    { role: "co", deptKey: "coord", duty: "协调：记账报税排期与客户对接统筹", skillHints: ["账期管理", "客户对接"] },
    { role: "ex", deptKey: "bookkeeping", duty: "记账执行：凭证整理与账务处理", skillHints: ["凭证处理", "账务核对", "科目运用"] },
    { role: "ex", deptKey: "tax", duty: "报税执行：纳税申报与政策适配", skillHints: ["纳税申报", "税收政策", "发票管理"] },
    { role: "va", deptKey: "audit", duty: "审单校验：账税一致性与合规复核", skillHints: ["账税核对", "合规审查", "风险预警"] },
  ],
  医疗健康: [
    { role: "co", deptKey: "coord", duty: "协调：科室协作与患者服务统筹", skillHints: ["科室协调", "患者服务"] },
    { role: "ex", deptKey: "service", duty: "执行：预约分诊与随访管理", skillHints: ["预约分诊", "随访管理", "健康宣教"] },
    { role: "ex", deptKey: "doc", duty: "执行：病历文书与档案整理", skillHints: ["病历规范", "档案管理"] },
    { role: "va", deptKey: "compliance", duty: "校验：诊疗规范与隐私合规复核", skillHints: ["诊疗规范", "隐私合规", "处方审核"] },
    { role: "ev", deptKey: "eval", duty: "评估：服务质量与满意度度量", skillHints: ["满意度分析", "质控指标"] },
  ],
  教育培训: [
    { role: "co", deptKey: "coord", duty: "协调：课程排期与师资统筹", skillHints: ["课程排期", "师资协调"] },
    { role: "ex", deptKey: "course", duty: "执行：课程内容制作与题库维护", skillHints: ["课程设计", "题库建设", "讲义撰写"] },
    { role: "ex", deptKey: "service", duty: "执行：学员服务与作业批改", skillHints: ["学员答疑", "作业批改", "学情跟踪"] },
    { role: "va", deptKey: "quality", duty: "校验：教学内容质量与合规复核", skillHints: ["内容审校", "广告合规"] },
    { role: "ev", deptKey: "eval", duty: "评估：完课率/续费率与教学效果复盘", skillHints: ["完课分析", "效果评估"] },
  ],
  法律合规: [
    { role: "co", deptKey: "coord", duty: "协调：案件分派与节点统筹", skillHints: ["案件管理", "节点跟踪"] },
    { role: "ex", deptKey: "contract", duty: "执行：合同起草与条款审查", skillHints: ["合同起草", "条款审查", "风险提示"] },
    { role: "ex", deptKey: "research", duty: "执行：法条检索与案例研判", skillHints: ["法条检索", "案例研判"] },
    { role: "va", deptKey: "compliance", duty: "校验：文书合规与执业风险复核", skillHints: ["文书合规", "执业规范"] },
    { role: "ev", deptKey: "eval", duty: "评估：案件成效与时效复盘", skillHints: ["案件复盘", "时效评估"] },
  ],
  建筑工程: [
    { role: "co", deptKey: "project", duty: "项目协调：施工计划与多方统筹", skillHints: ["施工计划", "进度管理", "分包协调"] },
    { role: "ex", deptKey: "cost", duty: "执行：造价核算与变更签证", skillHints: ["造价核算", "变更签证", "清单计价"] },
    { role: "ex", deptKey: "doc", duty: "执行：施工资料与竣工档案管理", skillHints: ["施工资料", "竣工档案"] },
    { role: "va", deptKey: "safety", duty: "校验：安全隐患排查与规范复核", skillHints: ["安全检查", "规范复核", "隐患排查"] },
    { role: "ev", deptKey: "eval", duty: "评估：工期/成本/质量综合评估", skillHints: ["工期评估", "成本分析"] },
  ],
  农业科技: [
    { role: "co", deptKey: "coord", duty: "协调：农事计划与基地统筹", skillHints: ["农事计划", "基地管理"] },
    { role: "ex", deptKey: "planting", duty: "执行：种植方案与田间记录", skillHints: ["种植方案", "田间记录", "病虫害防治"] },
    { role: "ex", deptKey: "supply", duty: "执行：农资采购与产销对接", skillHints: ["农资采购", "产销对接", "冷链物流"] },
    { role: "va", deptKey: "quality", duty: "校验：农产品质检与溯源复核", skillHints: ["质量检测", "溯源管理"] },
    { role: "ev", deptKey: "eval", duty: "评估：亩产/品质与收益复盘", skillHints: ["亩产分析", "收益评估"] },
  ],
  文化传媒: [
    { role: "co", deptKey: "coord", duty: "协调：内容排期与渠道统筹", skillHints: ["内容排期", "渠道运营"] },
    { role: "ex", deptKey: "content", duty: "执行：图文/短视频内容产出", skillHints: ["内容创作", "脚本撰写", "热点追踪"] },
    { role: "ex", deptKey: "operation", duty: "执行：账号运营与投放执行", skillHints: ["账号运营", "投放优化", "社群维护"] },
    { role: "va", deptKey: "review", duty: "校验：内容导向与版权合规复核", skillHints: ["内容审核", "版权核查", "舆情预警"] },
    { role: "ev", deptKey: "eval", duty: "评估：传播数据与转化效果复盘", skillHints: ["数据分析", "传播评估"] },
  ],
  现代物流: [
    { role: "co", deptKey: "dispatch", duty: "调度协调：运力统筹与线路规划", skillHints: ["运力调度", "线路规划"] },
    { role: "ex", deptKey: "tracking", duty: "执行：运单跟踪与异常处理", skillHints: ["运单跟踪", "异常处理", "签收管理"] },
    { role: "ex", deptKey: "warehouse", duty: "执行：仓储作业与库存盘点", skillHints: ["仓储作业", "库存盘点", "库位管理"] },
    { role: "va", deptKey: "quality", duty: "校验：破损率/时效达标复核", skillHints: ["时效复核", "破损分析"] },
    { role: "ev", deptKey: "eval", duty: "评估：时效/成本/投诉综合复盘", skillHints: ["时效分析", "成本复盘"] },
  ],
  餐饮零售: [
    { role: "co", deptKey: "coord", duty: "协调：门店运营与排班统筹", skillHints: ["门店运营", "排班管理"] },
    { role: "ex", deptKey: "supply", duty: "执行：采购备货与损耗管控", skillHints: ["采购备货", "损耗管控", "库存周转"] },
    { role: "ex", deptKey: "marketing", duty: "执行：会员营销与活动执行", skillHints: ["会员运营", "促销活动", "点评维护"] },
    { role: "va", deptKey: "safety", duty: "校验：食安/卫生与标价合规复核", skillHints: ["食品安全", "卫生检查", "明码标价"] },
    { role: "ev", deptKey: "eval", duty: "评估：翻台/坪效与复购复盘", skillHints: ["坪效分析", "复购评估"] },
  ],
};

/** 按行业取模板（未覆盖行业回落默认模板） */
export function corpsTemplate(industry: string | null | undefined): CorpsMemberSpec[] {
  return (industry && CORPS_TEMPLATES[industry]) || DEFAULT_TEMPLATE;
}

// ─── 共享组建逻辑（corps.form 与 authRegisterEnterprise 自动组建共用）──────────
/**
 * 幂等组建军团：已有 st_corps（一厂一团唯一键）直接返回；
 * 否则按行业模板 INSERT st_corps(status='training') + st_panda_members（enabled=0 未毕业不上岗）。
 */
export async function formCorpsForFactory(opts: {
  factoryId: number;
  name?: string;
  industry?: string | null;
  actor?: string;
  teamSpec?: DeptTeamSpec; // 部门包编制面（战区② 2.4——有=按部门编制组建[1 主管+N 专员]，无=按行业模板[向后兼容不破]）
}): Promise<{ corpsId: number; memberCount: number; created: boolean }> {
  const existing = await stQuery(
    sql`SELECT id, member_count AS memberCount FROM st_corps WHERE factory_id = ${opts.factoryId} LIMIT 1`,
  );
  if (existing[0]) {
    const corpsId = Number(existing[0].id);
    const baseCount = Number(existing[0].memberCount);
    // 部门包落编进既有军团（wb#79 复审 bug·med 票：一厂一团幂等早返=第二个部门包不组建=「购买后自动组建军团」
    // 宣称≠实现面封死——已有军团+teamSpec=把部门编制落编进既有军团[ref_key 部门前缀防撞]+member_count 增量）；
    // 已有军团+无 teamSpec=早返（原幂等面不破）
    if (opts.teamSpec && Array.isArray(opts.teamSpec.members)) {
      const members = [opts.teamSpec.lead, ...opts.teamSpec.members];
      const roleSeq: Record<string, number> = {};
      for (const m of members) {
        roleSeq[m.role] = (roleSeq[m.role] ?? 0) + 1;
        const refKey = `corps${corpsId}-dept-${m.deptKey}-${m.role}${roleSeq[m.role]}`; // 部门前缀（与行业模板 ref_key 不撞面）
        const hints = m.skillHints.join("/");
        await stQuery(
          sql`INSERT INTO st_panda_members (factory_id, corps_id, role, ref_type, ref_key, dept_key, duty, enabled)
              VALUES (${opts.factoryId}, ${corpsId}, ${m.role}, 'agent', ${refKey}, ${m.deptKey},
                      ${`${m.duty}｜技能:${hints}`}, 0)
              ON DUPLICATE KEY UPDATE corps_id = VALUES(corps_id), dept_key = VALUES(dept_key), duty = VALUES(duty)`,
        );
      }
      // member_count 实数重算（wb#79 复审 bug·med 票：INSERT 被 uk_seat_v2 唯一键去重[重跑/重复认领=无新行]——
      // 无条件增量=计数虚增漂移面封死；组建后 SELECT COUNT(*) 重算写回=计数=实数面）
      const cnt = await stQuery(
        sql`SELECT COUNT(*) AS c FROM st_panda_members WHERE factory_id = ${opts.factoryId} AND corps_id = ${corpsId}`,
      );
      const realCount = Number((cnt[0] as { c?: unknown } | undefined)?.c ?? baseCount);
      await stQuery(
        sql`UPDATE st_corps SET member_count = ${realCount} WHERE id = ${corpsId}`,
      );
      // 门户仓无 Harness 落户面（同上钉——公网门户只落库不落户，落户由 wb 侧承担）
      return { corpsId, memberCount: realCount, created: true }; // created=true=编制落了（宣称=实现）+memberCount=实数（不虚增——复审钉）
    }
    return { corpsId, memberCount: baseCount, created: false };
  }
  const industry = opts.industry ?? "工业制造";
  // 编制面（战区② 2.4：teamSpec 优先——部门包按编制组建；缺省按行业模板[向后兼容]）
  // 编制形态守卫（wb#79 复审 bug·med 票：teamSpec.members 缺/非数组=展开炸 TypeError——坏 team_spec 不炸面封死；
  //  形态不对=回退行业模板[败而不炸=温和面]）
  const specOk = opts.teamSpec && Array.isArray(opts.teamSpec.members);
  const template: CorpsMemberSpec[] = specOk
    ? [opts.teamSpec!.lead, ...opts.teamSpec!.members]
    : corpsTemplate(industry);
  const name = opts.name?.trim() || "熊猫军团";
  await stQuery(
    sql`INSERT INTO st_corps (factory_id, name, industry, status, member_count)
        VALUES (${opts.factoryId}, ${name}, ${industry}, 'training', ${template.length})`,
  );
  const corpsRows = await stQuery(
    sql`SELECT id FROM st_corps WHERE factory_id = ${opts.factoryId} LIMIT 1`,
  );
  const corpsId = Number(corpsRows[0].id);
  // 成员落编：ref_type='agent'，ref_key=corps<corpsId>-<role><序号>，enabled=0
  const roleSeq: Record<string, number> = {};
  for (const m of template) {
    roleSeq[m.role] = (roleSeq[m.role] ?? 0) + 1;
    const refKey = `corps${corpsId}-${m.role}${roleSeq[m.role]}`;
    const hints = m.skillHints.join("/");
    await stQuery(
      sql`INSERT INTO st_panda_members (factory_id, corps_id, role, ref_type, ref_key, dept_key, duty, enabled)
          VALUES (${opts.factoryId}, ${corpsId}, ${m.role}, 'agent', ${refKey}, ${m.deptKey},
                  ${`${m.duty}｜技能:${hints}`}, 0)
          ON DUPLICATE KEY UPDATE corps_id = VALUES(corps_id), dept_key = VALUES(dept_key), duty = VALUES(duty)`,
    );
  }
  // 门户仓无 Harness 落户面（公网门户不落户——落户是 wb 侧工位池面；组建只落库 st_corps/st_panda_members，
  //  工位落户由 wb 侧 provisionCorpsMembers 面承担——门户仓不挂幻影钩子引，复审钉）
  return { corpsId, memberCount: template.length, created: true };
}

/** 训练汇总（corps.current / corps.trainingStatus 共用） */
async function trainingSummary(corpsId: number) {
  const agg = await stQuery(
    sql`SELECT COUNT(DISTINCT \`round\`) AS rounds,
               IFNULL(ROUND(AVG(pass) * 100, 2), 0) AS passRate,
               MAX(created_at) AS lastRoundAt
        FROM st_corps_training WHERE corps_id = ${corpsId}`,
  );
  return {
    rounds: Number(agg[0]?.rounds ?? 0),
    passRate: Number(agg[0]?.passRate ?? 0),
    lastRoundAt: agg[0]?.lastRoundAt ? String(agg[0].lastRoundAt) : null,
  };
}

export const corpsRouter = createRouter({
  /** corps.current（query, wb）：本厂军团 + 成员 + 训练汇总；无军团返回 null */
  current: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const { factory } = await sessionMe(input.token);
      const rows = await stQuery(
        sql`SELECT id, factory_id AS factoryId, name, industry, status,
                   member_count AS memberCount, train_pass_rate AS trainPassRate,
                   created_at AS createdAt, graduated_at AS graduatedAt, deployed_at AS deployedAt
            FROM st_corps WHERE factory_id = ${factory.id} LIMIT 1`,
      );
      const c = rows[0];
      if (!c) return { corps: null };
      const corpsId = Number(c.id);
      const members = await stQuery(
        sql`SELECT id, role, ref_type AS refType, ref_key AS refKey, dept_key AS deptKey,
                   duty, enabled, created_at AS createdAt
            FROM st_panda_members
            WHERE factory_id = ${factory.id} AND corps_id = ${corpsId}
            ORDER BY FIELD(role, 'co','ex','va','ev'), id ASC LIMIT 50`,
      );
      const summary = await trainingSummary(corpsId);
      return {
        corps: {
          id: corpsId,
          factoryId: Number(c.factoryId),
          name: String(c.name),
          industry: String(c.industry),
          status: String(c.status),
          memberCount: Number(c.memberCount),
          trainPassRate: c.trainPassRate === null || c.trainPassRate === undefined ? null : Number(c.trainPassRate),
          createdAt: c.createdAt ? String(c.createdAt) : null,
          graduatedAt: c.graduatedAt ? String(c.graduatedAt) : null,
          deployedAt: c.deployedAt ? String(c.deployedAt) : null,
        },
        members: members.map((m) => ({
          id: Number(m.id),
          role: String(m.role),
          refType: String(m.refType),
          refKey: String(m.refKey),
          deptKey: m.deptKey ? String(m.deptKey) : null,
          duty: m.duty ? String(m.duty) : null,
          enabled: Number(m.enabled) === 1,
          createdAt: m.createdAt ? String(m.createdAt) : null,
        })),
        trainingSummary: summary,
      };
    }),

  /** corps.form（mutation, wb owner）：幂等组建——已有军团直接返回 */
  form: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      name: z.string().trim().min(2).max(128).optional(),
    }))
    .mutation(async ({ input }) => {
      const { user, factory } = await sessionMe(input.token);
      if (user.role !== "owner" && user.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "仅企业负责人可组建军团" });
      }
      const r = await formCorpsForFactory({
        factoryId: factory.id,
        name: input.name,
        industry: factory.industryGroup ?? factory.industry ?? null,
        actor: `wb:${user.username}`,
      });
      return {
        corpsId: r.corpsId,
        memberCount: r.memberCount,
        alreadyExists: !r.created,
        message: r.created
          ? `军团已按「${factory.industryGroup ?? "默认"}」行业模板组建（${r.memberCount} 只熊猫），进入训练阶段`
          : "本厂已有军团，直接返回现有编制",
      };
    }),

  /** corps.trainingStatus（query, wb）：训练轮次/通过率/科目明细 */
  trainingStatus: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const { factory } = await sessionMe(input.token);
      const corps = await stQuery(
        sql`SELECT id, status, train_pass_rate AS trainPassRate FROM st_corps
            WHERE factory_id = ${factory.id} LIMIT 1`,
      );
      if (!corps[0]) throw new TRPCError({ code: "NOT_FOUND", message: "本厂尚未组建军团" });
      const corpsId = Number(corps[0].id);
      const summary = await trainingSummary(corpsId);
      const subjects = await stQuery(
        sql`SELECT \`round\`, subject, pass, score, LEFT(reply, 300) AS reply, created_at AS createdAt
            FROM st_corps_training WHERE corps_id = ${corpsId}
            ORDER BY id DESC LIMIT 100`,
      );
      return {
        corpsId,
        status: String(corps[0].status),
        rounds: summary.rounds,
        passRate: summary.passRate,
        lastRoundAt: summary.lastRoundAt,
        subjects: subjects.map((s) => ({
          round: String(s.round),
          subject: String(s.subject),
          pass: Number(s.pass) === 1,
          score: s.score === null || s.score === undefined ? null : Number(s.score),
          reply: s.reply ? String(s.reply) : null,
          createdAt: s.createdAt ? String(s.createdAt) : null,
        })),
      };
    }),
});
