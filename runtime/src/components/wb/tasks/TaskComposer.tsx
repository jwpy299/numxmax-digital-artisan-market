import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { AlertCircle, ChevronDown, Lock, SendHorizonal } from 'lucide-react'
import GlowButton from '@/components/GlowButton'
import HudCorner from '@/components/HudCorner'
import { cn } from '@/lib/utils'
import type { HireItem } from '@/components/wb/tasks/types'

const QUICK_CHIPS = [
  '帮我看一下 3 号 CNC 的振动频谱有没有异常',
  '评估本月刀具磨损趋势',
  '对比上周与本周主轴温升',
  '生成 2 月设备健康报告',
]

interface TaskComposerProps {
  hires: HireItem[] | undefined
  selectedHireId: number | null
  onSelectHire: (id: number) => void
  instruction: string
  onInstructionChange: (v: string) => void
  /** 执行中：输入框锁定显示已下达任务 */
  locked: boolean
  /** tasks.create 请求中 */
  pending: boolean
  error: string | null
  /** 点击员工卡「下达任务」后的 cyan 描边闪烁 */
  flash: boolean
  onSubmit: () => void
  sectionRef: React.RefObject<HTMLElement | null>
  inputRef: React.RefObject<HTMLInputElement | null>
}

export default function TaskComposer(props: TaskComposerProps) {
  const {
    hires, selectedHireId, onSelectHire, instruction, onInstructionChange,
    locked, pending, error, flash, onSubmit, sectionRef, inputRef,
  } = props
  const [selectOpen, setSelectOpen] = useState(false)
  const selectRef = useRef<HTMLDivElement>(null)

  const options = (hires ?? []).filter((h) => h.agent && (h.status === 'active' || h.status === 'trial'))
  const selected = options.find((h) => h.id === selectedHireId) ?? options[0]

  useEffect(() => {
    if (!selectOpen) return
    const onDoc = (e: MouseEvent) => {
      if (selectRef.current && !selectRef.current.contains(e.target as Node)) setSelectOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [selectOpen])

  const disabled = locked || pending || !selected

  return (
    <section ref={sectionRef} className="relative overflow-hidden bg-void py-16 md:py-24">
      <div aria-hidden className="nebula-halo pointer-events-none absolute left-1/2 top-1/2 h-[420px] w-[820px] -translate-x-1/2 -translate-y-1/2" />
      <div className="relative mx-auto max-w-site px-5 md:px-12">
        <motion.div
          initial={{ opacity: 0, scale: 0.96 }}
          whileInView={{ opacity: 1, scale: 1 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="glass-panel relative mx-auto max-w-[880px] rounded-2xl p-7 md:p-9"
        >
          <HudCorner />
          <p className="hud-label text-pulse-cyan/80">TASK DISPATCH · NATURAL LANGUAGE</p>
          <h2 className="mt-2 font-display text-[22px] font-bold text-ink-primary md:text-2xl">对工匠说句话</h2>

          {/* 输入行 */}
          <motion.div
            animate={flash ? { boxShadow: ['0 0 0 rgba(34,211,238,0)', '0 0 24px rgba(34,211,238,0.55)', '0 0 0 rgba(34,211,238,0)', '0 0 24px rgba(34,211,238,0.55)', '0 0 0 rgba(34,211,238,0)'] } : { boxShadow: '0 0 0 rgba(34,211,238,0)' }}
            transition={{ duration: 1.6 }}
            className="mt-6 flex h-16 items-center gap-3 rounded-xl border border-line-subtle bg-void/60 pl-5 pr-2 transition-colors focus-within:border-pulse-cyan/60"
          >
            {locked ? (
              <Lock className="h-4 w-4 shrink-0 text-pulse-cyan" />
            ) : (
              <SendHorizonal className="h-4 w-4 shrink-0 text-ink-faint" />
            )}
            <input
              ref={inputRef}
              value={instruction}
              onChange={(e) => onInstructionChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !disabled && instruction.trim().length >= 2) onSubmit()
              }}
              disabled={disabled}
              placeholder="告诉工匠要做什么，例如：帮我看一下 3 号 CNC 的振动频谱有没有异常"
              className="h-full w-full bg-transparent text-sm text-ink-primary outline-none transition-opacity placeholder:text-ink-faint placeholder:transition-opacity focus:placeholder:opacity-40 disabled:text-ink-secondary"
            />
            <GlowButton
              variant="primary"
              onClick={onSubmit}
              className={cn('h-11 shrink-0 px-6 text-sm', (disabled || instruction.trim().length < 2) && 'pointer-events-none opacity-50')}
            >
              {pending ? '解析中…' : locked ? '执行中' : '下达'}
            </GlowButton>
          </motion.div>

          {/* 快捷 chips + 工匠选择 */}
          <div className="mt-5 flex flex-wrap items-center gap-2">
            {QUICK_CHIPS.map((chip, i) => (
              <motion.button
                key={chip}
                type="button"
                initial={{ opacity: 0, scale: 0.9 }}
                whileInView={{ opacity: 1, scale: 1 }}
                viewport={{ once: true }}
                transition={{ delay: 0.3 + 0.07 * i, type: 'spring', stiffness: 300, damping: 20 }}
                onClick={() => !locked && onInstructionChange(chip)}
                className="rounded-full border border-pulse-cyan/30 px-3 py-1.5 text-xs text-ink-secondary transition-colors hover:border-pulse-cyan/60 hover:bg-pulse-cyan/10 hover:text-pulse-cyan"
              >
                {chip}
              </motion.button>
            ))}

            {/* 执行工匠下拉 */}
            <div ref={selectRef} className="relative ml-auto">
              <button
                type="button"
                disabled={locked || options.length === 0}
                onClick={() => setSelectOpen((v) => !v)}
                className="flex items-center gap-2 rounded-full border border-line-subtle bg-panel/60 py-1.5 pl-2 pr-3 text-xs text-ink-primary transition-colors hover:border-nebula-violet/60 disabled:opacity-50"
              >
                {selected?.agent ? (
                  <>
                    <img src={selected.agent.avatar} alt="" className="h-5 w-5 rounded-full object-cover" />
                    执行工匠：{selected.agent.name}
                  </>
                ) : (
                  '暂无可派遣工匠'
                )}
                <ChevronDown className={cn('h-3.5 w-3.5 text-ink-faint transition-transform', selectOpen && 'rotate-180')} />
              </button>
              <AnimatePresence>
                {selectOpen && (
                  <motion.ul
                    initial={{ opacity: 0, y: -6, scale: 0.97 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -6, scale: 0.97 }}
                    transition={{ duration: 0.18 }}
                    className="glass-panel absolute right-0 top-full z-30 mt-2 w-56 overflow-hidden rounded-xl p-1.5"
                  >
                    {options.map((h) => (
                      <li key={h.id}>
                        <button
                          type="button"
                          onClick={() => {
                            onSelectHire(h.id)
                            setSelectOpen(false)
                          }}
                          className={cn(
                            'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs transition-colors hover:bg-pulse-cyan/10',
                            selected?.id === h.id ? 'text-pulse-cyan' : 'text-ink-secondary',
                          )}
                        >
                          <img src={h.agent!.avatar} alt="" className="h-6 w-6 rounded-full object-cover" />
                          <span className="flex-1">
                            {h.agent!.name}
                            <span className="ml-2 font-mono text-[10px] text-ink-faint">
                              {h.status === 'trial' ? '试用中' : '合约中'}
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </motion.ul>
                )}
              </AnimatePresence>
            </div>
          </div>

          {/* 错误提示 */}
          <AnimatePresence>
            {error && (
              <motion.p
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="mt-4 flex items-center gap-2 rounded-lg border border-ember-red/30 bg-ember-red/10 px-3 py-2 text-xs text-ember-red"
              >
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                {error}
              </motion.p>
            )}
          </AnimatePresence>
        </motion.div>
      </div>
    </section>
  )
}
