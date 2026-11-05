import HudCorner from '@/components/HudCorner'

export interface LegalSection {
  heading: string
  paragraphs: string[]
}

interface LegalLayoutProps {
  title: string
  subtitle: string
  sections: LegalSection[]
}

/** 合规文书页统一排版：暗色门户风格 + 版本/生效日期头 + 结构化章节 */
export default function LegalLayout({ title, subtitle, sections }: LegalLayoutProps) {
  return (
    <div className="relative mx-auto max-w-3xl px-5 py-16 md:px-8 md:py-24">
      <header className="mb-10">
        <p className="hud-label text-pulse-cyan/80">LEGAL</p>
        <h1 className="mt-3 font-display text-3xl font-bold text-ink-primary md:text-4xl">{title}</h1>
        <p className="mt-3 font-mono text-xs tracking-wider text-ink-faint">
          版本 v1.0 · 生效日期 2026-08-10
        </p>
        <p className="mt-2 text-sm text-ink-secondary">{subtitle}</p>
      </header>

      <div className="space-y-6">
        {sections.map((sec, i) => (
          <section
            key={sec.heading}
            className="cyber-glow-card relative rounded-2xl bg-zinc-950/70 p-6 md:p-8"
          >
            <HudCorner />
            <h2 className="font-display text-lg font-bold text-ink-primary">
              {i + 1}. {sec.heading}
            </h2>
            <div className="mt-3 space-y-2.5">
              {sec.paragraphs.map((p, j) => (
                <p key={j} className="text-sm leading-relaxed text-ink-secondary">
                  {p}
                </p>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
