import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Database, Lock } from 'lucide-react'
import SectionHeader from '@/components/SectionHeader'
import { cn } from '@/lib/utils'

/* ------------------------------ sql data ------------------------------ */

interface SqlLine {
  raw: string
  field?: string
}

interface SqlTable {
  id: string
  tab: string
  file: string
  comment: string
  lines: SqlLine[]
  notes: Record<string, string>
  planned?: boolean
}

const AGENTS_TABLE: SqlTable = {
  id: 'agents',
  tab: 'agents',
  file: 'schema.sql · agents',
  comment: 'Agent表',
  lines: [
    { raw: 'CREATE TABLE agents (' },
    { raw: '    agent_id VARCHAR(64) PRIMARY KEY,', field: 'agent_id' },
    { raw: '    agent_name VARCHAR(128) NOT NULL,', field: 'agent_name' },
    { raw: '    creator_id VARCHAR(64) NOT NULL,', field: 'creator_id' },
    { raw: '    industry_tags JSON,', field: 'industry_tags' },
    { raw: '    capability_tags JSON,', field: 'capability_tags' },
    { raw: '    skill_ids JSON,', field: 'skill_ids' },
    { raw: '    hire_price DECIMAL(10,2),', field: 'hire_price' },
    { raw: "    price_unit VARCHAR(20) DEFAULT 'monthly',", field: 'price_unit' },
    { raw: "    status VARCHAR(20) DEFAULT 'pending',", field: 'status' },
    { raw: '    total_tasks INT DEFAULT 0,', field: 'total_tasks' },
    { raw: '    success_rate DECIMAL(5,2) DEFAULT 0,', field: 'success_rate' },
    { raw: '    avg_rating DECIMAL(3,2) DEFAULT 0,', field: 'avg_rating' },
    { raw: '    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP', field: 'created_at' },
    { raw: ');' },
  ],
  notes: {
    agent_id: '数字工匠全局唯一身份标识，主键。',
    agent_name: '工匠名号，如「振衡」「炽眸」。',
    creator_id: '创建者（老师傅）ID，关联经验来源。',
    industry_tags: '适用行业标签，JSON 数组，如装备制造、压力容器。',
    capability_tags: '能力标签，JSON 数组，用于市场搜索与筛选。',
    skill_ids: '该工匠封装的技能清单，JSON 数组。',
    hire_price: '雇佣价格，默认按月计费。',
    price_unit: "计价单位，默认 'monthly'（按月雇佣）。",
    status: "生命周期状态：pending（待审）/ active（在架）等。",
    total_tasks: '累计完成任务数，定价与排名的重要权重。',
    success_rate: '任务成功率（%），直接影响信用档案。',
    avg_rating: '雇主平均评分（0–5），连续低于红线将触发下架。',
    created_at: '创建时间，默认当前时间戳。',
  },
}

const HIRE_TABLE: SqlTable = {
  id: 'agent_hire_records',
  tab: 'agent_hire_records',
  file: 'schema.sql · agent_hire_records',
  comment: 'Agent雇佣记录表',
  lines: [
    { raw: 'CREATE TABLE agent_hire_records (' },
    { raw: '    record_id VARCHAR(64) PRIMARY KEY,', field: 'record_id' },
    { raw: '    agent_id VARCHAR(64) NOT NULL,', field: 'agent_id' },
    { raw: '    enterprise_id VARCHAR(64) NOT NULL,', field: 'enterprise_id' },
    { raw: '    hire_start DATE NOT NULL,', field: 'hire_start' },
    { raw: '    hire_end DATE,', field: 'hire_end' },
    { raw: '    monthly_price DECIMAL(10,2),', field: 'monthly_price' },
    { raw: "    status VARCHAR(20) DEFAULT 'active',", field: 'status' },
    { raw: '    total_tasks_completed INT DEFAULT 0,', field: 'total_tasks_completed' },
    { raw: '    rating DECIMAL(3,2),', field: 'rating' },
    { raw: '    review TEXT,', field: 'review' },
    { raw: '    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP', field: 'created_at' },
    { raw: ');' },
  ],
  notes: {
    record_id: '雇佣合约记录唯一标识，主键。',
    agent_id: '被雇佣的数字工匠 ID。',
    enterprise_id: '雇佣方（工厂 / 企业）ID。',
    hire_start: '雇佣生效日期。',
    hire_end: '雇佣到期日期，空值表示长期有效。',
    monthly_price: '签约时锁定的月薪（Token）。',
    status: "合约状态：active（生效中）/ expired / cancelled。",
    total_tasks_completed: '本合约期内累计完成的任务数。',
    rating: '雇主对本合约的评分，沉淀进工匠信用档案。',
    review: '雇主文字评价，评价后可获 Token 奖励。',
    created_at: '合约创建时间，默认当前时间戳。',
  },
}

