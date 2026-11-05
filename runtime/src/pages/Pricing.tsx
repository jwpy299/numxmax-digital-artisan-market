import { useCallback } from 'react'
import PricingHero from '@/components/pricing/PricingHero'
import PricingSimulator from '@/components/pricing/PricingSimulator'
import PricingRules from '@/components/pricing/PricingRules'
import RevenueModel from '@/components/pricing/RevenueModel'
import LifetimeProjection from '@/components/pricing/LifetimeProjection'
import RevenueComparison from '@/components/pricing/RevenueComparison'
import PricingCta from '@/components/pricing/PricingCta'

export default function Pricing() {
  const scrollToSimulator = useCallback(() => {
    document.getElementById('simulator')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [])

  return (
    <>
      <PricingHero />
      <section id="simulator" className="bg-deep px-5 py-16 md:px-12 md:py-24">
        <PricingSimulator />
      </section>
      <PricingRules />
      <RevenueModel />
      <LifetimeProjection />
      <RevenueComparison />
      <PricingCta onSimulate={scrollToSimulator} />
    </>
  )
}
