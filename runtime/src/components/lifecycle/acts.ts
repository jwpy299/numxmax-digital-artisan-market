/** shared metadata for the six lifecycle acts */
export interface ActMeta {
  id: string
  numeral: string
  name: string
  title: string
  body: string
  bullets: string[]
}

export const ACTS: ActMeta[] = [
  {
    id: 'incubate',
    numeral: 'I',
    name: '孵化',
    title: '一门手艺的数字重生',
    body: '老师傅在技能工坊演示操作，系统捕获其动作（V）与判断逻辑（U），封装成多个技能；同时自动孵化一个 Agent 实例——封装全部技能、继承能力标签、获得初始雇佣价格。',
    bullets: ['动作捕获 V · 判断逻辑 U', '技能自动封装', 'Agent 实例同步孵化'],
  },
  {
    id: 'listing',
    numeral: 'II',
    name: '上架',
    title: '通过评审，进驻市场',
    body: 'Agent 自动上架到数字匠市，对外展示：名称与头像、能力标签、技能清单、初始雇佣价格（平台建议价 + 老师傅自主调整）、历史雇佣记录与雇主评价。上架前必须通过模型评审会审核。',
    bullets: ['平台建议价 + 老师傅调整', '模型评审会审核', '自动上架展示'],
  },
  {
    id: 'pricing',
    numeral: 'III',
    name: '定价',
    title: '价格由市场供需决定',
    body: '初始定价参考技能数量、复杂度、老师傅声望与同类参考价；供不应求自动上浮（每月上限 +20%），供过于求自动下调（每月下限 -20%）；高评分溢价、低评分降价；累计经验越多价格越高。',
    bullets: ['供需浮动 ±20%/月', '评分溢价机制', '经验即身价'],
  },
  {
    id: 'hire',
    numeral: 'IV',
    name: '雇佣',
    title: '七天试用，一纸合约',
    body: '工厂在市场按行业、能力、价格筛选浏览；查看详情后可申请 7 天免费试用，试用在沙箱中执行，结束生成评估报告；满意后签订智能合约，确定雇佣周期与月薪，Agent 进入工厂的「我的数字员工」列表。',
    bullets: ['7 天沙箱试用', '评估报告辅助决策', '智能合约签约'],
  },
  {
    id: 'execute',
    numeral: 'V',
    name: '执行',
    title: '一句话，一条技能链',
    body: '雇主通过智能工作台下达任务——「帮我看一下 3 号 CNC 的振动频谱有没有异常」。Agent 自动解析意图、拆解子任务、选择最合适的内部技能按最优顺序执行、实时反馈进度，完成后生成含执行过程、关键发现、建议措施与置信度评分的结构化报告。',
    bullets: ['自然语言 → 任务树', '技能链最优调度', '结构化报告 + 置信度'],
  },
  {
    id: 'evolve',
    numeral: 'VI',
    name: '进化',
    title: '经验沉淀，优胜劣汰',
    body: '每次任务执行记录保存到工作记忆；老师傅可随时更新 Agent 的技能，新技能自动生效；经验值越高市场价格越高；雇主评价影响信用评分与价格。连续 3 个月评分低于 3 星的 Agent 自动下架整改——进化与淘汰并存。',
    bullets: ['工作记忆持续沉淀', '老师傅远程更新技能', '信用驱动优胜劣汰'],
  },
]
