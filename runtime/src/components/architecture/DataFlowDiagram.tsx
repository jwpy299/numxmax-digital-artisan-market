import { useRef, useState } from 'react'
import { motion, useInView } from 'framer-motion'
import SectionHeader from '@/components/SectionHeader'
import HudCorner from '@/components/HudCorner'
import { cn } from '@/lib/utils'

/* ---------------------------------- data ---------------------------------- */

type NodeKind = 'participant' | 'service' | 'infra'

interface FlowNode {
  id: string
  label: string
  sub: string
  tip: string
  kind: NodeKind
  cx: number
  cy: number
  color: string // stroke / accent
}

const NODES: FlowNode[] = [
  // participants (top)
  { id: 'master', label: '老师傅', sub: 'EXPERIENCE SOURCE', tip: '提供数十年工艺经验，孵化并确认数字工匠的技能与定价。', kind: 'participant', cx: 200, cy: 80, color: '#7C5CFF' },
  { id: 'employer', label: '工厂 / 雇主', sub: 'DEMAND SIDE', tip: '搜索、试用并雇佣数字工匠，按月签约并下达生产任务。', kind: 'participant', cx: 600, cy: 80, color: '#22D3EE' },
  { id: 'ops', label: '平台运营', sub: 'GOVERNANCE', tip: '审核上架、定价引导、质量红线治理与流量扶持。', kind: 'participant', cx: 1000, cy: 80, color: '#F5A524' },
  // services (middle)
  { id: 'mgmt', label: '管理服务', sub: 'SVC-01', tip: 'Agent 创建、上架、搜索、定价、雇佣管理。', kind: 'service', cx: 130, cy: 320, color: '#8FA3E8' },
  { id: 'exec', label: '执行引擎', sub: 'SVC-02', tip: '任务解析、技能调度、执行监控。', kind: 'service', cx: 370, cy: 320, color: '#8FA3E8' },
  { id: 'pricing', label: '定价引擎', sub: 'SVC-03', tip: '初始定价、动态调价、市场分析。', kind: 'service', cx: 610, cy: 320, color: '#8FA3E8' },
  { id: 'memory', label: '记忆服务', sub: 'SVC-04', tip: '工作记忆存储、检索、更新。', kind: 'service', cx: 850, cy: 320, color: '#8FA3E8' },
  { id: 'settle', label: '雇佣结算', sub: 'SVC-05', tip: '雇佣费用结算、技能调用分账。', kind: 'service', cx: 1090, cy: 320, color: '#8FA3E8' },
  // infrastructure (bottom)
  { id: 'postgres', label: 'PostgreSQL', sub: 'INFRA · 关系数据', tip: '存储 Agent 档案、雇佣记录、评价与任务台账。', kind: 'infra', cx: 180, cy: 530, color: '#22D3EE' },
  { id: 'vector', label: '向量数据库', sub: 'INFRA · 记忆检索', tip: '承载工作记忆的向量化存储与语义检索。', kind: 'infra', cx: 480, cy: 530, color: '#22D3EE' },
  { id: 'token', label: 'Token 经济引擎', sub: 'INFRA · 结算', tip: '雇佣佣金与技能调用分账的 Token 流水引擎。', kind: 'infra', cx: 780, cy: 530, color: '#22D3EE' },
  { id: 'chain', label: '决策基因链', sub: 'INFRA · 存证', tip: '关键结算与决策上链存证，形成可审计的信用档案。', kind: 'infra', cx: 1080, cy: 530, color: '#22D3EE' },
]

interface FlowEdge {
  id: string
  d: string
  label: string
  lx: number
  ly: number
  nodes: [string, string]
  both?: boolean
  order: number
}

