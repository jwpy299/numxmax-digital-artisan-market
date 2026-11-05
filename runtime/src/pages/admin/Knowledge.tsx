/**
 * Knowledge（/admin/knowledge）—— 灵智枢智能运营 · 企业知识库。
 *
 * 分区一「上传文档」：文件选择（accept .txt,.md,.markdown,.pdf,.docx,.doc）+ 标题输入
 *   + 上传按钮（FileReader 转 base64 → kb.upload，限 2MB）；
 * 分区二「文档列表」：kb.list（标题/文件/大小/状态/解析字数/上传人/时间/删除按钮二次确认）。
 *
 * 口径：知识库内容将作为智能客服与驻部智能体回答时的企业资料；可解析格式：txt/md。
 * 数据：kb.upload / kb.list / kb.remove（token 仅在请求体）。
 */
import { useRef, useState } from 'react'
import { FileText, Trash2, Upload } from 'lucide-react'
import { useWbSession, useWbQuery, wbMutation, wbErrorMessage } from '@/lib/wbSession'
import {
  WbButton,
  WbEmpty,
  WbError,
  WbLoading,
  WbNotice,
  WbPageHeader,
  WbPanel,
  wbInputCls,
  wbLabelCls,
} from '@/components/wb/ui'
import { AdminTable, adminTdCls, adminConfirm, fmtTime } from './shared'
import { cn } from '@/lib/utils'

interface KbDocItem {
  id: number
  title: string
  fileName: string
  sizeBytes: number
  status: string
  failReason: string | null
  parsedChars: number
  excerpt: string
  uploadedBy: string
  createdAt: unknown
}

const ACCEPT = '.txt,.md,.markdown,.pdf,.docx,.doc'
const MAX_FILE_BYTES = 2 * 1024 * 1024

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

