/**
 * ScreenScale —— 大屏分辨率自适应（#17 技术债，彭总令 2026-09-02）
 * 以 1920×1080 为设计基准：4K 自动放大、1366 笔记本缩小、竖屏/异形屏留边不拉伸、
 * 拼接屏每块 1080p 各自正常。transform: scale 等比缩放，绝无内容溢出黑屏（小米电视黑屏病根）。
 */
import { useEffect, useState, type ReactNode } from 'react'

const DESIGN_W = 1920
const DESIGN_H = 1080

export default function ScreenScale({ children, designW = DESIGN_W, designH = DESIGN_H }: {
  children: ReactNode
  designW?: number
  designH?: number
}) {
  const [scale, setScale] = useState(1)
  useEffect(() => {
    const update = () => {
      const vw = window.innerWidth
      const vh = window.innerHeight
      // 等比取小：竖屏/异形屏自动留边（上下黑边居中，不裁切不拉伸）
      setScale(Math.min(vw / designW, vh / designH))
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [designW, designH])

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#0b0f1a] flex items-center justify-center">
      <div
        style={{
          width: designW,
          height: designH,
          transform: `scale(${scale})`,
          transformOrigin: 'center center',
          flexShrink: 0,
        }}
      >
        {children}
      </div>
    </div>
  )
}
