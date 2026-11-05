/**
 * voiceAttachment —— M20 波 3：语音技能产出物附件纯逻辑（vitest 直测）。
 *
 * 后端契约（api/routers/voiceSkills.ts VoiceSkillAttachment，逐项对齐）：
 *   attachment?: { kind: 'file' | 'text'; url?: string; preview: string }
 * - kind='file'：url 为 /files/ 相对链接（链接即凭证，24h 过期），preview 为产出物标题；
 * - kind='text'：无 url，preview 为 ≤200 字文本预览。
 * 后端无 name 字段——展示名从 preview/url 推导。
 *
 * 安全红线：attachment.url 是不可信输入，下载链接严禁字符串裸拼信任后端字段，
 * 一律过 safeVoiceFileUrl 白名单（仅放行 /files/ 前缀站内相对路径），其余一律 null。
 */

export interface VoiceSkillAttachment {
  kind: 'file' | 'text'
  url?: string
  preview: string
}

/** 合法投递文件名（与后端 deliverArtifactFile 口径对齐：随机 hex + 扩展名） */
const FILES_PATH_RE = /^\/files\/[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * /files/ 前缀白名单校验：合法站内相对路径原样返回（工作台与后端同源，直接作 href）；
 * 绝对 URL、协议相对、目录穿越、空值、非字符串一律 null。
 */
export function safeVoiceFileUrl(url: string | undefined | null): string | null {
  if (!url || typeof url !== 'string') return null
  return FILES_PATH_RE.test(url) ? url : null
}

/**
 * 归一化后端原始 attachment 字段：结构非法 / kind 未知 / file 类 url 不过白名单 → null
 * （附件整体丢弃，回复文本仍在气泡中；绝不渲染不可信链接）。
 */
export function normalizeVoiceAttachment(raw: unknown): VoiceSkillAttachment | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.kind !== 'file' && o.kind !== 'text') return null
  const preview = typeof o.preview === 'string' ? o.preview : ''
  const url = typeof o.url === 'string' ? o.url : undefined
  if (o.kind === 'file') {
    const safe = safeVoiceFileUrl(url)
    if (!safe) return null
    return { kind: 'file', url: safe, preview }
  }
  return { kind: 'text', preview }
}

/**
 * 附件展示名（📎 后的标题）：preview 非空优先（文件类即产出物标题，截 40 字）；
 * 文件类 preview 缺失回退 url 文件名；都缺兜底「技能产出物」。
 */
export function voiceAttachmentName(att: VoiceSkillAttachment): string {
  const preview = (att.preview ?? '').trim()
  if (preview) return preview.length > 40 ? `${preview.slice(0, 40)}…` : preview
  const safe = safeVoiceFileUrl(att.url)
  if (att.kind === 'file' && safe) return safe.slice('/files/'.length)
  return '技能产出物'
}
