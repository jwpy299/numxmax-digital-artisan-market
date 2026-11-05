import { useCallback, useRef } from 'react'
import LifecycleHero from '@/components/lifecycle/LifecycleHero'
import LifecycleJourney from '@/components/lifecycle/LifecycleJourney'
import LifecycleCta from '@/components/lifecycle/LifecycleCta'

export default function Lifecycle() {
  const scrollerRef = useRef<(act: number) => void>(() => {})

  const registerScroller = useCallback((fn: (act: number) => void) => {
    scrollerRef.current = fn
  }, [])

  const handleActClick = useCallback((act: number) => {
    scrollerRef.current(act)
  }, [])

  return (
    <>
      <LifecycleHero onActClick={handleActClick} />
      <LifecycleJourney registerScroller={registerScroller} />
      <LifecycleCta />
    </>
  )
}
