/**
 * DigitalHumanSafe：3D 数字人的安全壳（iter88 沙箱 Day1 修复）。
 * 背景：无 ErrorBoundary 时，three/WebGL 初始化失败会把错误抛穿整棵组件树
 * （市场页空白/导购按钮破图）。这里提供：错误边界 + Suspense + 静态图兜底。
 */
import { Component, Suspense, lazy, useEffect, useRef, useState, type ReactNode } from 'react'

const DigitalHuman = lazy(() =>
  import('./DigitalHuman').then((m) => ({ default: m.DigitalHuman })),
)

interface Props {
  seed: string
  palette?: { primary: string; accent: string }
  size?: number
  className?: string
  speaking?: boolean
  /** WebGL 不可用/加载失败时的静态兜底图（可选，缺省兜底为占位圆点） */
  fallbackImg?: string
}

class DHErrorBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch() {
    /* 静默降级：3D 失败不阻塞页面 */
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

function DefaultFallback({ size, img, alt }: { size: number; img?: string; alt: string }) {
  if (img) {
    return <img src={img} alt={alt} loading="lazy" style={{ width: size, height: size, objectFit: 'cover', borderRadius: 12 }} />
  }
  return (
    <div
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: 'radial-gradient(circle at 35% 30%, #f5c97a33, #e8a33d22)',
        border: '1px solid #e8a33d44',
      }}
    />
  )
}

export function DigitalHumanSafe({ seed, palette = { primary: '#F5A524', accent: '#22D3EE' }, size = 160, className, speaking, fallbackImg }: Props) {
  const fallback = <DefaultFallback size={size} img={fallbackImg} alt={seed} />
  // iter88 修复：浏览器 WebGL context 上限约 8-16 个，市场页几十张卡片同开会把
  // context 打爆（Canvas 白块）。可见才挂载、滚出视口即卸载释放。
  const hostRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const el = hostRef.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const ob = new IntersectionObserver(
      (entries) => {
        for (const e of entries) setVisible(e.isIntersecting)
      },
      { rootMargin: '120px', threshold: 0.05 },
    )
    ob.observe(el)
    return () => ob.disconnect()
  }, [])
  return (
    <div ref={hostRef} style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {visible ? (
        <DHErrorBoundary fallback={fallback}>
          <Suspense fallback={fallback}>
            <DigitalHuman seed={seed} palette={palette} size={size} className={className} speaking={speaking} />
          </Suspense>
        </DHErrorBoundary>
      ) : (
        fallback
      )}
    </div>
  )
}