const EDGES: FlowEdge[] = [
  { id: 'e1', d: 'M200,108 C200,190 130,200 130,288', label: '孵化 / 上架', lx: 128, ly: 196, nodes: ['master', 'mgmt'], order: 0 },
  { id: 'e2', d: 'M600,108 C600,200 200,190 136,284', label: '搜索 / 雇佣', lx: 330, ly: 176, nodes: ['employer', 'mgmt'], order: 1 },
  { id: 'e3', d: 'M600,108 C600,180 400,200 372,288', label: '下达任务', lx: 520, ly: 186, nodes: ['employer', 'exec'], order: 2 },
  { id: 'e4', d: 'M460,334 C570,424 660,424 760,334', label: '读写记忆', lx: 566, ly: 412, nodes: ['exec', 'memory'], both: true, order: 3 },
  { id: 'e5', d: 'M1000,108 C1000,190 680,200 614,288', label: '定价引导', lx: 830, ly: 176, nodes: ['ops', 'pricing'], order: 4 },
  { id: 'e6', d: 'M520,300 C420,252 320,252 224,308', label: '动态调价', lx: 330, ly: 258, nodes: ['pricing', 'mgmt'], order: 5 },
  { id: 'e7', d: 'M130,352 C130,448 1060,428 1084,356', label: '佣金 / 分账', lx: 596, ly: 452, nodes: ['mgmt', 'settle'], order: 6 },
  { id: 'e8', d: 'M370,352 C370,462 1030,452 1078,358', label: '执行计量', lx: 700, ly: 468, nodes: ['exec', 'settle'], order: 7 },
  { id: 'e9', d: 'M124,352 C108,424 148,444 172,494', label: '读写', lx: 96, ly: 432, nodes: ['mgmt', 'postgres'], order: 8 },
  { id: 'e10', d: 'M844,352 C826,432 560,444 490,494', label: '记忆向量', lx: 660, ly: 448, nodes: ['memory', 'vector'], order: 9 },
  { id: 'e11', d: 'M1086,352 C1060,444 862,452 790,494', label: 'Token 流水', lx: 940, ly: 448, nodes: ['settle', 'token'], order: 10 },
  { id: 'e12', d: 'M1100,352 C1136,424 1116,448 1090,494', label: '上链存证', lx: 1130, ly: 428, nodes: ['settle', 'chain'], order: 11 },
]

const LAYER_LABELS = [
  { text: '参与者 · PARTICIPANTS', y: 34 },
  { text: '核心服务 · CORE SERVICES', y: 262 },
  { text: '基础设施 · INFRASTRUCTURE', y: 462 },
]

/* --------------------------------- pieces --------------------------------- */

function ParticipantNode({ node, active, dimmed, onHover }: NodeProps) {
  return (
    <motion.g
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: dimmed ? 0.35 : 1, scale: 1 }}
      transition={{ duration: 0.4 }}
      onMouseEnter={() => onHover(node.id)}
      onMouseLeave={() => onHover(null)}
      style={{ transformOrigin: `${node.cx}px ${node.cy}px`, cursor: 'pointer' }}
    >
      <rect
        x={node.cx - 85}
        y={node.cy - 28}
        width={170}
        height={56}
        rx={12}
        fill="rgba(16,24,48,0.7)"
        stroke={node.color}
        strokeOpacity={active ? 1 : 0.55}
        strokeWidth={active ? 1.6 : 1}
      />
      <text x={node.cx} y={node.cy - 2} textAnchor="middle" fill="#EDF2FF" fontSize={16} fontWeight={700} fontFamily="'Noto Sans SC', sans-serif">
        {node.label}
      </text>
      <text x={node.cx} y={node.cy + 16} textAnchor="middle" fill={node.color} fontSize={8.5} letterSpacing={1.5} fontFamily="'JetBrains Mono', monospace">
        {node.sub}
      </text>
    </motion.g>
  )
}

function ServiceNode({ node, active, dimmed, onHover, index, inView }: NodeProps & { index: number; inView: boolean }) {
  return (
    <motion.g
      initial={{ opacity: 0, scale: 0.8 }}
      animate={inView ? { opacity: dimmed ? 0.35 : 1, scale: 1 } : {}}
      transition={{ duration: 0.5, delay: 0.15 + index * 0.08, ease: [0.16, 1, 0.3, 1] }}
      onMouseEnter={() => onHover(node.id)}
      onMouseLeave={() => onHover(null)}
      style={{ transformOrigin: `${node.cx}px ${node.cy}px`, cursor: 'pointer' }}
    >
      <rect
        x={node.cx - 90}
        y={node.cy - 32}
        width={180}
        height={64}
        rx={10}
        fill="rgba(10,15,30,0.85)"
        stroke={active ? '#22D3EE' : 'rgba(124,140,222,0.45)'}
        strokeWidth={active ? 1.6 : 1}
        style={active ? { filter: 'drop-shadow(0 0 10px rgba(34,211,238,0.45))' } : undefined}
      />
      <text x={node.cx} y={node.cy + 2} textAnchor="middle" fill="#EDF2FF" fontSize={15} fontWeight={700} fontFamily="'Noto Sans SC', sans-serif">
        {node.label}
      </text>
      <text x={node.cx} y={node.cy + 20} textAnchor="middle" fill="#55638A" fontSize={9} letterSpacing={2} fontFamily="'JetBrains Mono', monospace">
        {node.sub}
      </text>
    </motion.g>
  )
}

