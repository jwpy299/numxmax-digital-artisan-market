import HeroSection from '@/components/home/HeroSection'
import AgentMarketLiveBanner from '@/components/home/AgentMarketLiveBanner'
import ParadigmSection from '@/components/home/ParadigmSection'
import ConceptSection from '@/components/home/ConceptSection'
import FeaturedAgentsSection from '@/components/home/FeaturedAgentsSection'
import LifecyclePreviewSection from '@/components/home/LifecyclePreviewSection'
import DataPulseSection from '@/components/home/DataPulseSection'
import ValueSection from '@/components/home/ValueSection'
import CtaSection from '@/components/home/CtaSection'

export default function Home() {
  return (
    <>
      <HeroSection />
      <div className="mx-auto max-w-site px-5 py-10 md:px-12">
        <AgentMarketLiveBanner />
      </div>
      <ParadigmSection />
      <ConceptSection />
      <FeaturedAgentsSection />
      <LifecyclePreviewSection />
      <DataPulseSection />
      <ValueSection />
      <CtaSection />
    </>
  )
}
