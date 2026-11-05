import { describe, expect, it } from 'vitest'
import { normalizePublicDisplayName, publicDisplayNameError } from './publicDisplayName'

describe('首页公开展示名校验', () => {
  it('合法别名经过 NFC/trim/空白折叠', () => {
    expect(normalizePublicDisplayName('  公开   展示企业  ')).toBe('公开 展示企业')
    expect(publicDisplayNameError('公开展示企业')).toBeNull()
  })
  it('手机号、邮箱、证件、纯符号和官方冒用给 inline 错误', () => {
    for (const value of ['13800138000', 'a@example.com', '110101199003077777', '!!!', 'NumX Max 官方']) expect(publicDisplayNameError(value)).not.toBeNull()
  })
})