function InfraNode({ node, active, dimmed, onHover, index, inView }: NodeProps & { index: number; inView: boolean }) {
  const w = 150
  const top = node.cy - 26
  const bottom = node.cy + 18
  return (
    <motion.g
      initial={{ opacity: 0, scale: 0.8 }}
      animate={inView ? { opacity: dimmed ? 0.35 : 1, scale: 1 } : {}}
      transition={{ duration: 0.5, delay: 0.55 + index * 0.08, ease: [0.16, 1, 0.3, 1] }}
      onMouseEnter={() => onHover(node.id)}
      onMouseLeave={() => onHover(null)}
      style={{ transformOrigin: `${node.cx}px ${node.cy}px`, cursor: 'pointer' }}
    >
      <path
        d={`M${node.cx - w / 2},${top} L${node.cx - w / 2},${bottom} A${w / 2},10 0 0 0 ${node.cx + w / 2},${bottom} L${node.cx + w / 2},${top}`}
        fill="rgba(16,24,48,0.75)"
        stroke={active ? '#22D3EE' : 'rgba(34,211,238,0.4)'}
        strokeWidth={active ? 1.6 : 1}
      />
      <ellipse
        cx={node.cx}
        cy={top}
        rx={w / 2}
        ry={10}
        fill="rgba(34,211,238,0.10)"
        stroke={active ? '#22D3EE' : 'rgba(34,211,238,0.4)'}
        strokeWidth={active ? 1.6 : 1}
      />
      <text x={node.cx} y={node.cy + 2} textAnchor="middle" fill="#EDF2FF" fontSize={13} fontWeight={500} fontFamily="'JetBrains Mono', monospace">
        {node.label}
      </text>
      <text x={node.cx} y={node.cy + 40} textAnchor="middle" fill="#55638A" fontSize={8.5} letterSpacing={1.5} fontFamily="'JetBrains Mono', monospace">
        {node.sub}
      </text>
    </motion.g>
  )
}

interface NodeProps {
  node: FlowNode
  active: boolean
  dimmed: boolean
  onHover: (id: string | null) => void
}

/* --------------------------------- section -------------------------------- */

