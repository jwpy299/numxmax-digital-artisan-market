/**
 * Factories（/admin/factories）—— 企业管理：列表（行业大类 / 部门 / 旗下用户数）+ 禁用。
 */
import { useState } from 'react'
import { useWbSession, useWbQuery, wbMutation, wbErrorMessage } from '@/lib/wbSession'
import {
  WbBadge,
  WbButton,
  WbEmpty,
  WbError,
  WbLoading,
  WbNotice,
  WbPageHeader,
  WbPanel,
  wbInputCls,
} from '@/components/wb/ui'
import { adminConfirm, AdminPager, AdminTable, adminTdCls, fmtTime } from './shared'

interface FactoryRow {
  id: number
  enterpriseName: string
  industry: string
  industryGroup: string
  industryText: string | null
  headcount: string
  departments: { id: string; name: string; headcount?: string; duty?: string }[]
  creditCode: string | null
  verifyStatus: 'unverified' | 'verified' | 'pending_manual' | 'mismatch' | null
  verifiedAt: string | null
  createdAt: string
  userCount: number
  disabled: number
}

const VERIFY_BADGE: Record<string, { status: string; label: string }> = {
  verified: { status: 'active', label: '已核验·国家信用网' },
  pending_manual: { status: 'pending', label: '待人工核验' },
  mismatch: { status: 'rejected', label: '不符' },
  unverified: { status: 'expired', label: '未核验' },
}

function VerifyBadge({ value }: { value: string | null }) {
  const conf = VERIFY_BADGE[value ?? 'unverified'] ?? VERIFY_BADGE.unverified
  return <WbBadge status={conf.status} label={conf.label} />
}

interface ListResp {
  total: number
  page: number
  pageSize: number
  items: FactoryRow[]
}

export default function AdminFactories() {
  const { session } = useWbSession()
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [keyword, setKeyword] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const { data, error, loading, refetch } = useWbQuery<ListResp>('admin.factoriesList', session, {
    page,
    pageSize: 20,
    search: keyword || undefined,
  })

  function toggleDisabled(f: FactoryRow) {
    const enabling = f.disabled === 1
    const action = enabling
      ? `恢复企业「${f.enterpriseName}」`
      : `禁用企业「${f.enterpriseName}」（旗下 ${f.userCount} 个账号的现有会话将失效）`
    if (!adminConfirm(action)) return
    setNotice(null)
    setActionError(null)
    setPending(true)
    wbMutation('admin.factorySetDisabled', { token: session!.token, factoryId: f.id, disabled: !enabling })
      .then(() => {
        setNotice(`已提交「${enabling ? '恢复' : '禁用'}企业」，由系统执行，页面刷新后生效。`)
        refetch()
      })
      .catch((err) => setActionError(wbErrorMessage(err)))
      .finally(() => setPending(false))
  }

  function manualVerify(f: FactoryRow, action: 'approve' | 'reject') {
    const actionText = action === 'approve' ? '通过核验' : '驳回'
    if (!adminConfirm(`${actionText}企业「${f.enterpriseName}」的信用代码核验`)) return
    setNotice(null)
    setActionError(null)
    setPending(true)
    wbMutation('admin.adminVerifyFactory', { token: session!.token, factoryId: f.id, action })
      .then(() => {
        setNotice(`已${actionText}「${f.enterpriseName}」。`)
        refetch()
      })
      .catch((err) => setActionError(wbErrorMessage(err)))
      .finally(() => setPending(false))
  }

  return (
    <div>
      <WbPageHeader hud="FACTORIES" title="企业管理" desc="工作台企业（工厂画像）：行业大类、部门组织与旗下账号数。" />
      <WbPanel
        title="企业列表"
        hud="FACTORY LIST"
        actions={
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              setPage(1)
              setKeyword(search.trim())
            }}
          >
            <input
              className={wbInputCls + ' w-56'}
              placeholder="搜索企业名 / 行业"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <WbButton variant="secondary" type="submit">搜索</WbButton>
          </form>
        }
      >
        <WbNotice message={notice} className="mb-3" />
        <WbError message={actionError ?? error} className="mb-3" />
        {loading && <WbLoading />}
        {!loading && data && data.items.length === 0 && <WbEmpty text="暂无匹配的企业" />}
        {!loading && data && data.items.length > 0 && (
          <>
            <AdminTable head={['ID', '企业名称', '行业大类', '规模', '部门', '旗下账号', '核验', '状态', '注册时间', '操作']}>
              {data.items.map((f) => (
                <tr key={f.id}>
                  <td className={adminTdCls + ' font-mono'}>{f.id}</td>
                  <td className={adminTdCls}>
                    <p className="text-ink-primary">{f.enterpriseName}</p>
                    {f.creditCode && <p className="text-xs text-ink-faint">{f.creditCode}</p>}
                  </td>
                  <td className={adminTdCls}>
                    <p>{f.industryGroup}</p>
                    <p className="text-xs text-ink-faint">{f.industryText ?? f.industry}</p>
                  </td>
                  <td className={adminTdCls}>{f.headcount}</td>
                  <td className={adminTdCls}>
                    <div className="flex max-w-56 flex-wrap gap-1">
                      {(f.departments ?? []).slice(0, 4).map((d) => (
                        <span key={d.id} className="rounded-full border border-line-subtle px-2 py-0.5 text-[11px] text-ink-secondary">
                          {d.name}
                        </span>
                      ))}
                      {(f.departments ?? []).length > 4 && (
                        <span className="text-[11px] text-ink-faint">+{f.departments.length - 4}</span>
                      )}
                    </div>
                  </td>
                  <td className={adminTdCls + ' font-mono'}>{f.userCount}</td>
                  <td className={adminTdCls}>
                    <VerifyBadge value={f.verifyStatus} />
                  </td>
                  <td className={adminTdCls}>
                    {f.disabled === 1 ? <WbBadge status="rejected" label="已禁用" /> : <WbBadge status="active" label="正常" />}
                  </td>
                  <td className={adminTdCls + ' text-xs'}>{fmtTime(f.createdAt)}</td>
                  <td className={adminTdCls}>
                    <div className="flex flex-wrap gap-2">
                      {f.verifyStatus === 'pending_manual' && (
                        <>
                          <WbButton variant="secondary" disabled={pending} onClick={() => manualVerify(f, 'approve')}>
                            通过核验
                          </WbButton>
                          <WbButton variant="danger" disabled={pending} onClick={() => manualVerify(f, 'reject')}>
                            驳回
                          </WbButton>
                        </>
                      )}
                      <WbButton
                        variant={f.disabled === 1 ? 'secondary' : 'danger'}
                        disabled={pending}
                        onClick={() => toggleDisabled(f)}
                      >
                        {f.disabled === 1 ? '恢复' : '禁用'}
                      </WbButton>
                    </div>
                  </td>
                </tr>
              ))}
            </AdminTable>
            <AdminPager page={page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
          </>
        )}
      </WbPanel>
    </div>
  )
}