export default function AdminKnowledge() {
  const { session } = useWbSession()
  const listQuery = useWbQuery<{ items: KbDocItem[] }>('kb.list', session)

  const fileRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  function handlePick(f: File | null) {
    setUploadError(null)
    if (f && f.size > MAX_FILE_BYTES) {
      setFile(null)
      if (fileRef.current) fileRef.current.value = ''
      setUploadError('文件超过 2MB 上限，请压缩或拆分后再上传')
      return
    }
    setFile(f)
  }

  async function handleUpload() {
    if (!session?.token || !file) return
    setUploadError(null)
    setNotice(null)
    setUploading(true)
    try {
      const fileBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          const result = String(reader.result ?? '')
          resolve(result.includes(',') ? result.slice(result.indexOf(',') + 1) : result)
        }
        reader.onerror = () => reject(new Error('文件读取失败，请重试'))
        reader.readAsDataURL(file)
      })
      const res = await wbMutation<{ archivedOnly: boolean }>('kb.upload', {
        token: session.token,
        title: title.trim(),
        fileName: file.name,
        fileBase64,
      })
      setNotice(
        res.archivedOnly
          ? `已上传「${file.name}」：该格式已存档，暂不参与智能问答解析。`
          : `已上传「${file.name}」，文本已解析并纳入知识库。`,
      )
      setFile(null)
      setTitle('')
      if (fileRef.current) fileRef.current.value = ''
      listQuery.refetch()
    } catch (err) {
      setUploadError(wbErrorMessage(err))
    } finally {
      setUploading(false)
    }
  }

  async function handleRemove(doc: KbDocItem) {
    if (!session?.token) return
    if (!adminConfirm(`删除知识库文档「${doc.title}」（删除后不可恢复）`)) return
    setNotice(null)
    try {
      await wbMutation('kb.remove', { token: session.token, id: doc.id })
      setNotice(`已删除文档「${doc.title}」。`)
      listQuery.refetch()
    } catch (err) {
      window.alert(wbErrorMessage(err))
    }
  }

  return (
    <div>
      <WbPageHeader
        hud="LINGZHISHU OPS · KNOWLEDGE BASE"
        title="企业知识库"
        desc="知识库内容将作为智能客服与驻部智能体回答时的企业资料；可解析格式：txt/md（pdf/docx/doc 仅存档，暂不参与解析），单文件上限 2MB。"
      />

      {/* 分区一：上传文档 */}
      <WbPanel title="上传文档" hud="UPLOAD DOCUMENT">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr_auto]">
          <div>
            <label className={wbLabelCls}>选择文件</label>
            <input
              ref={fileRef}
              type="file"
              accept={ACCEPT}
              className={cn(wbInputCls, 'cursor-pointer file:mr-3 file:rounded file:border-0 file:bg-forge-amber/15 file:px-3 file:py-1 file:text-xs file:text-forge-amber')}
              onChange={(e) => handlePick(e.target.files?.[0] ?? null)}
            />
            <p className="mt-1 text-[11px] text-ink-faint">支持 {ACCEPT} · 单文件 ≤ 2MB</p>
          </div>
          <div>
            <label className={wbLabelCls}>标题（留空用文件名）</label>
            <input
              className={wbInputCls}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例如：公司产品介绍"
              maxLength={200}
            />
          </div>
          <div className="flex items-end">
            <WbButton onClick={() => void handleUpload()} loading={uploading} disabled={!file}>
              <Upload className="h-4 w-4" />
              上传
            </WbButton>
          </div>
        </div>
        <WbError message={uploadError} className="mt-3" />
        <WbNotice message={notice} className="mt-3" />
      </WbPanel>

      {/* 分区二：文档列表 */}
      <WbPanel title="知识库文档" hud="KB DOCUMENTS" className="mt-6">
        {listQuery.loading && <WbLoading />}
        <WbError message={listQuery.error} />
        {listQuery.data && listQuery.data.items.length === 0 && (
          <WbEmpty text="知识库暂无文档" hint="使用上方表单上传 txt/md 等企业资料。" />
        )}
        {listQuery.data && listQuery.data.items.length > 0 && (
          <AdminTable head={['标题', '文件', '大小', '状态', '解析字数', '上传人', '时间', '操作']}>
            {listQuery.data.items.map((d) => (
              <tr key={d.id}>
                <td className={adminTdCls + ' text-ink-primary'}>
                  <span className="inline-flex items-center gap-1.5">
                    <FileText className="h-3.5 w-3.5 text-forge-amber/80" />
                    {d.title}
                  </span>
                  {d.excerpt && (
                    <p className="mt-1 max-w-[280px] truncate text-[11px] text-ink-faint">{d.excerpt}</p>
                  )}
                </td>
                <td className={adminTdCls}>{d.fileName}</td>
                <td className={adminTdCls}>{fmtSize(d.sizeBytes)}</td>
                <td className={adminTdCls}>
                  <span
                    className={cn(
                      'inline-flex rounded-full border px-2 py-0.5 text-[11px]',
                      d.status === 'ready'
                        ? 'border-pulse-cyan/40 bg-pulse-cyan/10 text-pulse-cyan'
                        : 'border-ember-red/40 bg-ember-red/10 text-ember-red',
                    )}
                  >
                    {d.status === 'ready' ? '就绪' : '失败'}
                  </span>
                  {d.failReason && <p className="mt-1 max-w-[220px] text-[11px] text-ink-faint">{d.failReason}</p>}
                </td>
                <td className={adminTdCls}>{d.parsedChars > 0 ? `${d.parsedChars} 字` : '—'}</td>
                <td className={adminTdCls}>{d.uploadedBy}</td>
                <td className={adminTdCls}>{fmtTime(d.createdAt)}</td>
                <td className={adminTdCls}>
                  <WbButton variant="danger" className="px-2.5 py-1 text-xs" onClick={() => void handleRemove(d)}>
                    <Trash2 className="h-3.5 w-3.5" />
                    删除
                  </WbButton>
                </td>
              </tr>
            ))}
          </AdminTable>
        )}
      </WbPanel>
    </div>
  )
}
