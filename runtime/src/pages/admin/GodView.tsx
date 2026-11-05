/**
 * GodView（/admin/god/:factoryId）—— 只读上帝视角（迭代 35 批次B，adminAnalytics.godView）。
 * 企业全景：成员（脱敏）/ 数字员工 / 技能包 / 购买 / 任务（近20）/ 反馈 / 健康分。
 * 铁律：本页只读 —— 不得出现任何写操作按钮；调用 godView 本身由后端自动留痕，
 * 顶部显著横幅「只读视图 · 访问已留痕」。
 */
import { useParams } from 'react-router'
import {
  Building2,
  Cpu,
  Eye,
  HeartPulse,
  MessagesSquare,
  Package,
  ScrollText,
  ShieldCheck,
  ShoppingCart,
  Users,
} from 'lucide-react'
import { useWbQuery, useWbSession } from '@/lib/wbSession'
import { WbEmpty, WbError, WbLoading, WbPageHeader, WbPanel } from '@/components/wb/ui'
import { cn } from '@/lib/utils'

// 宽松记录类型：godView 返回结构由契约第3节定义，字段全部防御性双读。
type Row = Record<string, unknown>

interface GodViewResp {
  factory?: Row
  members?: Row[]
  agents?: Row[]
  packs?: Row[]
  purchases?: Row[]
  tasks?: Row[]
  feedbacks?: Row[]
  health?: Row
}

