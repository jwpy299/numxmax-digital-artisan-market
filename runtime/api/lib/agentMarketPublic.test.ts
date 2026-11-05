import { describe, expect, it } from 'vitest'
import { normalizePublicDisplayName } from './agentMarketPublic'

describe('公开 Feed 展示名规范', () => {
  it('NFC、trim 和空白折叠后接受合法企业别名', () => {
    expect(normalizePublicDisplayName('  公开   展示企业  ')).toBe('公开 展示企业')
    expect(normalizePublicDisplayName('ＡＢ团队')).toBe('ＡＢ团队')
  })
  it('纯符号、手机号、邮箱、证件号、官方冒用全部拒绝', () => {
    for (const value of ['!!!', '联系 13800138000', 'a@example.com', '110101199003077777', 'NumX Max 官方', '灵枢·星云']) expect(() => normalizePublicDisplayName(value)).toThrow()
  })
})
