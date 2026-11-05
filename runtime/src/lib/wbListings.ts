/**
 * 工作台上架记录（本机 registry）。
 *
 * 背景：服务端 workbenchMarket 路由只提供「提交 / 审核 / 招募」等动作接口，
 * 未提供上架条目的列表查询 procedure。为让市场/技能商城/展厅页面能呈现
 * 真实的上架结果，本模块把每次 publish/certify/hire 的真实响应
 * （listingId、status、hires）按企业（factoryId）记录在本机 localStorage。
 * 记录随真实服务端动作响应更新，不伪造任何条目。
 */
import { useCallback, useEffect, useState } from 'react'
import { loadWbSession, wbQuery } from '@/lib/wbSession'

export interface WbListingRecord {
  listingId: number
  type: 'skill' | 'agent'
  title: string
  category?: string
  capabilities?: string[]
  price?: number
  pricingModel?: string
  status: 'pending' | 'listed' | 'rejected'
  hires: number
  updatedAt: number
}

const keyOf = (factoryId: number | string | undefined) => `wb_listings_${factoryId ?? 'anon'}`
const CHANGE_EVENT = 'wb-listings-changed'

export function loadListingRecords(factoryId: number | string | undefined): WbListingRecord[] {
  try {
    const raw = localStorage.getItem(keyOf(factoryId))
    if (!raw) return []
    const parsed = JSON.parse(raw) as WbListingRecord[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveListingRecords(factoryId: number | string | undefined, rows: WbListingRecord[]) {
  localStorage.setItem(keyOf(factoryId), JSON.stringify(rows))
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

/** 新增 / 更新一条上架记录（以真实服务端响应为准） */
export function upsertListingRecord(
  factoryId: number | string | undefined,
  patch: Partial<WbListingRecord> & { listingId: number },
): void {
  const rows = loadListingRecords(factoryId)
  const idx = rows.findIndex((r) => r.listingId === patch.listingId)
  const next: WbListingRecord = {
    type: 'agent',
    title: '',
    status: 'pending',
    hires: 0,
    updatedAt: Date.now(),
    ...(idx >= 0 ? rows[idx] : {}),
    ...patch,
  }
  if (idx >= 0) rows[idx] = next
  else rows.unshift(next)
  saveListingRecords(factoryId, rows)
}

/** 服务端 listListings 行 → 本地记录形状 */
interface ServerListingRow {
  id: number
  type: 'skill' | 'agent'
  title: string
  category?: string | null
  capabilities?: unknown
  price?: number | null
  pricingModel?: string | null
  status: 'pending' | 'listed' | 'rejected'
  hires: number
}

function rowToRecord(r: ServerListingRow): WbListingRecord {
  return {
    listingId: r.id,
    type: r.type,
    title: r.title,
    category: r.category ?? undefined,
    capabilities: Array.isArray(r.capabilities) ? (r.capabilities as string[]) : undefined,
    price: r.price ?? undefined,
    pricingModel: r.pricingModel ?? undefined,
    status: r.status,
    hires: r.hires,
    updatedAt: Date.now(),
  }
}

/** 读取并监听本企业的上架记录（服务端为准，本机 registry 兜底合并） */
export function useListingRecords(factoryId: number | string | undefined) {
  const [records, setRecords] = useState<WbListingRecord[]>(() => loadListingRecords(factoryId))

  useEffect(() => {
    const sync = () => setRecords(loadListingRecords(factoryId))
    sync()
    window.addEventListener(CHANGE_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [factoryId])

  // 服务端真实数据合并（workbenchMarket.listListings，补充于文档之外的查询）
  useEffect(() => {
    const token = loadWbSession()?.token
    if (!token || factoryId == null) return
    let alive = true
    wbQuery<{ mine: ServerListingRow[]; listed: ServerListingRow[] }>(
      'workbenchMarket.listListings',
      { token },
    )
      .then((res) => {
        if (!alive) return
        const serverRows = [...res.mine, ...res.listed.filter((l) => !res.mine.some((m) => m.id === l.id))]
        if (serverRows.length === 0) return
        const local = loadListingRecords(factoryId)
        const merged = new Map<number, WbListingRecord>()
        for (const r of local) merged.set(r.listingId, r)
        for (const r of serverRows.map(rowToRecord)) merged.set(r.listingId, r) // 服务端覆盖
        setRecords([...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt))
      })
      .catch(() => { /* 服务端不可达时保持本机记录 */ })
    return () => { alive = false }
  }, [factoryId])

  const upsert = useCallback(
    (patch: Partial<WbListingRecord> & { listingId: number }) => upsertListingRecord(factoryId, patch),
    [factoryId],
  )
  return { records, upsert }
}
