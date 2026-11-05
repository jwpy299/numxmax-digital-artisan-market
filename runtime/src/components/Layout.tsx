import { useEffect } from 'react'
import { Outlet, useLocation } from 'react-router'
import Lenis from 'lenis'
import Navbar from '@/components/Navbar'
import Footer from '@/components/Footer'
import CustomCursor from '@/components/CustomCursor'

export default function Layout() {
  const { pathname } = useLocation()

  // Lenis smooth scrolling (lerp 0.1 per design.md)
  useEffect(() => {
    const lenis = new Lenis({ lerp: 0.1 })
    let rafId = 0
    const raf = (time: number) => {
      lenis.raf(time)
      rafId = requestAnimationFrame(raf)
    }
    rafId = requestAnimationFrame(raf)
    return () => {
      cancelAnimationFrame(rafId)
      lenis.destroy()
    }
  }, [])

  // scroll to top on route change
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
  }, [pathname])

  return (
    <div className="min-h-[100dvh] bg-void">
      <CustomCursor />
      <Navbar />
      <main>
        <Outlet />
      </main>
      <Footer />
    </div>
  )
}