const PLANNED_TABLE: SqlTable = {
  id: 'skill_memory',
  tab: 'skill_memory',
  file: 'schema.sql · skill_memory',
  comment: '技能工作记忆表（规划中）',
  planned: true,
  lines: [
    { raw: '-- 规划中：承载 Agent 工作记忆的' },
    { raw: '-- 向量化存储与检索结构' },
    { raw: 'CREATE TABLE skill_memory (' },
    { raw: '    memory_id VARCHAR(64) PRIMARY KEY,' },
    { raw: '    agent_id VARCHAR(64) NOT NULL,' },
    { raw: '    category VARCHAR(32),' },
    { raw: '    embedding VECTOR(768),' },
    { raw: '    summary TEXT,' },
    { raw: '    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP' },
    { raw: ');' },
  ],
  notes: {},
}

const TABLES = [AGENTS_TABLE, HIRE_TABLE, PLANNED_TABLE]

/* --------------------------- syntax highlight --------------------------- */

const KEYWORDS = /\b(CREATE|TABLE|PRIMARY|KEY|NOT|NULL|DEFAULT)\b/g
const TYPES = /\b(VARCHAR|INT|DECIMAL|JSON|TIMESTAMP|DATE|TEXT|VECTOR)\b/g

function highlight(line: string) {
  // comment line
  if (line.trimStart().startsWith('--')) {
    return <span className="text-ink-faint italic">{line}</span>
  }
  const parts: React.ReactNode[] = []
  // split by tokens we care about
  const regex = /\b(CREATE|TABLE|PRIMARY|KEY|NOT|NULL|DEFAULT|VARCHAR|INT|DECIMAL|JSON|TIMESTAMP|DATE|TEXT|VECTOR)\b|('[^']*')|\b(CURRENT_TIMESTAMP)\b|(\b\d+\b)/g
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = regex.exec(line)) !== null) {
    if (m.index > last) parts.push(<span key={k++} className="text-ink-secondary">{line.slice(last, m.index)}</span>)
    const [tok, word, str, ts, num] = m
    let cls = 'text-ink-secondary'
    if (word) cls = KEYWORDS.test(word) && !TYPES.test(word) ? 'text-pulse-cyan' : 'text-nebula-violet'
    KEYWORDS.lastIndex = 0
    TYPES.lastIndex = 0
    if (str) cls = 'text-forge-amber'
    if (ts) cls = 'text-forge-amber'
    if (num) cls = 'text-jade-green'
    parts.push(
      <span key={k++} className={cls}>
        {tok}
      </span>,
    )
    last = m.index + tok.length
  }
  if (last < line.length) parts.push(<span key={k++} className="text-ink-secondary">{line.slice(last)}</span>)
  return <>{parts}</>
}

/* -------------------------------- section ------------------------------- */

