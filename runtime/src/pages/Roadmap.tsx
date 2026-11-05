import RoadmapHero from '@/components/roadmap/RoadmapHero'
import ColdStart from '@/components/roadmap/ColdStart'
import DualIncentive from '@/components/roadmap/DualIncentive'
import QualityControl from '@/components/roadmap/QualityControl'
import LaunchTimeline from '@/components/roadmap/LaunchTimeline'
import ValueFinale from '@/components/roadmap/ValueFinale'
import BetaCta from '@/components/roadmap/BetaCta'

export default function Roadmap() {
  return (
    <>
      <RoadmapHero />
      <ColdStart />
      <DualIncentive />
      <QualityControl />
      <LaunchTimeline />
      <ValueFinale />
      <BetaCta />
    </>
  )
}
