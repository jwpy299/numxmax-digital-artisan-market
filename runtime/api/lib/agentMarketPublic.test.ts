import { describe, expect, it } from 'vitest'
import { normalizePublicDisplayName } from './agentMarketPublic'

describe('公开 Feed 展示名规范', () => {
  it('NFC、trim 和空白折叠后接受合法企业别名', () => {
    expect(normalizePublicDisplayName('  公开   展示企业  ')).toBe('公开 展示企业')
    expect(normalizePublicDisplayName('ＡＢ团队')).toBe('AB团队')
  })
  it('纯符号、手机号、邮箱、证件号、官方冒用全部拒绝', () => {
    for (const value of ['!!!', '联系 13800138000', 'a@example.com', '110101199003077777', 'NumX Max 官方', '灵枢·星云', '１３８００１３８０００', '138 0013 8000', '138-0013-8000', '灵\u200B枢', 'ＮＥＢＵＬＡ', 'Numx Max.', 'numx-max', 'Nebula‑Harness', 'SCNET.', 'NumX Max·数字匠市', '数字匠市']) expect(() => normalizePublicDisplayName(value)).toThrow()
  })

  it('身份证 X/x 结尾、全角 X 与分隔写法同样拒绝', () => {
    for (const value of ['11010519491231002X', '11010519491231002x', '11010519491231002Ｘ', '110105 1949 1231 002X']) {
      expect(() => normalizePublicDisplayName(value)).toThrow('公开展示名不得包含手机号、邮箱或证件号码')
    }
  })

})