export default function DataFlowDiagram() {
  const [hovered, setHovered] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { once: true, margin: '-120px' })

  const hoveredNode = NODES.find((n) => n.id === hovered) ?? null
  const isEdgeActive = (e: FlowEdge) => hovered !== null && e.nodes.includes(hovered)

  return (
    <section className="relative bg-void">
      <div className="mx-auto max-w-site px-5 py-[72px] md:px-12 md:py-[120px]">
        <SectionHeader
          hud="DATA FLOW"
          title="数据流架构蓝图"
          subtitle="经验自老师傅流入，任务自雇主下达，价值经结算服务分账回流—— hover 任一节点，追踪它的数据链路。"
        />

        <motion.div
          ref={ref}
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-100px' }}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          className="relative mx-auto mt-14 max-w-[1200px]"
        >
          <div className="relative rounded-2xl border border-line-subtle bg-[#070B18] p-2 md:p-4">
            <HudCorner />
            {/* blueprint grid inside panel */}
            <div
              aria-hidden
              className="absolute inset-0 rounded-2xl"
              style={{
                backgroundImage:
                  'linear-gradient(rgba(124,140,222,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(124,140,222,0.05) 1px, transparent 1px)',
                backgroundSize: '40px 40px',
              }}
            />
            <div className="relative aspect-[1200/640] w-full">
              <svg viewBox="0 0 1200 640" className="h-full w-full">
                <defs>
                  <marker id="flow-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M0,0 L10,5 L0,10 z" fill="#55638A" />
                  </marker>
                  <marker id="flow-arrow-hl" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M0,0 L10,5 L0,10 z" fill="#22D3EE" />
                  </marker>
                </defs>

                {/* layer labels */}
                {LAYER_LABELS.map((l) => (
                  <text key={l.text} x={24} y={l.y} fill="#55638A" fontSize={9.5} letterSpacing={2.5} fontFamily="'JetBrains Mono', monospace">
                    {l.text}
                  </text>
                ))}

                {/* edges */}
                {EDGES.map((e) => {
                  const active = isEdgeActive(e)
                  const dimmed = hovered !== null && !active
                  return (
                    <g key={e.id}>
                      <motion.path
                        d={e.d}
                        fill="none"
                        stroke={active ? '#22D3EE' : '#55638A'}
                        strokeOpacity={dimmed ? 0.15 : active ? 0.95 : 0.5}
                        strokeWidth={active ? 1.8 : 1.1}
                        initial={{ pathLength: 0 }}
                        animate={inView ? { pathLength: 1 } : {}}
                        transition={{ duration: 0.9, delay: 0.3 + e.order * 0.12, ease: 'easeOut' }}
                        markerEnd={active || !dimmed ? `url(#${active ? 'flow-arrow-hl' : 'flow-arrow'})` : undefined}
                        markerStart={e.both && !dimmed ? `url(#${active ? 'flow-arrow-hl' : 'flow-arrow'})` : undefined}
                        style={{ transition: 'stroke-opacity 0.3s, stroke 0.3s' }}
                      />
                      {/* flowing dashes */}
                      <motion.path
                        d={e.d}
                        fill="none"
                        stroke={active ? '#22D3EE' : '#7C8CDE'}
                        strokeWidth={active ? 2 : 1.2}
                        strokeDasharray="3 14"
                        strokeLinecap="round"
                        initial={{ opacity: 0 }}
                        animate={inView ? { opacity: dimmed ? 0.05 : active ? 0.95 : 0.4, strokeDashoffset: [0, -68] } : {}}
                        transition={{
                          opacity: { duration: 0.4, delay: 0.8 + e.order * 0.12 },
                          strokeDashoffset: { duration: 1.6, repeat: Infinity, ease: 'linear' },
                        }}
                      />
                      <motion.text
                        x={e.lx}
                        y={e.ly}
                        textAnchor="middle"
                        fill={active ? '#22D3EE' : '#94A3C7'}
                        fontSize={11}
                        fontFamily="'JetBrains Mono', monospace"
                        initial={{ opacity: 0 }}
                        animate={inView ? { opacity: dimmed ? 0.1 : active ? 1 : 0.7 } : {}}
                        transition={{ duration: 0.4, delay: 0.6 + e.order * 0.12 }}
                      >
                        {e.label}
                      </motion.text>
                    </g>
                  )
                })}

                {/* nodes */}
                {NODES.filter((n) => n.kind === 'participant').map((n) => (
                  <ParticipantNode
                    key={n.id}
                    node={n}
                    active={hovered === n.id}
                    dimmed={hovered !== null && hovered !== n.id && !EDGES.some((e) => isEdgeActive(e) && e.nodes.includes(n.id))}
                    onHover={setHovered}
                  />
                ))}
                {NODES.filter((n) => n.kind === 'service').map((n, i) => (
                  <ServiceNode
                    key={n.id}
                    node={n}
                    index={i}
                    inView={inView}
                    active={hovered === n.id}
                    dimmed={hovered !== null && hovered !== n.id && !EDGES.some((e) => isEdgeActive(e) && e.nodes.includes(n.id))}
                    onHover={setHovered}
                  />
                ))}
                {NODES.filter((n) => n.kind === 'infra').map((n, i) => (
                  <InfraNode
                    key={n.id}
                    node={n}
                    index={i}
                    inView={inView}
                    active={hovered === n.id}
                    dimmed={hovered !== null && hovered !== n.id && !EDGES.some((e) => isEdgeActive(e) && e.nodes.includes(n.id))}
                    onHover={setHovered}
                  />
                ))}
              </svg>

              {/* node tooltip */}
              {hoveredNode && (
                <motion.div
                  key={hoveredNode.id}
                  initial={{ opacity: 0, x: 8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.2 }}
                  className={cn(
                    'glass-panel pointer-events-none absolute z-10 w-56 rounded-xl p-3.5',
                    hoveredNode.cx > 800 ? '-translate-x-full' : '',
                  )}
                  style={{
                    left: `${(((hoveredNode.cx > 800 ? hoveredNode.cx - 100 : hoveredNode.cx + 100) / 1200) * 100).toFixed(2)}%`,
                    top: `${((Math.min(hoveredNode.cy, 460) / 640) * 100).toFixed(2)}%`,
                  }}
                >
                  <p className="font-mono text-[10px] uppercase tracking-[0.18em]" style={{ color: hoveredNode.color }}>
                    {hoveredNode.sub}
                  </p>
                  <p className="mt-1 text-sm font-bold text-ink-primary">{hoveredNode.label}</p>
                  <p className="mt-1.5 text-xs leading-relaxed text-ink-secondary">{hoveredNode.tip}</p>
                </motion.div>
              )}
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  )
}
