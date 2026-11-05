/**
 * M20 波 3：语音技能产出物附件纯逻辑用例（vitest）。
 * 红线：下载链接必须过 /files/ 白名单，后端字段绝不裸拼信任。
 */
import { describe, expect, it } from 'vitest'
import {
  normalizeVoiceAttachment,
  safeVoiceFileUrl,
  voiceAttachmentName,
} from './voiceAttachment'

describe('safeVoiceFileUrl（/files/ 前缀白名单）', () => {
  it('合法 /files/ 相对路径原样放行（同源直接作 href）', () => {
    expect(safeVoiceFileUrl('/files/a1b2c3d4e5f6.pptx')).toBe('/files/a1b2c3d4e5f6.pptx')
  })

  it('绝对 URL / 协议相对 / javascript: 一律 null（防任意链接）', () => {
    expect(safeVoiceFileUrl('https://evil.com/files/x.pptx')).toBeNull()
    expect(safeVoiceFileUrl('//evil.com/files/x.pptx')).toBeNull()
    expect(safeVoiceFileUrl('javascript:alert(1)')).toBeNull()
  })

  it('目录穿越 / 非 /files/ 前缀 / 空值一律 null', () => {
    expect(safeVoiceFileUrl('/files/../secret')).toBeNull()
    expect(safeVoiceFileUrl('/api/files/x.pptx')).toBeNull()
    expect(safeVoiceFileUrl('/files/')).toBeNull()
    expect(safeVoiceFileUrl('')).toBeNull()
    expect(safeVoiceFileUrl(undefined)).toBeNull()
    expect(safeVoiceFileUrl(null)).toBeNull()
  })
})

describe('normalizeVoiceAttachment（后端原始字段归一化）', () => {
  it('file 类合法字段透传（url 已过白名单）', () => {
    expect(
      normalizeVoiceAttachment({ kind: 'file', url: '/files/f0f0.xlsx', preview: '台账报表' }),
    ).toEqual({ kind: 'file', url: '/files/f0f0.xlsx', preview: '台账报表' })
  })

  it('text 类只留 preview', () => {
    expect(normalizeVoiceAttachment({ kind: 'text', preview: '一段摘要' })).toEqual({
      kind: 'text',
      preview: '一段摘要',
    })
  })

  it('file 类 url 非法 / kind 未知 / 非对象 → 整体 null（绝不渲染不可信链接）', () => {
    expect(normalizeVoiceAttachment({ kind: 'file', url: 'https://evil.com/x.pptx', preview: 'x' })).toBeNull()
    expect(normalizeVoiceAttachment({ kind: 'file', preview: 'x' })).toBeNull()
    expect(normalizeVoiceAttachment({ kind: 'image', url: '/files/a.png', preview: 'x' })).toBeNull()
    expect(normalizeVoiceAttachment(undefined)).toBeNull()
    expect(normalizeVoiceAttachment('x')).toBeNull()
  })
})

describe('voiceAttachmentName', () => {
  it('preview 优先；超 40 字截断', () => {
    expect(voiceAttachmentName({ kind: 'file', url: '/files/a.pptx', preview: '车间周报 PPT' })).toBe('车间周报 PPT')
    const long = '长'.repeat(50)
    expect(voiceAttachmentName({ kind: 'text', preview: long })).toBe(`${'长'.repeat(40)}…`)
  })

  it('preview 缺失回退文件名；全缺兜底「技能产出物」', () => {
    expect(voiceAttachmentName({ kind: 'file', url: '/files/abc.docx', preview: '' })).toBe('abc.docx')
    expect(voiceAttachmentName({ kind: 'text', preview: ' ' })).toBe('技能产出物')
  })
})
