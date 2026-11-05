import ArchHero from '@/components/architecture/ArchHero'
import ServiceMatrix from '@/components/architecture/ServiceMatrix'
import DataFlowDiagram from '@/components/architecture/DataFlowDiagram'
import DbTables from '@/components/architecture/DbTables'
import FrontendMap from '@/components/architecture/FrontendMap'
import ArchCta from '@/components/architecture/ArchCta'

export default function Architecture() {
  return (
    <>
      <ArchHero />
      <ServiceMatrix />
      <DataFlowDiagram />
      <DbTables />
      <FrontendMap />
      <ArchCta />
    </>
  )
}
