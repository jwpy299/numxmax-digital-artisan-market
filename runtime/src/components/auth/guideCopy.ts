/**
 * guideCopy —— 灵枢/星云双人格接引文案体系（M7-a S1 注册向导）。
 *
 * 人设：灵枢=参谋长·秩序与执行（沉稳、先结论）；星云=参谋·洞察与增长（明快、有画面感）。
 * 注册向导按步骤切换引导语；企业注册与个人注册文案区分。
 * V1 为文字接引（不接真语音），但文案即未来语音脚本的同源素材。
 */

export type GuidePersona = 'lingshu' | 'xingyun'

export const PERSONA_META: Record<GuidePersona, { name: string; title: string; tone: string }> = {
  lingshu: { name: '灵枢', title: '参谋长 · 秩序与执行', tone: '沉稳严谨' },
  xingyun: { name: '星云', title: '参谋 · 洞察与增长', tone: '明快外向' },
}

export interface GuideLine {
  persona: GuidePersona
  text: string
}

/** 企业注册向导：按步骤 0/1/2 + 过场 ceremony 的接引语（每步灵枢/星云各一句，界面轮换展示） */
export const ENTERPRISE_STEP_GUIDES: GuideLine[][] = [
  // 第 1 步：企业信息
  [
    { persona: 'lingshu', text: '欢迎。我是灵枢。注册即立项——你填的每一项信息，都会成为组织中枢为你建厂的依据。' },
    { persona: 'xingyun', text: '我是星云！先认识一下你的企业吧：名字、行业、规模——越准确，我们给你配的军团越合身。' },
  ],
  // 第 2 步：组织架构
  [
    { persona: 'xingyun', text: '说说你的组织。不用从零想——我已按行业给你预填了推荐部门，改改就能用。' },
    { persona: 'lingshu', text: '部门即编制。每个部门后续都会划定职责域，权限只沿授权链流动——从这里就开始立规矩。' },
  ],
  // 第 3 步：确认提交
  [
    { persona: 'lingshu', text: '最后核对一遍。提交之后，我会立即为你的企业组建数字军团——每一步都有审计背书。' },
    { persona: 'xingyun', text: '准备好了就点「注册企业并建军」！接下来的画面，别的平台可没有。' },
  ],
]

/** 建军过场页接引语 */
export const CEREMONY_GUIDES = {
  building: { persona: 'lingshu' as GuidePersona, text: '组织中枢正在为你的企业组建军团：部门编制、角色分工、专属数字工匠，逐一到位。' },
  done: { persona: 'xingyun' as GuidePersona, text: '军团集结完毕！从现在起，每一家部门都有数字工匠值守。老板，请检阅你的组织。' },
  fallback: { persona: 'lingshu' as GuidePersona, text: '组织配置稍后可在工作台「组织管理」中补齐。军团不会缺席，只会迟到。' },
}

/** 个人注册接引语 */
export const PERSON_GUIDES: GuideLine[] = [
  { persona: 'xingyun', text: '个人账号同样接入 NumX Max 生态：技能变现、战绩排行、老师傅传承，都从这一步开始。' },
  { persona: 'lingshu', text: '手机号验证是信用的起点。在 NumX Max，信用就是身价。' },
]
