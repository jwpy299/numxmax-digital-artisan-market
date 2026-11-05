import { useMemo } from 'react'
import { motion } from 'framer-motion'
import { BadgeCheck, Cpu, Fingerprint, Landmark, ShieldCheck } from 'lucide-react'
import type { DetailData } from '@/components/agent-detail/detail-data'
import { didForSlug, stableHash } from '@/lib/flagship'
import HudCorner from '@/components/HudCorner'
import { cn } from '@/lib/utils'

const easeOut = [0.16, 1, 0.3, 1] as [number, number, number, number]

/** 装饰性「二维码」占位：按 DID 稳定生成的方块矩阵（非真实二维码） */
function FauxQr({ did }: { did: string }) {
  const cells = useMemo(() => {
    const hash = stableHash(`qr:${did}`)
    // 10x10 = 100 cells，取前 25 个 hex（100 bit）
    const bits: boolean[] = []
    for (const ch of hash.slice(0, 25)) {
      const n = parseInt(ch, 16)
      for (let b = 3; b >= 0; b--) bits.push(((n >> b) & 1) === 1)
    }
    return bits
  }, [did])

  return (
    <div className="relative shrink-0 rounded-md border border-amber-500/25 bg-zinc-950 p-2" aria-hidden>
      <div className="grid grid-cols-10 gap-[2px]">
        {cells.map((on, i) => (
          <span
            key={i}
            className={cn('h-[7px] w-[7px] rounded-[1px]', on ? 'bg-amber-400/85' : 'bg-zinc-800/70')}
          />
        ))}
      </div>
      {/* 三角定位块（仿二维码角标） */}
      <span className="absolute left-1 top-1 h-3 w-3 rounded-[2px] border-2 border-emerald-400/80" />
      <span className="absolute right-1 top-1 h-3 w-3 rounded-[2px] border-2 border-emerald-400/80" />
      <span className="absolute bottom-1 left-1 h-3 w-3 rounded-[2px] border-2 border-emerald-400/80" />
    </div>
  )
}

interface IdentityCardProps {
  agent: DetailData['agent']
  /** 后端 identity.did（若详情接口已返回）；缺省按 slug 拼 */
  did?: string
}

/** 「数字身份证」赛博凭证卡片：DID / 发行方 / 信任等级 / 存证哈希 / 发行日期 */
export default function IdentityCard({ agent, did }: IdentityCardProps) {
  const resolvedDid = did || didForSlug(agent.slug)
  const evidenceHash = useMemo(() => stableHash(resolvedDid), [resolvedDid])
  const trustLevel = agent.certified ? 'T3 · 研究院认证' : agent.status === 'active' ? 'T2 · 平台在册' : 'T1 · 基础登记'
  const listedDate = agent.listedAt
    ? new Date(agent.listedAt).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
    : '——'

  return (
    <section className="bg-void py-14 md:py-20">
      <div className="mx-auto max-w-site px-5 md:px-12">
        <motion.div
          initial={{ opacity: 0, y: 28 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.7, ease: easeOut }}
          className="mb-8"
        >
          <p className="hud-label text-amber-400/80">DIGITAL IDENTITY</p>
          <h2 className="mt-2 font-display text-2xl font-bold text-ink-primary md:text-3xl">数字身份证</h2>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ delay: 0.1, duration: 0.7, ease: easeOut }}
          className="cyber-glow-card cyber-scanline relative overflow-hidden rounded-2xl bg-zinc-950/80 p-6 md:p-10"
        >
          <HudCorner />
          {/* 左上角芯片图标 */}
          <div className="mb-6 flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-md border border-amber-500/40 bg-amber-500/10">
              <Cpu className="h-5 w-5 text-amber-400" />
            </span>
            <div className="leading-tight">
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-amber-400/70">
                NumX Max Identity Credential
              </p>
              <p className="text-xs text-ink-faint">链上数字员工身份凭证</p>
            </div>
          </div>

          <div className="grid items-start gap-8 md:grid-cols-[auto_1fr_auto]">
            {/* 形象照大头像 */}
            <div className="relative mx-auto md:mx-0">
              <div className="pointer-events-none absolute -inset-4 rounded-2xl bg-[radial-gradient(ellipse,rgba(245,165,36,0.16),transparent_65%)]" />
              <img
                src={agent.avatar}
                alt={agent.name}
                className="relative h-28 w-28 rounded-2xl border-2 border-amber-500/50 object-cover shadow-[0_0_32px_rgba(245,165,36,0.25)] md:h-36 md:w-36"
              />
              <span className="absolute -bottom-2 -right-2 flex h-7 w-7 items-center justify-center rounded-full border-2 border-zinc-950 bg-emerald-400">
                <BadgeCheck className="h-4 w-4 text-zinc-950" />
              </span>
            </div>

            {/* 凭证字段 */}
            <dl className="min-w-0 space-y-4">
              <div>
                <dt className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">
                  <Fingerprint className="h-3 w-3 text-amber-400/70" /> DID · 去中心化标识
                </dt>
                <dd className="mt-1.5 break-all font-mono text-sm tracking-wider text-amber-400 md:text-base">
                  {resolvedDid}
                </dd>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <dt className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">
                    <Landmark className="h-3 w-3 text-amber-400/70" /> 发行方
                  </dt>
                  <dd className="mt-1.5 text-sm text-ink-primary">NumX Max 智造研究院</dd>
                </div>
                <div>
                  <dt className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">
                    <ShieldCheck className="h-3 w-3 text-amber-400/70" /> 信任等级
                  </dt>
                  <dd className="mt-1.5">
                    <span className="rounded-sm border border-emerald-400/40 bg-emerald-400/10 px-2 py-0.5 font-mono text-xs text-emerald-400">
                      {trustLevel}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">发行日期</dt>
                  <dd className="mt-1.5 font-mono text-sm text-ink-primary">{listedDate}</dd>
                </div>
                <div>
                  <dt className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">在编编号</dt>
                  <dd className="mt-1.5 font-mono text-sm text-ink-primary">{agent.code}</dd>
                </div>
              </div>
              <div>
                <dt className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">存证哈希</dt>
                <dd
                  className="mt-1.5 break-all font-mono text-[11px] leading-relaxed tracking-wider text-ink-secondary"
                  title={evidenceHash}
                >
                  {evidenceHash}
                </dd>
              </div>
            </dl>

            {/* 右下角二维码占位 */}
            <div className="justify-self-center md:justify-self-end md:self-end">
              <FauxQr did={resolvedDid} />
              <p className="mt-2 text-center font-mono text-[9px] tracking-[0.2em] text-ink-faint">SCAN TO VERIFY</p>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  )
}
