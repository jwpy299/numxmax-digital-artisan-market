import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, Loader2 } from 'lucide-react'
import HudCorner from '@/components/HudCorner'
import { SmsCodeRow } from '@/components/auth/SmsCodeRow'
import { wbMutation } from '@/lib/wbSession'
import { phoneValid, codeValid } from '@/lib/wbSms'

const TITLE_WORDS = ['第', '101', '家', '工厂，', '会是', '你吗？']

type FormState = 'idle' | 'submitting' | 'done'

export default function BetaCta() {
  const [factory, setFactory] = useState('')
  const [contact, setContact] = useState('')
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [need, setNeed] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [state, setState] = useState<FormState>('idle')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (state !== 'idle') return
    setErr(null)
    if (!factory.trim() || !contact.trim()) { setErr('请填工厂名称与联系人'); return }
    if (!phoneValid(phone) || !codeValid(code)) { setErr('请填正确手机号并先取验证码'); return }
    setState('submitting')
    try {
      // 卡位快报：行业/规模缺省「待补」（评审电话回访补全——后端闸不动）
      await wbMutation('betaApply.submit', {
        enterpriseName: factory.trim(), contactName: contact.trim(),
        phone: phone.trim(), code: code.trim(),
        industry: '卡位快报·待补', headcount: '待补',
        need: need.trim() || '（卡位快报——首页 CTA 直入）',
      })
      setState('done')
    } catch (error) {
      setErr(error instanceof Error ? error.message : '提交失败，稍后再试')
      setState('idle')
    }
  }

  return (
    <section className="relative overflow-hidden bg-void">
      {/* layered glow backgrounds */}
      <motion.img
        src="/workbench-glow.png"
        alt=""
        aria-hidden
        animate={{ x: ['-2%', '2%', '-2%'] }}
        transition={{ duration: 10, repeat: Infinity, ease: 'easeInOut' }}
        className="pointer-events-none absolute inset-0 h-full w-full scale-110 object-cover opacity-35"
      />
      <img
        src="/nebula-band.png"
        alt=""
        aria-hidden
        className="pointer-events-none absolute bottom-0 left-0 w-full object-cover opacity-40"
      />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-void via-transparent to-void/80" />

      <div className="relative mx-auto max-w-site px-5 py-[72px] md:px-12 md:py-[120px]">
        <div className="glass-panel relative mx-auto max-w-2xl rounded-2xl p-8 text-center md:p-12">
          <HudCorner />
          <motion.p
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.6 }}
            className="hud-label text-pulse-cyan/80"
          >
            CLOSED BETA · FINAL CALL
          </motion.p>

          <h2 className="mt-4 font-display text-[26px] font-bold leading-[1.25] tracking-[0.02em] text-ink-primary md:text-[44px]">
            {TITLE_WORDS.map((w, i) => (
              <motion.span
                key={`${w}-${i}`}
                initial={{ opacity: 0, y: 40 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-80px' }}
                transition={{ duration: 0.7, delay: 0.1 + i * 0.06, ease: [0.16, 1, 0.3, 1] }}
                className="mr-1.5 inline-block last:mr-0"
              >
                {w === '101' ? <span className="text-amber-gradient">{w}</span> : w}
              </motion.span>
            ))}
          </h2>

          <motion.p
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.6, delay: 0.45 }}
            className="mt-4 text-[14px] leading-relaxed text-ink-secondary md:text-base"
          >
            前 100 家名额正在递减。加入内测，首月雇佣费 5 折。
          </motion.p>

          {/* application form */}
          <motion.form
            onSubmit={submit}
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.6, delay: 0.5, ease: [0.16, 1, 0.3, 1] }}
            className="mt-8 flex flex-col flex-wrap gap-3 md:flex-row"
          >
            <input
              value={factory}
              onChange={(e) => setFactory(e.target.value)}
              placeholder="工厂名称"
              disabled={state !== 'idle'}
              className="h-12 flex-1 rounded-[10px] border border-line-subtle bg-void/60 px-4 text-sm text-ink-primary outline-none transition-colors placeholder:text-ink-faint focus:border-nebula-violet/60 disabled:opacity-50"
            />
            <input
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              placeholder="联系人"
              disabled={state !== 'idle'}
              className="h-12 flex-1 rounded-[10px] border border-line-subtle bg-void/60 px-4 text-sm text-ink-primary outline-none transition-colors placeholder:text-ink-faint focus:border-nebula-violet/60 disabled:opacity-50"
            />
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              inputMode="numeric"
              maxLength={11}
              placeholder="手机号（接收内测码）"
              disabled={state !== 'idle'}
              className="h-12 flex-1 rounded-[10px] border border-line-subtle bg-void/60 px-4 text-sm text-ink-primary outline-none transition-colors placeholder:text-ink-faint focus:border-nebula-violet/60 disabled:opacity-50"
            />
            <motion.button
              type="submit"
              whileHover={state === 'idle' ? { scale: 1.03 } : {}}
              whileTap={state === 'idle' ? { scale: 0.97 } : {}}
              className={`relative h-12 shrink-0 overflow-hidden rounded-[10px] px-6 text-sm font-medium transition-all duration-300 ${
                state === 'done' ? 'bg-jade-green/90 text-[#04150D]' : 'bg-amber-gradient text-[#1A1206] hover:shadow-[0_0_28px_rgba(245,165,36,0.45)]'
              }`}
            >
              <AnimatePresence mode="wait" initial={false}>
                {state === 'idle' && (
                  <motion.span key="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
                    申请内测
                  </motion.span>
                )}
                {state === 'submitting' && (
                  <motion.span
                    key="submitting"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="inline-flex items-center gap-2"
                  >
                    <Loader2 className="h-4 w-4 animate-spin" />
                    提交中
                  </motion.span>
                )}
                {state === 'done' && (
                  <motion.span
                    key="done"
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3 }}
                    className="inline-flex items-center gap-2"
                  >
                    <Check className="h-4 w-4" strokeWidth={3} />
                    已加入候选名单
                  </motion.span>
                )}
              </AnimatePresence>
            </motion.button>
            <div className="w-full md:col-span-3">
              <SmsCodeRow phone={phone} purpose="beta_apply" code={code} onCodeChange={setCode} />
            </div>
            <input
              value={need}
              onChange={(e) => setNeed(e.target.value)}
              placeholder="你最想数字员工干什么？（一句话，可选）"
              disabled={state !== 'idle'}
              maxLength={200}
              className="h-12 w-full rounded-[10px] border border-line-subtle bg-void/60 px-4 text-sm text-ink-primary outline-none transition-colors placeholder:text-ink-faint focus:border-nebula-violet/60 disabled:opacity-50 md:col-span-3"
            />
            {err && <p className="w-full text-[12px] text-ember-red md:col-span-3">{err}</p>}

          </motion.form>

          <motion.p
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.8, delay: 0.8 }}
            className="mt-8 font-mono text-[10px] uppercase tracking-[0.22em] text-ink-faint"
          >
            NumX Max Artisan Market · Closed Beta · 2026
          </motion.p>
        </div>
      </div>
    </section>
  )
}