function arr(v: unknown): Row[] {
  return Array.isArray(v) ? (v as Row[]) : []
}
function pick(obj: Row | undefined, ...keys: string[]): unknown {
  if (!obj) return undefined
  for (const k of keys) {
    const v = obj[k]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}
function fmt(v: unknown): string {
  return v ? new Date(String(v)).toLocaleString('zh-CN', { hour12: false }) : '—'
}
function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
function str(v: unknown): string {
  return v === undefined || v === null || v === '' ? '—' : String(v)
}

function SimpleTable({ rows, cols }: { rows: Row[]; cols: { label: string; render: (r: Row) => React.ReactNode }[] }) {
  if (rows.length === 0) return <WbEmpty text="暂无数据" />
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-left text-sm">
        <thead>
          <tr className="border-b border-line-subtle text-xs text-ink-faint">
            {cols.map((c) => (
              <th key={c.label} className="pb-2 pr-3 font-medium last:pr-0">{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={str(pick(r, 'id', 'key')) ?? i} className="border-b border-line-subtle/60 last:border-0">
              {cols.map((c, j) => (
                <td key={c.label} className={cn('py-2.5 pr-3 text-xs text-ink-secondary last:pr-0', j === 0 && 'text-ink-primary')}>
                  {c.render(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Section({ icon: Icon, hud, title, children }: { icon: typeof Users; hud: string; title: string; children: React.ReactNode }) {
  return (
    <WbPanel hud={hud} title={title} actions={<Icon className="h-4 w-4 text-pulse-cyan" />} className="mb-6">
      {children}
    </WbPanel>
  )
}

export default function AdminGodView() {
  const { session } = useWbSession()
  const { factoryId } = useParams<{ factoryId: string }>()
  const fid = Number(factoryId)
  const query = useWbQuery<GodViewResp>('adminAnalytics.godView', session,
    { factoryId: Number.isInteger(fid) ? fid : factoryId },
    { enabled: !!session?.token && !!factoryId })

  const d = query.data
  const factory = d?.factory
  const health = d?.health
  const score = num(pick(health, 'score'))
  const silentLevel = str(pick(health, 'silentLevel', 'silent_level'))
  const healthNote = pick(health, 'note')

  return (
    <div>
      {/* 只读横幅 */}
      <div className="mb-6 flex items-center gap-3 rounded-xl border border-forge-amber/50 bg-forge-amber/[0.1] px-5 py-4">
        <Eye className="h-5 w-5 shrink-0 text-forge-amber" />
        <div>
          <p className="text-sm font-bold text-forge-amber">只读视图 · 访问已留痕</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-secondary">
            本页面为企业全景只读上帝视角，不含任何写操作；每次访问由系统自动写入管理端审计日志（godView / 企业 #{factoryId ?? '—'}）。
          </p>
        </div>
      </div>

      <WbPageHeader
        hud="GOD VIEW"
        title={`企业全景 · ${str(pick(factory, 'name', 'factoryName', 'factory_name'))}`}
        desc={`企业 #${factoryId ?? '—'} 全维度数据快照（成员已脱敏）。`}
      />

      {query.loading && !query.data ? (
        <WbLoading text="企业全景加载中…" />
      ) : query.error ? (
        <WbError message={query.error} />
      ) : d ? (
        <>
          {/* 企业信息 + 健康分 */}
          <div className="mb-6 grid gap-4 lg:grid-cols-2">
            <WbPanel hud="FACTORY" title="企业档案" actions={<Building2 className="h-4 w-4 text-forge-amber" />}>
              <dl className="grid grid-cols-2 gap-3 text-xs">
                <div><dt className="text-ink-faint">企业 ID</dt><dd className="mt-0.5 font-mono text-ink-primary">{str(pick(factory, 'id', 'factoryId', 'factory_id'))}</dd></div>
                <div><dt className="text-ink-faint">名称</dt><dd className="mt-0.5 text-ink-primary">{str(pick(factory, 'name'))}</dd></div>
                <div><dt className="text-ink-faint">行业</dt><dd className="mt-0.5 text-ink-primary">{str(pick(factory, 'industry'))}</dd></div>
                <div><dt className="text-ink-faint">状态</dt><dd className="mt-0.5 text-ink-primary">{str(pick(factory, 'status'))}</dd></div>
                <div><dt className="text-ink-faint">创建时间</dt><dd className="mt-0.5 font-mono text-ink-primary">{fmt(pick(factory, 'createdAt', 'created_at'))}</dd></div>
                <div><dt className="text-ink-faint">套餐到期</dt><dd className="mt-0.5 font-mono text-ink-primary">{fmt(pick(factory, 'pkgExpiresAt', 'pkg_expires_at'))}</dd></div>
              </dl>
            </WbPanel>
            <WbPanel hud="HEALTH" title="健康分" actions={<HeartPulse className="h-4 w-4 text-forge-amber" />}>
              <div className="flex items-center gap-5">
                <p className={cn('font-grotesk text-5xl font-bold', score >= 70 ? 'text-jade-green' : score >= 40 ? 'text-forge-amber' : 'text-ember-red')}>
                  {health ? score : '—'}
                </p>
                <div className="text-xs">
                  <p className={cn(
                    'inline-flex rounded-full border px-2 py-0.5 font-mono text-[10px]',
                    silentLevel === 'critical'
                      ? 'border-ember-red/40 bg-ember-red/10 text-ember-red'
                      : silentLevel === 'warn'
                        ? 'border-forge-amber/40 bg-forge-amber/10 text-forge-amber'
                        : 'border-jade-green/40 bg-jade-green/10 text-jade-green',
                  )}>
                    沉默级别 {silentLevel}
                  </p>
                  <p className="mt-2 text-ink-faint">
                    近30天活跃 {num(pick(health, 'activeDays30', 'active_days_30'))} 天 · 任务 {num(pick(health, 'tasks'))} · 反馈 {num(pick(health, 'feedbacks'))}
                  </p>
                  {healthNote != null && <p className="mt-1 text-[11px] text-ink-faint">口径：{String(healthNote)}</p>}
                </div>
              </div>
            </WbPanel>
          </div>

          <Section icon={Users} hud="MEMBERS" title={`成员（脱敏，${arr(d.members).length}）`}>
            <SimpleTable rows={arr(d.members)} cols={[
              { label: '姓名', render: (r) => str(pick(r, 'name', 'displayName', 'display_name')) },
              { label: '角色', render: (r) => str(pick(r, 'role')) },
              { label: '联系方式（脱敏）', render: (r) => <span className="font-mono">{str(pick(r, 'contact', 'phone', 'email'))}</span> },
              { label: '加入时间', render: (r) => <span className="font-mono">{fmt(pick(r, 'createdAt', 'created_at', 'joinedAt', 'joined_at'))}</span> },
            ]} />
          </Section>

          <Section icon={Cpu} hud="AGENTS" title={`数字员工（${arr(d.agents).length}）`}>
            <SimpleTable rows={arr(d.agents)} cols={[
              { label: '名称', render: (r) => str(pick(r, 'name', 'title')) },
              { label: '状态', render: (r) => str(pick(r, 'status')) },
              { label: '模型', render: (r) => <span className="font-mono">{str(pick(r, 'model'))}</span> },
              { label: '创建时间', render: (r) => <span className="font-mono">{fmt(pick(r, 'createdAt', 'created_at'))}</span> },
            ]} />
          </Section>

          <Section icon={Package} hud="PACKS" title={`技能包（${arr(d.packs).length}）`}>
            <SimpleTable rows={arr(d.packs)} cols={[
              { label: '技能包', render: (r) => str(pick(r, 'name', 'packKey', 'pack_key', 'title')) },
              { label: '版本', render: (r) => <span className="font-mono">{str(pick(r, 'version'))}</span> },
              { label: '状态', render: (r) => str(pick(r, 'status')) },
              { label: '安装时间', render: (r) => <span className="font-mono">{fmt(pick(r, 'installedAt', 'installed_at', 'createdAt', 'created_at'))}</span> },
            ]} />
          </Section>

          <Section icon={ShoppingCart} hud="PURCHASES" title={`购买记录（${arr(d.purchases).length}）`}>
            <SimpleTable rows={arr(d.purchases)} cols={[
              { label: '商品', render: (r) => str(pick(r, 'itemName', 'item_name', 'title', 'packKey', 'pack_key')) },
              { label: '金额', render: (r) => <span className="font-mono">{str(pick(r, 'amount', 'price', 'tokens'))}</span> },
              { label: '状态', render: (r) => str(pick(r, 'status')) },
              { label: '时间', render: (r) => <span className="font-mono">{fmt(pick(r, 'createdAt', 'created_at', 'paidAt', 'paid_at'))}</span> },
            ]} />
          </Section>

          <Section icon={ScrollText} hud="TASKS" title={`任务（近 20 条，${arr(d.tasks).length}）`}>
            <SimpleTable rows={arr(d.tasks).slice(0, 20)} cols={[
              { label: '任务', render: (r) => <span className="line-clamp-1 max-w-[260px]">{str(pick(r, 'title', 'content', 'summary'))}</span> },
              { label: '状态', render: (r) => str(pick(r, 'status')) },
              { label: '发起人', render: (r) => str(pick(r, 'actor', 'creator', 'username')) },
              { label: '时间', render: (r) => <span className="font-mono">{fmt(pick(r, 'createdAt', 'created_at'))}</span> },
            ]} />
          </Section>

          <Section icon={MessagesSquare} hud="FEEDBACKS" title={`技能反馈（${arr(d.feedbacks).length}）`}>
            <SimpleTable rows={arr(d.feedbacks)} cols={[
              { label: '反馈内容', render: (r) => <span className="line-clamp-2 max-w-[320px]">{str(pick(r, 'content', 'message', 'detail'))}</span> },
              { label: '评分', render: (r) => <span className="font-mono">{str(pick(r, 'rating', 'score'))}</span> },
              { label: '处理状态', render: (r) => str(pick(r, 'handled', 'status')) },
              { label: '时间', render: (r) => <span className="font-mono">{fmt(pick(r, 'createdAt', 'created_at'))}</span> },
            ]} />
          </Section>

          <p className="flex items-center gap-1.5 pb-2 text-[11px] text-ink-faint">
            <ShieldCheck className="h-3.5 w-3.5 text-jade-green" />
            本页所有数据只读；如需运营动作请前往「客服工单」或「企业健康」。
          </p>
        </>
      ) : (
        <WbEmpty text="未获取到企业数据" />
      )}
    </div>
  )
}