export default function DbTables() {
  const [activeId, setActiveId] = useState('agents')
  const [hoverField, setHoverField] = useState<string | null>(null)
  const table = TABLES.find((t) => t.id === activeId) ?? AGENTS_TABLE
  const note = hoverField ? table.notes[hoverField] : undefined

  return (
    <section className="relative bg-deep">
      <div className="mx-auto max-w-site px-5 py-[72px] md:px-12 md:py-[120px]">
        <SectionHeader
          hud="DATA MODEL"
          title="核心数据表"
          subtitle="一位数字工匠的身份、身价与信用，全部沉淀在两张核心表里。hover 字段行，查看中文注解。"
        />

        {/* tabs */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="mt-12 flex flex-wrap items-center gap-2"
        >
          {TABLES.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                setActiveId(t.id)
                setHoverField(null)
              }}
              className={cn(
                'flex items-center gap-2 rounded-full border px-4 py-2 font-mono text-xs transition-all duration-300',
                activeId === t.id
                  ? 'border-pulse-cyan/60 bg-pulse-cyan/10 text-pulse-cyan'
                  : 'border-line-subtle text-ink-faint hover:text-ink-secondary',
                t.planned && activeId !== t.id && 'opacity-60',
              )}
            >
              {t.planned ? <Lock className="h-3 w-3" /> : <Database className="h-3 w-3" />}
              {t.tab}
              {t.planned && <span className="rounded-full bg-ink-faint/20 px-1.5 py-0.5 text-[9px]">规划中</span>}
            </button>
          ))}
        </motion.div>

        <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_280px]">
          {/* code card */}
          <AnimatePresence mode="wait">
            <motion.div
              key={table.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: 0.3 }}
              className={cn('overflow-hidden rounded-xl border border-line-subtle bg-[#0B1120]', table.planned && 'opacity-70')}
            >
              {/* macOS header */}
              <div className="flex items-center gap-2 border-b border-line-subtle px-4 py-3">
                <span className="h-2.5 w-2.5 rounded-full bg-ember-red/70" />
                <span className="h-2.5 w-2.5 rounded-full bg-forge-amber/70" />
                <span className="h-2.5 w-2.5 rounded-full bg-jade-green/70" />
                <span className="ml-3 font-mono text-[11px] text-ink-faint">{table.file}</span>
              </div>
              <div className="overflow-x-auto p-5">
                <pre className="font-mono text-[13px] leading-[1.9] md:text-[13.5px]">
                  <div className="text-ink-faint italic">-- {table.comment}</div>
                  {table.lines.map((l, i) => (
                    <motion.div
                      key={`${table.id}-${i}`}
                      initial={{ backgroundColor: 'rgba(34,211,238,0.06)' }}
                      animate={{ backgroundColor: 'rgba(34,211,238,0)' }}
                      transition={{ duration: 0.8, delay: 0.2 + i * 0.05 }}
                      onMouseEnter={() => l.field && !table.planned && setHoverField(l.field)}
                      onMouseLeave={() => setHoverField(null)}
                      className={cn(
                        'rounded px-2 -mx-2 whitespace-pre',
                        l.field && !table.planned && 'cursor-default hover:bg-pulse-cyan/[0.06]',
                        hoverField && l.field === hoverField && 'bg-pulse-cyan/[0.08]',
                      )}
                    >
                      {highlight(l.raw)}
                    </motion.div>
                  ))}
                </pre>
              </div>
            </motion.div>
          </AnimatePresence>

          {/* field annotation column */}
          <div className="hidden lg:block">
            <div className="glass-panel sticky top-24 rounded-2xl p-5">
              <p className="hud-label text-[10px] text-ink-faint">FIELD NOTES · 字段注解</p>
              <AnimatePresence mode="wait">
                {note && hoverField ? (
                  <motion.div
                    key={hoverField}
                    initial={{ opacity: 0, x: 8 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -4 }}
                    transition={{ duration: 0.2 }}
                    className="mt-4"
                  >
                    <p className="font-mono text-sm font-medium text-pulse-cyan">{hoverField}</p>
                    <p className="mt-2.5 text-[13px] leading-relaxed text-ink-secondary">{note}</p>
                  </motion.div>
                ) : (
                  <motion.p
                    key="empty"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="mt-4 text-[13px] leading-relaxed text-ink-faint"
                  >
                    {table.planned ? '该表结构仍在评审中，随记忆服务二期上线。' : '将光标移到左侧任意字段行，这里会浮出它的中文注解。'}
                  </motion.p>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
