import { describe, expect, it } from 'vitest'
import { normalizePublicDisplayName, publicDisplayNameError } from './publicDisplayName'

describe('首页公开展示名校验', () => {
  it('合法别名经过 NFC/trim/空白折叠', () => {
    expect(normalizePublicDisplayName('  公开   展示企业  ')).toBe('公开 展示企业')
    expect(publicDisplayNameError('公开展示企业')).toBeNull()
  })
  it('手机号、邮箱、证件、纯符号和官方冒用给 inline 错误', () => {
    for (const value of ['13800138000', 'a@example.com', '110101199003077777', '!!!', 'NumX Max 官方', 'Nebula!', 'numx-max', '灵枢 · 星云', 'SCNET.', 'NumX Max·数字匠市', '数字匠市', '数字匠市商城', 'Numx Max 团队', 'numx-max.com', 'scnet-cloud']) expect(publicDisplayNameError(value)).not.toBeNull()
  })

  it('身份证 X/x 结尾、全角 X 与分隔写法同样拒绝', () => {
    for (const value of ['11010519491231002X', '11010519491231002x', '11010519491231002Ｘ', '110105 1949 1231 002X']) {
      expect(() => normalizePublicDisplayName(value)).toThrow('公开展示名不得包含手机号、邮箱或证件号码')
    }
  })

  it('Unicode 默认不可见字符不得绕过保留名或长度校验', () => {
    for (const value of ['灵\u00AD枢', 'NE\u00ADBULA', '灵\u061C枢', '灵\u2064枢', '灵\u206F枢', '灵\uFE0F枢', '灵\u{E0000}枢']) {
      expect(publicDisplayNameError(value)).not.toBeNull()
    }
    expect(normalizePublicDisplayName('公\u2064开展示企业')).toBe('公开展示企业')
    for (const value of ['\u00AD', '\u2064', '\uFE0F']) expect(publicDisplayNameError(value)).not.toBeNull()
  })

})
